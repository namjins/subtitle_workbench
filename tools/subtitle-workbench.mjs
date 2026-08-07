#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDoctorReport, formatDoctorReport } from "../lib/dependency-doctor.mjs";
import { parseArgv } from "../lib/cli-args.mjs";
import {
  extractSubtitlesFromDirectory,
  parseLanguageList,
} from "../lib/batch-extract.mjs";
import { normalizeJobs } from "../lib/cpu-jobs.mjs";
import { formatJobEvent } from "../lib/local-job-events.mjs";
import { extractPgsPreviewImages } from "../lib/pgs-peek.mjs";
import {
  convertToSrt,
  outputNameFor,
  parseFps,
  toSrtDocument,
} from "../lib/subtitle-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ocrScript = join(root, "tools", "ocr_image_subs.mjs");
const benchmarkScript = join(root, "tools", "benchmark_ocr.mjs");
const missingImagesScript = join(root, "tools", "extract_missing_sup_images.mjs");

const usage = `
Subtitle Workbench CLI

Usage:
  subtitle-workbench ui [--port 8765] [--no-open]
  subtitle-workbench doctor [--json] [--lang eng] [--feature ocr|extract]
  subtitle-workbench extract-english <video-dir> [--languages eng,spa|--all-languages] [--jobs auto|4]
  subtitle-workbench peek-sup <file.sup> [--out-dir dir] [--count 3]
  subtitle-workbench sup-to-srt <files.sup...> [--lang eng] [--out file.srt] [--out-dir dir] [--jobs auto|4] [--ocr-engine auto] [--text-cleanup generic|fitted] [--skip-existing] [--no-cache] [--quiet] [--json-events]
  subtitle-workbench subidx-to-srt <files.idx...> [--lang eng] [--out file.srt] [--out-dir dir] [--jobs auto|4] [--ocr-engine auto] [--text-cleanup generic|fitted] [--skip-existing] [--no-cache] [--quiet] [--json-events]
  subtitle-workbench itt-to-srt <files.itt...> [--fps 24000/1001] [--out file.srt] [--out-dir dir] [--skip-existing] [--json-events]
  subtitle-workbench benchmark-ocr --reference reference.srt --candidate candidate.srt
  subtitle-workbench benchmark-ocr --examples-dir dir --candidate-dir dir [--csv out.csv] [--details out.json]
  subtitle-workbench inspect-missing-ocr --details benchmark-details.json --out-dir dir [--examples-dir dir] [--kind missing|text]

Examples:
  subtitle-workbench ui
  subtitle-workbench doctor
  subtitle-workbench doctor --json
  subtitle-workbench extract-english "/path/to/videos"
  subtitle-workbench peek-sup movie.sup --out-dir ./preview
  subtitle-workbench sup-to-srt movie.sup --lang eng --out movie.srt
  subtitle-workbench sup-to-srt *.sup --lang eng --out-dir ./srt
  subtitle-workbench itt-to-srt captions.itt --fps 25 --out captions.srt
  subtitle-workbench benchmark-ocr --examples-dir ./examples --candidate-dir ./ocr-output
  subtitle-workbench inspect-missing-ocr --details ./ocr-output/details.json --examples-dir ./examples --out-dir ./ocr-misses
`;

const valueOptions = new Set([
  "--candidate",
  "--candidate-dir",
  "--count",
  "--csv",
  "--details",
  "--examples-dir",
  "--feature",
  "--fixture-metadata",
  "--fps",
  "--jobs",
  "--kind",
  "--lang",
  "--languages",
  "--limit",
  "--max-text-mismatches",
  "--max-cer",
  "--max-end-mismatches",
  "--max-extra",
  "--max-missing",
  "--min-fixtures",
  "--ocr-engine",
  "--ocr-command",
  "--out",
  "--out-dir",
  "--port",
  "--reference",
  "--text-cleanup",
  "--tolerance",
]);

const cli = parseArgv(process.argv, { valueOptions });

function option(name, fallback = null) {
  return cli.option(name, fallback);
}

function hasFlag(name) {
  return cli.has(name);
}

function positionalArgs() {
  return cli.positionals;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const error = new Error(`${command} exited with ${result.status}`);
    error.exitStatus = result.status;
    throw error;
  }
}

function emitJobEvent(type, fields = {}) {
  if (hasFlag("--json-events")) {
    process.stdout.write(formatJobEvent(type, fields));
  }
}

async function extractEnglish() {
  const [videoDir] = positionalArgs();
  if (!videoDir) throw new Error("No video directory provided.");

  // Fail before scanning, with install help, rather than per file once the
  // batch is running. Silent when everything is present.
  const report = buildDoctorReport({ feature: "extract" });
  if (!report.summary.ready) {
    const missing = report.summary.binaryFailures.map((item) => item.name);
    throw new Error(
      [
        `Missing required tools: ${missing.join(", ")}.`,
        "Install them and run `subtitle-workbench doctor` to verify:",
        ...report.install.map((line) => `  ${line}`),
      ].join("\n"),
    );
  }

  const languages = parseLanguageList(
    hasFlag("--all-languages") ? "all" : option("--languages", "eng"),
  );
  const result = await extractSubtitlesFromDirectory({
    directory: resolve(videoDir),
    languages,
    jobs: normalizeJobs(option("--jobs", "auto")),
    skipExisting: true,
    onLog: (message) => process.stderr.write(`${message}\n`),
  });

  process.stderr.write(
    `Scanned ${result.videos} file(s), wrote ${result.extracted.length} subtitle file(s).\n`,
  );
  // The shell version exited 0 even when every track failed.
  if (result.failures.length) {
    const error = new Error(`${result.failures.length} file(s) failed to extract.`);
    error.exitStatus = 1;
    throw error;
  }
}

async function imageOcr(mode) {
  const inputs = positionalArgs();
  if (!inputs.length) throw new Error("No input file provided.");
  const out = option("--out");
  const outDir = option("--out-dir");
  if (out && inputs.length > 1) {
    throw new Error("--out can only be used with a single input file.");
  }
  if (outDir) {
    await mkdir(outDir, { recursive: true });
  }

  const failures = [];

  for (const input of inputs) {
    const started = performance.now();
    const inputPath = resolve(input);
    const language = option("--lang", "eng");
    const args = [mode, "--lang", language];
    // OCR output names carry the language (movie-eng.srt): several tracks of
    // the same source in different languages must not overwrite each other,
    // and it is the naming players and the benchmark pairing already expect.
    const defaultName = `${basename(inputPath, extname(inputPath))}-${language}.srt`;
    const outputPath = outDir
      ? join(resolve(outDir), defaultName)
      : out
        ? resolve(out)
        : join(dirname(inputPath), defaultName);
    if (outputPath && hasFlag("--skip-existing") && existsSync(resolve(outputPath))) {
      process.stderr.write(`Skipping existing ${resolve(outputPath)}\n`);
      continue;
    }
    args.push("--out", resolve(outputPath));
    if (hasFlag("--keep-temp")) args.push("--keep-temp");
    if (hasFlag("--quiet")) args.push("--quiet");
    if (hasFlag("--no-cache")) args.push("--no-cache");
    if (option("--limit")) args.push("--limit", option("--limit"));
    const jobs = normalizeJobs(option("--jobs", "auto"));
    args.push("--jobs", String(jobs));
    args.push("--ocr-engine", option("--ocr-engine", "auto"));
    if (option("--ocr-command")) args.push("--ocr-command", option("--ocr-command"));
    args.push("--text-cleanup", option("--text-cleanup", "generic"));
    // Terminator last: the input path is the only positional, and it must not
    // be re-interpreted as an option by the child.
    args.push("--", inputPath);
    emitJobEvent("job-started", {
      mode,
      input: inputPath,
      output: outputPath ? resolve(outputPath) : null,
      language: option("--lang", "eng"),
      engine: option("--ocr-engine", "auto"),
      jobs,
    });
    process.stderr.write(`Starting ${basename(inputPath)}\n`);

    // One unreadable file must not discard the rest of a long batch. Failures
    // are reported per file and re-raised at the end, so the exit status still
    // tells the truth. A single-file run still fails immediately.
    try {
      run(process.execPath, [ocrScript, ...args]);
    } catch (error) {
      failures.push({ input: inputPath, message: error.message });
      emitJobEvent("job-failed", { mode, input: inputPath, error: error.message });
      process.stderr.write(`FAILED ${basename(inputPath)}: ${error.message}\n`);
      if (inputs.length === 1) throw error;
      continue;
    }

    const durationSeconds = (performance.now() - started) / 1000;
    emitJobEvent("job-finished", {
      mode,
      input: inputPath,
      output: outputPath ? resolve(outputPath) : null,
      durationSeconds,
    });
    process.stderr.write(
      `Finished ${basename(inputPath)} in ${formatDuration(durationSeconds)}\n`,
    );
  }

  if (failures.length) {
    process.stderr.write(
      `${failures.length} of ${inputs.length} file(s) failed:\n` +
        failures.map((item) => `  ${basename(item.input)}\n`).join(""),
    );
    const error = new Error(`${failures.length} file(s) failed to convert.`);
    error.exitStatus = 1;
    throw error;
  }
}

async function textToSrt(mode) {
  const inputs = positionalArgs();
  if (!inputs.length) throw new Error("No input file provided.");
  const out = option("--out");
  const outDir = option("--out-dir");
  const fpsRaw = option("--fps", "24000/1001");
  const fps = parseFps(fpsRaw);
  if (out && inputs.length > 1) {
    throw new Error("--out can only be used with a single input file.");
  }
  if (outDir) {
    await mkdir(outDir, { recursive: true });
  }

  for (const input of inputs) {
    const started = performance.now();
    const inputPath = resolve(input);
    const outputPath = outDir
      ? join(resolve(outDir), outputNameFor(basename(inputPath)))
      : out
        ? resolve(out)
        : join(dirname(inputPath), outputNameFor(basename(inputPath)));
    if (hasFlag("--skip-existing") && existsSync(outputPath)) {
      process.stderr.write(`Skipping existing ${outputPath}\n`);
      continue;
    }
    emitJobEvent("job-started", {
      mode,
      input: inputPath,
      output: outputPath,
      fps: fpsRaw,
    });
    const source = await readFile(inputPath, "utf8");
    const srt = convertToSrt(source, inputPath, { fps });
    await writeFile(outputPath, toSrtDocument(srt), "utf8");
    const durationSeconds = (performance.now() - started) / 1000;
    emitJobEvent("job-finished", {
      mode,
      input: inputPath,
      output: outputPath,
      durationSeconds,
    });
    process.stderr.write(
      `Finished ${basename(inputPath)} in ${formatDuration(durationSeconds)}\n`,
    );
  }
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function benchmarkOcr() {
  run(process.execPath, [benchmarkScript, ...cli.flagArgs(), "--", ...positionalArgs()]);
}

function inspectMissingOcr() {
  run(process.execPath, [missingImagesScript, ...cli.flagArgs(), "--", ...positionalArgs()]);
}

function doctor() {
  const report = buildDoctorReport({
    language: option("--lang", "eng"),
    feature: option("--feature"),
  });
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorReport(report));
  }
  if (!report.summary.ready) {
    const error = new Error("Missing required subtitle tool dependencies.");
    error.exitStatus = 1;
    throw error;
  }
}

async function startUi() {
  const { createLocalBridgeServer } = await import("../lib/local-bridge-server.mjs");
  const distDir = join(root, "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error(
      "No built UI found in dist/. Run `npm run build` first, or use `npm run app`.",
    );
  }

  const port = Number(option("--port", process.env.SUBTITLE_WORKBENCH_BRIDGE_PORT ?? "8765"));
  const host = process.env.SUBTITLE_WORKBENCH_BRIDGE_HOST ?? "127.0.0.1";
  // Under `npm run dev` the page is served by Vite on another port, so it has
  // no injected token. Allowlisting that origin is opt-in and never on by
  // default, because it widens what may talk to the bridge.
  const devOrigins = hasFlag("--dev")
    ? ["http://localhost:3000", "http://127.0.0.1:3000"]
    : [];
  const server = createLocalBridgeServer({
    devOrigins,
    token: hasFlag("--dev") ? null : undefined,
  });

  await new Promise((resolvePromise) => server.listen(port, host, resolvePromise));
  const url = `http://${host}:${port}/`;
  process.stderr.write(`Subtitle Workbench is running at ${url}\n`);
  if (hasFlag("--dev")) {
    process.stderr.write("Development mode: accepting requests from the Vite dev origin.\n");
  }

  if (!hasFlag("--no-open")) {
    const opener =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    spawnSync(opener[0], opener[1], { stdio: "ignore" });
  }

  process.on("SIGINT", () => server.close(() => process.exit(0)));

  // The desktop shell passes --exit-with-parent and holds our stdin pipe.
  // When the shell dies — cleanly, by signal, or by SIGKILL — the pipe
  // closes and we exit. Watching the pipe rather than trusting the shell's
  // exit handler means an orphaned bridge cannot happen: a process that can
  // read files and spawn commands must not outlive the window that owns it.
  if (hasFlag("--exit-with-parent")) {
    process.stdin.resume();
    const exitWithParent = () => server.close(() => process.exit(0));
    process.stdin.on("end", exitWithParent);
    process.stdin.on("close", exitWithParent);
    process.stdin.on("error", exitWithParent);
  }
}

async function peekSup() {
  const [input] = positionalArgs();
  if (!input) throw new Error("No SUP file provided.");
  const outDir = resolve(option("--out-dir", "./sup-preview"));
  const count = Number(option("--count", "3"));
  const previews = await extractPgsPreviewImages(resolve(input), outDir, count);
  if (!previews.length) {
    throw new Error("No useful preview images were found.");
  }
  for (const preview of previews) {
    process.stdout.write(`${preview.path}\n`);
  }
}

async function main() {
  const command = cli.command;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return;
  }

  if (command === "doctor") {
    doctor();
  } else if (command === "ui") {
    await startUi();
  } else if (command === "extract-english") {
    await extractEnglish();
  } else if (command === "peek-sup") {
    await peekSup();
  } else if (command === "sup-to-srt") {
    await imageOcr("sup-to-srt");
  } else if (command === "subidx-to-srt") {
    await imageOcr("subidx-to-srt");
  } else if (command === "itt-to-srt") {
    await textToSrt("itt-to-srt");
  } else if (command === "benchmark-ocr") {
    benchmarkOcr();
  } else if (command === "inspect-missing-ocr") {
    inspectMissingOcr();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitStatus ?? 1);
});
