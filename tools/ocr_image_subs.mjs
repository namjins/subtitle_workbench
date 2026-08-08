#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgv } from "../lib/cli-args.mjs";
import {
  OUTPUT_REVISION,
  appVersion,
  conversionCacheKey,
  isCachedConversionStale,
  readCachedConversion,
  recogniserVersion,
  writeCachedConversion,
} from "../lib/conversion-cache.mjs";
import { installInstructionsForPlatform } from "../lib/dependency-doctor.mjs";
import { cacheDirectory, hasCommand, imageMagickCommand } from "../lib/platform-paths.mjs";
import { normalizeJobs } from "../lib/cpu-jobs.mjs";
import { createOcrEngine, isMacosVisionAvailable } from "../lib/ocr-tesseract.mjs";
import { srtTime, toSrtDocument } from "../lib/subtitle-core.mjs";
import { dedupeByHash, mapBounded } from "../lib/image-dedupe.mjs";
import { countPgsDisplaySets, extractPgsPreviewImages } from "../lib/pgs-peek.mjs";

const usage = `
Usage:
  tools/ocr_image_subs.mjs sup-to-srt movie.sup --lang eng --out movie.srt [--jobs auto|4]
  tools/ocr_image_subs.mjs subidx-to-srt movie.idx --lang eng --out movie.srt [--jobs auto|4]
  tools/ocr_image_subs.mjs subidx-to-srt movie.idx --ocr-engine external-command --ocr-command ./ocr-sidecar

Requirements:
  ffmpeg, ffprobe, tesseract, magick
`;

const cli = parseArgv(process.argv, {
  valueOptions: new Set([
    "--jobs",
    "--lang",
    "--limit",
    "--ocr-command",
    "--ocr-engine",
    "--out",
    "--text-cleanup",
  ]),
});

function readOption(name, fallback = null) {
  return cli.option(name, fallback);
}


function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`${command} failed: ${error.message}`));
    });
    child.on("close", (status) => {
      if (status === 0) {
        resolvePromise(stdout);
      } else {
        reject(
          new Error(`${command} exited with ${status}\n${stderr ?? ""}`.trim()),
        );
      }
    });
  });
}

async function hashFile(path) {
  return createHash("sha1").update(await readFile(path)).digest("hex");
}

function runCapturingStderr(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}\n${result.stderr ?? ""}`.trim());
  }
  return result.stderr ?? "";
}

// Named for what it tells the user: every missing tool at once, with the
// install commands for this platform, instead of one bare binary name per
// failed attempt.
function checkBinaries(commands) {
  // "magick" is satisfied by either ImageMagick 7's magick or 6's convert.
  const missing = [...new Set(commands)]
    .map((command) => (command === "magick" ? imageMagickCommand() ?? "magick" : command))
    .filter((command) => !hasCommand(command));
  if (!missing.length) return;
  throw new Error(
    [
      `Missing required tools: ${missing.join(", ")}.`,
      "Install them and run `subtitle-workbench doctor` to verify:",
      ...installInstructionsForPlatform().map((line) => `  ${line}`),
    ].join("\n"),
  );
}

async function imageStatsAsync(imagePath) {
  const output = await runAsync(imageMagickCommand() ?? "magick", [
    imagePath,
    "-alpha",
    "off",
    "-format",
    "%[fx:mean] %[fx:standard_deviation]",
    "info:",
  ]);
  const [mean, standardDeviation] = output
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  return {
    mean: Number.isFinite(mean) ? mean : 0,
    standardDeviation: Number.isFinite(standardDeviation) ? standardDeviation : 0,
  };
}

async function prepareSubIdxImage(inputPath, outputPath, stats) {
  const borderColor = stats.mean < 0.5 ? "black" : "white";
  await runAsync(imageMagickCommand() ?? "magick", [
    inputPath,
    "-alpha",
    "off",
    "-trim",
    "+repage",
    "-bordercolor",
    borderColor,
    "-border",
    "24",
    `PNG24:${outputPath}`,
  ]);
}

async function extractSubIdxImages(input, workingDirectory, jobs) {
  // Frames are numbered sequentially and their timestamps come from the
  // showinfo filter, not from the filename.
  //
  // `-frame_pts true` names each file after its PTS, so when a subtitle's clear
  // frame lands on the same timestamp as the next subtitle's show frame,
  // ffmpeg reports "non monotonically increasing dts" and drops one of them
  // entirely. On Office Space that silently lost 6 frames, and those are the
  // cues the benchmark reports as shifted: the text then surfaces against a
  // later timestamp, 0.1s to 2.5s out. Sequential naming keeps every frame, and
  // showinfo reports an exact PTS for each one.
  const ffmpegLog = runCapturingStderr("ffmpeg", [
    "-v",
    "info",
    "-y",
    "-i",
    input,
    "-filter_complex",
    "[0:s:0]scale=iw:ih[s];[s]showinfo[out]",
    "-map",
    "[out]",
    "-fps_mode",
    "passthrough",
    join(workingDirectory, "frame-%06d.png"),
  ]);

  const timestamps = Array.from(ffmpegLog.matchAll(/pts_time:(\d+(?:\.\d+)?)/gu)).map(
    (match) => Number(match[1]),
  );

  const files = (await readdir(workingDirectory))
    .filter((file) => /^frame-\d+\.png$/u.test(file))
    .sort();

  if (files.length !== timestamps.length) {
    throw new Error(
      `ffmpeg wrote ${files.length} frame(s) but reported ${timestamps.length} timestamp(s) for ` +
        `${basename(input)}; refusing to guess which cue each image belongs to.`,
    );
  }

  const frames = files.map((file, index) => ({
    file,
    path: join(workingDirectory, file),
    pts: timestamps[index],
  }));

  // The end of a cue is the next frame at a *strictly later* timestamp. A clear
  // frame can share an identical PTS with the following show frame, and taking
  // the immediate neighbour then produced a zero-length cue.
  const nextLaterPts = new Array(frames.length);
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const following = frames[index + 1];
    if (!following) {
      nextLaterPts[index] = null;
    } else if (following.pts > frames[index].pts) {
      nextLaterPts[index] = following.pts;
    } else {
      nextLaterPts[index] = nextLaterPts[index + 1];
    }
  }

  const prepared = new Array(frames.length);
  let nextFrameIndex = 0;

  async function worker() {
    while (nextFrameIndex < frames.length) {
      const index = nextFrameIndex;
      nextFrameIndex += 1;
      const frame = frames[index];
      const stats = await imageStatsAsync(frame.path);
      if (stats.standardDeviation <= 0.001) continue;

      const outputPath = join(
        workingDirectory,
        `subidx-${String(index + 1).padStart(6, "0")}.png`,
      );
      await prepareSubIdxImage(frame.path, outputPath, stats);
      prepared[index] = {
        path: outputPath,
        pts: frame.pts,
        endPts: nextLaterPts[index] ?? frame.pts + 2.5,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(jobs, frames.length) }, () => worker()),
  );

  // framesWritten distinguishes "ffmpeg read no subtitle data at all" (a
  // damaged or wrong-format container) from "frames were rendered but every one
  // was judged blank" (a rendering failure). The old code reported a literal
  // "1 display set" for subidx, which asserted a count it never measured.
  return { images: prepared.filter(Boolean), framesWritten: frames.length };
}

async function convert(
  input,
  output,
  language,
  keepTemp,
  mode,
  engine,
  quiet,
  jobs,
  limit = null,
) {
  // Not process.cwd(): runs started from a read-only or network volume failed,
  // and successful ones scattered scratch PNGs next to the user's media.
  const scratchRoot = cacheDirectory("scratch");
  await mkdir(scratchRoot, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const workingDirectory = await mkdtemp(join(scratchRoot, "subtitle-ocr-"));

  try {
    let extractedImages;
    let framesWritten;
    if (mode === "sup-to-srt") {
      extractedImages = await extractPgsPreviewImages(input, workingDirectory, Infinity);
      framesWritten = extractedImages.length;
    } else {
      ({ images: extractedImages, framesWritten } = await extractSubIdxImages(
        input,
        workingDirectory,
        jobs,
      ));
    }
    const images = limit === null ? extractedImages : extractedImages.slice(0, limit);

    if (!images.length) {
      // Distinguish "not a subtitle file we can read" from "a subtitle file
      // that genuinely shows nothing". Blank forced/overlay tracks are real —
      // several exist in the fixture corpus, with correctly empty reference
      // SRTs — so failing on them would be wrong.
      if (mode === "sup-to-srt") {
        const displaySets = await countPgsDisplaySets(input);
        if (!displaySets) {
          throw new Error(
            `No subtitle data could be read from ${basename(input)}. ` +
              "The file may be empty, damaged, or not the format this mode expects.",
          );
        }
        await writeFile(output, toSrtDocument(""), "utf8");
        process.stderr.write(
          `Wrote 0 cues to ${output} (${displaySets} display set(s) contained no visible subtitles)\n`,
        );
        return;
      }

      // subidx: no display-set count exists, so use the frame count ffmpeg
      // actually wrote.
      if (!framesWritten) {
        throw new Error(
          `No subtitle data could be read from ${basename(input)}. ` +
            "The file may be empty, damaged, or not the format this mode expects.",
        );
      }
      if (limit === null) {
        // Frames were rendered and every one was judged blank. That is a
        // rendering failure (a palette/ImageMagick regression), not an empty
        // track — writing an empty SRT and exiting 0 here would be the
        // "report success for work that did not happen" bug the project has
        // removed three times. A --limit run is exempt: it may legitimately
        // slice to nothing.
        throw new Error(
          `Extracted ${framesWritten} frame(s) from ${basename(input)} but every one was blank ` +
            "after rendering. This is a rendering failure, not an empty subtitle track.",
        );
      }
      await writeFile(output, toSrtDocument(""), "utf8");
      process.stderr.write(
        `Wrote 0 cues to ${output} (${framesWritten} frame(s), none visible after the --limit slice)\n`,
      );
      return;
    }

    const results = new Array(images.length);
    const ocrByIndex = new Array(images.length);

    // Identical subtitle bitmaps recur within a track — a repeated sound cue,
    // a held caption re-sent as its own display set. Measured at 8.6% of
    // images on a full reference track. Hashing is bounded like every other
    // loop here; the dedup bookkeeping lives in lib/image-dedupe.mjs where the
    // index alignment is unit-tested.
    const hashes = await mapBounded(images, jobs, (image) => hashFile(image.path));
    const { representatives, firstByHash } = dedupeByHash(hashes);

    if (!quiet && representatives.length < images.length) {
      process.stderr.write(
        `Recognising ${representatives.length} distinct image(s) of ${images.length}\n`,
      );
    }

    // A probing engine reads a spread of this track's own frames with two real
    // engines and keeps the healthier one — the track's rendering style, not
    // the flow, decides. See lib/ocr-engine-probe.mjs for the calibration.
    if (typeof engine.selectEngine === "function") {
      const selection = await engine.selectEngine(
        representatives.map((index) => images[index].path),
        { language, jobs },
      );
      engine = selection.engine;
      if (selection.probed) {
        process.stderr.write(
          `Probed ${selection.sampled} frame(s): using ${engine.name} ` +
            `(text health ${selection.defaultScore.toFixed(2)} vs ${selection.challengerScore.toFixed(2)}, ` +
            `default confidence ${selection.defaultConfidence.toFixed(1)})\n`,
        );
      }
    }

    function storeResult(index, ocrResult) {
      const text = ocrResult.text;
      const timing = {
        start: images[index].pts ?? index * 3,
        end:
          images[index].endPts ??
          images[index + 1]?.pts ??
          (images[index].pts ?? index * 3) + 2.5,
      };
      results[index] = text ? { ...timing, text } : null;
    }

    if (typeof engine.recognizeBatch === "function") {
      const chunks = Array.from(
        { length: Math.min(jobs, representatives.length) },
        () => [],
      );
      representatives.forEach((index, position) => {
        chunks[position % chunks.length].push(index);
      });
      await Promise.all(
        chunks.map(async (chunk) => {
          if (!chunk.length) return;
          const ocrResults = await engine.recognizeBatch(
            chunk.map((index) => images[index].path),
            { language },
          );
          ocrResults.forEach((ocrResult, resultIndex) => {
            ocrByIndex[chunk[resultIndex]] = ocrResult;
          });
        }),
      );
    } else {
      let nextPosition = 0;

      async function worker() {
        while (nextPosition < representatives.length) {
          const index = representatives[nextPosition];
          nextPosition += 1;
          ocrByIndex[index] = await engine.recognize(images[index].path, { language });
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(jobs, representatives.length) }, () => worker()),
      );
    }

    // A whole-engine failure — every recognition erroring out — must not be
    // reported as a successful conversion. `blank-result` is excluded: a
    // legitimately blank frame is not a failure. If every representative that
    // ran carries a real engine failure, the recogniser never worked and the
    // run must exit non-zero rather than write whatever empty SRT falls out.
    const isEngineFailure = (warnings) =>
      Array.isArray(warnings) &&
      warnings.some(
        (warning) =>
          warning.startsWith("vision-failed") || warning === "vision-missing-result",
      );
    const engineFailures = representatives.filter((index) =>
      isEngineFailure(ocrByIndex[index]?.warnings),
    );
    for (const index of engineFailures) {
      for (const warning of ocrByIndex[index].warnings) {
        process.stderr.write(`  ${warning}\n`);
      }
    }
    if (representatives.length > 0 && engineFailures.length === representatives.length) {
      throw new Error(
        `Every image failed OCR (${engineFailures.length}/${representatives.length}); ` +
          "the recogniser did not run. See the warnings above.",
      );
    }

    // Fan each recognised result back out to every image with the same bytes.
    images.forEach((image, index) => {
      const ocrResult = ocrByIndex[firstByHash.get(hashes[index])];
      if (!ocrResult) return;
      storeResult(index, ocrResult);
      if (!quiet) {
        process.stderr.write(
          `OCR ${index + 1}/${images.length}: ${ocrResult.text ? "text" : "blank"} (${ocrResult.variant})\n`,
        );
      }
    });

    const cues = results.filter(Boolean);

    const srt = cues
      .map((cue, index) =>
        [
          String(index + 1),
          `${srtTime(cue.start)} --> ${srtTime(cue.end)}`,
          cue.text,
        ].join("\n"),
      )
      .join("\n\n")
      .concat("\n");

    await writeFile(output, toSrtDocument(srt), "utf8");
    process.stderr.write(`Wrote ${cues.length} cues to ${output}\n`);
  } finally {
    if (keepTemp) {
      process.stderr.write(`Kept temporary images in ${workingDirectory}\n`);
    } else {
      await rm(workingDirectory, { force: true, recursive: true });
    }
  }
}

async function main() {
  const mode = cli.command;
  const [inputArg] = cli.positionals;
  if (cli.has("--help")) {
    process.stderr.write(usage);
    return;
  }
  if (!mode || !inputArg) {
    // Exit non-zero: a wrapper that saw 0 here would report a successful
    // conversion that never produced a file.
    process.stderr.write(usage);
    process.exit(1);
  }

  const engine = createOcrEngine(readOption("--ocr-engine", "auto"), {
    mode,
    ocrCommand: readOption("--ocr-command"),
    textCleanup: readOption("--text-cleanup", "generic"),
  });

  const input = resolve(inputArg);
  if (!existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }

  // Every file whose bytes determine the conversion result, for the cache
  // key: VobSub timing and palette live in the .idx, the bitmaps in the .sub.
  const sourcePaths = [input];
  if (mode === "subidx-to-srt") {
    const subPath = join(dirname(input), `${basename(input, extname(input))}.sub`);
    if (!existsSync(subPath)) {
      throw new Error(`Matching .sub file not found: ${subPath}`);
    }
    sourcePaths.push(subPath);
  } else if (mode !== "sup-to-srt") {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const language = readOption("--lang", "eng");
  const output =
    readOption("--out") ??
    join(dirname(input), `${basename(input, extname(input))}.srt`);
  const keepTemp = cli.has("--keep-temp");
  const quiet = cli.has("--quiet");
  const jobs = normalizeJobs(readOption("--jobs", process.env.JOBS ?? "auto"));
  const limitValue = readOption("--limit");
  let limit = null;
  if (limitValue !== null) {
    // Previously `Number(x) || 0`, so `--limit abc` silently converted nothing
    // and still exited 0.
    const parsed = Number(limitValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`--limit must be a non-negative number, got "${limitValue}".`);
    }
    limit = Math.floor(parsed);
  }

  const outputPath = resolve(output);

  // A --limit run is a deliberately partial conversion; it must neither be
  // served from the cache of a full one nor be stored as if it were one.
  const cacheable = limit === null;
  const cacheKey = cacheable
    ? await conversionCacheKey({
        sourcePaths,
        mode,
        language,
        engine: readOption("--ocr-engine", "auto"),
        textCleanup: readOption("--text-cleanup", "generic"),
        ocrCommand: readOption("--ocr-command"),
      })
    : null;

  if (cacheable && !cli.has("--no-cache")) {
    const cached = await readCachedConversion(cacheKey);
    // An entry produced by a different Tesseract, an older output format, or a
    // machine that has since gained Apple Vision is not what a fresh run would
    // give, so it is a miss rather than a hit. Without this, upgrading
    // silently changes nothing for anything already converted.
    if (cached && isCachedConversionStale(cached, recogniserVersion(), isMacosVisionAvailable())) {
      process.stderr.write(
        `Ignoring cached conversion from app version ${cached.appVersion} ` +
          `(${cached.engineVersion}): the toolchain or output format has changed. Reconverting.\n`,
      );
    } else if (cached) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, cached.srt, "utf8");
      const current = appVersion();
      const versionNote =
        cached.appVersion === current
          ? `app version ${cached.appVersion}`
          : `app version ${cached.appVersion} — current is ${current}`;
      process.stderr.write(
        `Wrote ${cached.cueCount} cues to ${outputPath} ` +
          `(reused cached conversion from ${versionNote}; pass --no-cache to reconvert)\n`,
      );
      return;
    }
  }

  // Preflight comes after the cache lookup on purpose: serving an already
  // finished conversion needs none of the tools. The pipeline always needs
  // ffmpeg and ImageMagick, whichever engine is selected — checking only
  // engine.requiredBinaries once let a Vision run (which declares just
  // swiftc) pass preflight and then die minutes later on the first image.
  checkBinaries(["ffmpeg", "magick", ...engine.requiredBinaries]);

  await convert(
    input,
    outputPath,
    language,
    keepTemp,
    mode,
    engine,
    quiet,
    jobs,
    limit,
  );

  if (cacheable) {
    const srt = await readFile(outputPath, "utf8");
    await writeCachedConversion(cacheKey, {
      appVersion: appVersion(),
      // Recorded so a later run can tell whether the recogniser, the output
      // format, or the available engine set has changed under it; see
      // isCachedConversionStale.
      engineVersion: recogniserVersion(),
      outputRevision: OUTPUT_REVISION,
      visionAvailable: isMacosVisionAvailable(),
      mode,
      language,
      sourceName: basename(input),
      cueCount: (srt.match(/ --> /g) ?? []).length,
      createdAt: new Date().toISOString(),
      srt,
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
