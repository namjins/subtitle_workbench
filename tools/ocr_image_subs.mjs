#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgv } from "../lib/cli-args.mjs";
import { cacheDirectory, hasCommand } from "../lib/platform-paths.mjs";
import { normalizeJobs } from "../lib/cpu-jobs.mjs";
import { createOcrEngine } from "../lib/ocr-tesseract.mjs";
import { toSrtDocument } from "../lib/subtitle-core.mjs";
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with ${result.status}\n${result.stderr ?? ""}`.trim(),
    );
  }
  return result.stdout ?? "";
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

function checkBinary(command) {
  if (!hasCommand(command)) {
    throw new Error(`Missing required binary: ${command}`);
  }
}

function secondsToSrtTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

function ptsFromFrameName(file) {
  const match = file.match(/frame-(\d+)\.png$/u);
  if (!match) return null;
  return Number(match[1]) / 1_000_000;
}

async function imageStatsAsync(imagePath) {
  const output = await runAsync("magick", [
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
  await runAsync("magick", [
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
  run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-i",
      input,
      "-filter_complex",
      "[0:s:0]scale=iw:ih[v]",
      "-map",
      "[v]",
      "-fps_mode",
      "passthrough",
      "-frame_pts",
      "true",
      join(workingDirectory, "frame-%010d.png"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const frames = (await readdir(workingDirectory))
    .filter((file) => /^frame-\d+\.png$/u.test(file))
    .sort()
    .map((file) => ({
      file,
      path: join(workingDirectory, file),
      pts: ptsFromFrameName(file),
    }))
    .filter((frame) => frame.pts !== null);

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
        endPts: frames[index + 1]?.pts ?? frame.pts + 2.5,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(jobs, frames.length) }, () => worker()),
  );

  return prepared.filter(Boolean);
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
    const [packets, extractedImages] =
      mode === "sup-to-srt"
        ? [[], await extractPgsPreviewImages(input, workingDirectory, Infinity)]
        : [[], await extractSubIdxImages(input, workingDirectory, jobs)];
    const images = limit === null ? extractedImages : extractedImages.slice(0, limit);

    if (!images.length) {
      // Distinguish "not a subtitle file we can read" from "a subtitle file
      // that genuinely shows nothing". Blank forced/overlay tracks are real —
      // several exist in the fixture corpus, with correctly empty reference
      // SRTs — so failing on them would be wrong. Failing only when the
      // container has no display sets at all still catches the damaged and
      // wrong-format cases this check was added for.
      const displaySets =
        mode === "sup-to-srt" ? await countPgsDisplaySets(input) : 1;
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

    const results = new Array(images.length);

    function storeResult(index, ocrResult) {
      const text = ocrResult.text;
      const timing = packets[index] ?? {
        start: images[index].pts ?? index * 3,
        end:
          images[index].endPts ??
          images[index + 1]?.pts ??
          (images[index].pts ?? index * 3) + 2.5,
      };
      results[index] = text ? { ...timing, text } : null;
      if (!quiet) {
        process.stderr.write(
          `OCR ${index + 1}/${images.length}: ${text ? "text" : "blank"} (${ocrResult.variant})\n`,
        );
      }
    }

    if (typeof engine.recognizeBatch === "function") {
      const chunks = Array.from(
        { length: Math.min(jobs, images.length) },
        () => [],
      );
      images.forEach((image, index) => {
        chunks[index % chunks.length].push({ image, index });
      });
      await Promise.all(
        chunks.map(async (chunk) => {
          if (!chunk.length) return;
          const ocrResults = await engine.recognizeBatch(
            chunk.map((item) => item.image.path),
            { language },
          );
          ocrResults.forEach((ocrResult, resultIndex) => {
            storeResult(chunk[resultIndex].index, ocrResult);
          });
        }),
      );
    } else {
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < images.length) {
          const index = nextIndex;
          nextIndex += 1;
          const ocrResult = await engine.recognize(images[index].path, { language });
          storeResult(index, ocrResult);
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(jobs, images.length) }, () => worker()),
      );
    }
    const cues = results.filter(Boolean);

    const srt = cues
      .map((cue, index) =>
        [
          String(index + 1),
          `${secondsToSrtTime(cue.start)} --> ${secondsToSrtTime(cue.end)}`,
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
  // The pipeline always needs ImageMagick, whichever engine is selected.
  // Checking only engine.requiredBinaries let a Vision run (which declares
  // just swiftc) pass preflight and then die minutes later on the first image.
  checkBinary("ffmpeg");
  checkBinary("magick");
  for (const binary of engine.requiredBinaries) {
    checkBinary(binary);
  }

  const input = resolve(inputArg);
  if (!existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }

  if (mode === "subidx-to-srt") {
    const subPath = join(dirname(input), `${basename(input, extname(input))}.sub`);
    if (!existsSync(subPath)) {
      throw new Error(`Matching .sub file not found: ${subPath}`);
    }
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

  await convert(
    input,
    resolve(output),
    language,
    keepTemp,
    mode,
    engine,
    quiet,
    jobs,
    limit,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
