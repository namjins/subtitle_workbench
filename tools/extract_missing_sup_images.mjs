#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractPgsImagesAtTimes } from "../lib/pgs-peek.mjs";
import { parseArgv } from "../lib/cli-args.mjs";

const usage = `
Usage:
  tools/extract_missing_sup_images.mjs --details benchmark-details.json --out-dir dir [--examples-dir dir] [--kind missing|text] [--tolerance 0.08] [--limit 100]

Reads a detailed benchmark report and extracts PNG images for missing or
high-impact text-mismatch SUP cues.
`;

// This tool has no subcommand and is spawned flag-first, so parse from argv[2].
const cli = parseArgv(process.argv, {
  hasCommand: false,
  valueOptions: new Set(["--details", "--out-dir", "--examples-dir", "--kind", "--tolerance", "--limit"]),
});

function option(name, fallback = null) {
  return cli.option(name, fallback);
}

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function supPathForRow(row, examplesDir) {
  const supPath = examplesDir
    ? join(examplesDir, `${row.name}.sup`)
    : row.referencePath?.replace(/-eng\.srt$/i, ".sup");
  return supPath ? resolve(supPath) : null;
}

function cueTargets(row, kind) {
  if (kind === "text") {
    return (Array.isArray(row.textMismatches) ? row.textMismatches : []).map(
      (mismatch) => ({
        cue: mismatch.reference,
        candidateCue: mismatch.candidate,
        editDistance: mismatch.editDistance,
        characterErrorRate: mismatch.characterErrorRate,
      }),
    );
  }

  return (Array.isArray(row.missingCues) ? row.missingCues : []).map((cue) => ({
    cue,
  }));
}

function rowsWithTargets(rows, kind, limit) {
  if (kind !== "text") {
    return rows.map((row) => ({ row, targets: cueTargets(row, kind) }));
  }

  const flatTargets = rows.flatMap((row) =>
    cueTargets(row, kind).map((target) => ({ row, target })),
  );
  flatTargets.sort((left, right) => {
    if (right.target.editDistance !== left.target.editDistance) {
      return right.target.editDistance - left.target.editDistance;
    }
    return right.target.characterErrorRate - left.target.characterErrorRate;
  });

  const grouped = new Map();
  for (const item of flatTargets.slice(0, limit)) {
    const key = item.row.name;
    if (!grouped.has(key)) {
      grouped.set(key, { row: item.row, targets: [] });
    }
    grouped.get(key).targets.push(item.target);
  }
  return [...grouped.values()];
}

async function main() {
  if (cli.has("--help") || cli.has("-h")) {
    process.stdout.write(usage);
    return;
  }

  const detailsPath = option("--details");
  const outDir = option("--out-dir");
  if (!detailsPath || !outDir) {
    process.stderr.write(usage);
    process.exit(1);
  }

  const examplesDir = option("--examples-dir");
  const kind = option("--kind", "missing");
  if (kind !== "missing" && kind !== "text") {
    throw new Error("--kind must be either missing or text.");
  }
  const tolerance = Number(option("--tolerance", "0.08"));
  const limit = Number(option("--limit", "100"));
  const report = await readJson(resolve(detailsPath));
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const targetRoot = resolve(outDir);
  await mkdir(targetRoot, { recursive: true });

  const manifest = [];
  const maxItems = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  let remaining = maxItems;

  for (const item of rowsWithTargets(rows, kind, maxItems)) {
    const { row, targets } = item;
    if (!targets.length || remaining <= 0) continue;

    const supPath = supPathForRow(row, examplesDir);
    if (!supPath || !existsSync(supPath)) {
      manifest.push({
        file: row.name,
        error: `SUP file not found: ${supPath ?? "(unknown)"}`,
      });
      continue;
    }

    const cues = targets.slice(0, remaining);
    const fileOutDir = join(targetRoot, safeName(row.name));
    await mkdir(fileOutDir, { recursive: true });

    const extracted = await extractPgsImagesAtTimes(
      supPath,
      fileOutDir,
      cues.map((target) => target.cue.start),
      { toleranceSeconds: tolerance },
    );
    const imagesByStart = new Map(
      extracted.images.map((image) => [image.requestedStart, image]),
    );
    const unmatchedStarts = new Set(
      extracted.unmatched.map((item) => item.requestedStart),
    );

    for (const target of cues) {
      const image = imagesByStart.get(target.cue.start);
      manifest.push({
        kind,
        file: row.name,
        supPath,
        referencePath: row.referencePath,
        candidatePath: row.candidatePath,
        cue: target.cue,
        candidateCue: target.candidateCue,
        editDistance: target.editDistance,
        characterErrorRate: target.characterErrorRate,
        imagePath: image?.path ?? null,
        imagePts: image?.pts ?? null,
        imageDelta: image?.delta ?? null,
        imageSize: image ? { width: image.width, height: image.height } : null,
        matchedImage: Boolean(image),
        unmatched: unmatchedStarts.has(target.cue.start),
      });
    }

    remaining -= cues.length;
  }

  const manifestPath = join(targetRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const imageCount = manifest.filter((item) => item.imagePath).length;
  process.stdout.write(
    `Wrote ${imageCount} ${kind} cue images and ${basename(manifestPath)} to ${targetRoot}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
