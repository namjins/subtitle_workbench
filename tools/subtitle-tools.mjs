#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDoctorReport, formatDoctorReport } from "../lib/dependency-doctor.mjs";
import { extractPgsPreviewImages } from "../lib/pgs-peek.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorScript = join(root, "tools", "extract_english_subs.sh");
const ocrScript = join(root, "tools", "ocr_image_subs.mjs");
const benchmarkScript = join(root, "tools", "benchmark_ocr.mjs");
const missingImagesScript = join(root, "tools", "extract_missing_sup_images.mjs");

const usage = `
Subtitle Workbench CLI

Usage:
  subtitle-workbench doctor [--json] [--lang eng]
  subtitle-workbench extract-english <video-dir> [--jobs 4]
  subtitle-workbench peek-sup <file.sup> [--out-dir dir] [--count 3]
  subtitle-workbench sup-to-srt <files.sup...> [--lang eng] [--out file.srt] [--out-dir dir] [--jobs 4] [--skip-existing] [--quiet]
  subtitle-workbench subidx-to-srt <files.idx...> [--lang eng] [--out file.srt] [--out-dir dir] [--jobs 4] [--skip-existing] [--quiet]
  subtitle-workbench benchmark-ocr --reference reference.srt --candidate candidate.srt
  subtitle-workbench benchmark-ocr --examples-dir dir --candidate-dir dir [--csv out.csv] [--details out.json]
  subtitle-workbench inspect-missing-ocr --details benchmark-details.json --out-dir dir [--examples-dir dir] [--kind missing|text]

Examples:
  subtitle-workbench doctor
  subtitle-workbench doctor --json
  subtitle-workbench extract-english "/path/to/videos" --jobs 4
  subtitle-workbench peek-sup movie.sup --out-dir ./preview
  subtitle-workbench sup-to-srt movie.sup --lang eng --out movie.srt
  subtitle-workbench sup-to-srt *.sup --lang eng --out-dir ./srt
  subtitle-workbench benchmark-ocr --examples-dir ./examples --candidate-dir ./ocr-output
  subtitle-workbench inspect-missing-ocr --details ./ocr-output/details.json --examples-dir ./examples --out-dir ./ocr-misses
`;

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function positionalArgs() {
  const valueOptions = new Set([
    "--candidate",
    "--candidate-dir",
    "--count",
    "--csv",
    "--details",
    "--examples-dir",
    "--fps",
    "--jobs",
    "--lang",
    "--limit",
    "--max-text-mismatches",
    "--max-cer",
    "--max-end-mismatches",
    "--max-extra",
    "--max-missing",
    "--ocr-engine",
    "--out",
    "--out-dir",
    "--reference",
    "--tolerance",
  ]);
  const args = [];
  for (let index = 3; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (valueOptions.has(arg)) {
      index += 1;
    } else if (!arg.startsWith("--")) {
      args.push(arg);
    }
  }
  return args;
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

function extractEnglish() {
  const [videoDir] = positionalArgs();
  if (!videoDir) throw new Error("No video directory provided.");
  const jobs = option("--jobs", "2");
  run(extractorScript, ["-j", jobs], {
    cwd: resolve(videoDir),
    env: { ...process.env, JOBS: jobs },
  });
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

  for (const input of inputs) {
    const started = performance.now();
    const inputPath = resolve(input);
    const args = [mode, inputPath, "--lang", option("--lang", "eng")];
    const outputPath = outDir
      ? join(resolve(outDir), `${basename(inputPath, extname(inputPath))}.srt`)
      : out;
    if (outputPath && process.argv.includes("--skip-existing") && existsSync(resolve(outputPath))) {
      process.stderr.write(`Skipping existing ${resolve(outputPath)}\n`);
      continue;
    }
    if (outputPath) args.push("--out", resolve(outputPath));
    if (process.argv.includes("--keep-temp")) args.push("--keep-temp");
    if (process.argv.includes("--quiet")) args.push("--quiet");
    if (option("--limit")) args.push("--limit", option("--limit"));
    args.push("--jobs", option("--jobs", "1"));
    args.push("--ocr-engine", option("--ocr-engine", "auto"));
    process.stderr.write(`Starting ${basename(inputPath)}\n`);
    run(ocrScript, args);
    const durationSeconds = (performance.now() - started) / 1000;
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
  run("node", [benchmarkScript, ...process.argv.slice(3)]);
}

function inspectMissingOcr() {
  run("node", [missingImagesScript, ...process.argv.slice(3)]);
}

function doctor() {
  const report = buildDoctorReport({ language: option("--lang", "eng") });
  if (process.argv.includes("--json")) {
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
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return;
  }

  if (command === "doctor") {
    doctor();
  } else if (command === "extract-english") {
    extractEnglish();
  } else if (command === "peek-sup") {
    await peekSup();
  } else if (command === "sup-to-srt") {
    await imageOcr("sup-to-srt");
  } else if (command === "subidx-to-srt") {
    await imageOcr("subidx-to-srt");
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
