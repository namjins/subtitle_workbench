#!/usr/bin/env node
import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { compareSrtFiles } from "../lib/srt-metrics.mjs";

const usage = `
Usage:
  tools/benchmark_ocr.mjs --reference reference.srt --candidate candidate.srt [--json] [--details out.json] [--max-text-mismatches 100]
  tools/benchmark_ocr.mjs --examples-dir dir --candidate-dir dir [--json] [--csv out.csv] [--details out.json] [--max-text-mismatches 100]
  tools/benchmark_ocr.mjs --examples-dir dir --candidate-dir dir --timing-first
  tools/benchmark_ocr.mjs --examples-dir dir --candidate-dir dir --max-missing 0 --max-extra 0 --max-end-mismatches 0 --max-cer 0.01

The directory mode pairs every .sup or .idx in --examples-dir with a reference
<basename>-eng.srt and a candidate in --candidate-dir named either
<basename>-eng.srt or <basename>.srt.
`;

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function numberOption(name) {
  const value = option(name);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a number.`);
  }
  return number;
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function summarize(name, metrics) {
  const unverified = metrics.referenceCues === 0 ? metrics.extra.length : 0;
  return {
    name,
    referenceCues: metrics.referenceCues,
    candidateCues: metrics.candidateCues,
    missing: metrics.missing.length,
    extra: metrics.extra.length - unverified,
    unverified,
    rawExtra: metrics.extra.length,
    endMismatches: metrics.endMismatches.length,
    exactTextMatches: metrics.exactTextMatches,
    characterErrorRate: metrics.characterErrorRate,
    textEditDistance: metrics.textEditDistance,
    referenceCharacters: metrics.referenceCharacters,
  };
}

function cueDetails(cue) {
  return {
    index: cue.index,
    number: cue.number,
    start: cue.start,
    end: cue.end,
    timing: cue.timing,
    text: cue.text,
  };
}

function textMismatchDetails(mismatch) {
  return {
    editDistance: mismatch.editDistance,
    referenceCharacters: mismatch.referenceCharacters,
    characterErrorRate: mismatch.characterErrorRate,
    reference: cueDetails(mismatch.reference),
    candidate: cueDetails(mismatch.candidate),
  };
}

function detailedSummary(name, referencePath, candidatePath, metrics, options = {}) {
  const maxTextMismatches = options.maxTextMismatches ?? 100;
  return {
    ...summarize(name, metrics),
    referencePath,
    candidatePath,
    missingCues: metrics.missing.map(cueDetails),
    extraCues: metrics.referenceCues === 0 ? [] : metrics.extra.map(cueDetails),
    unverifiedCues: metrics.referenceCues === 0 ? metrics.extra.map(cueDetails) : [],
    endMismatches: metrics.endMismatches.map((item) => ({
      reference: cueDetails(item.reference),
      candidate: cueDetails(item.candidate),
    })),
    textMismatches: metrics.textMismatches
      .slice(0, maxTextMismatches)
      .map(textMismatchDetails),
  };
}

function printTable(rows) {
  const header = [
    "file",
    "ref",
    "got",
    "miss",
    "extra",
    "unverified",
    "end",
    "exact",
    "cer",
  ];
  process.stdout.write(`${header.join("\t")}\n`);
  for (const row of rows) {
    process.stdout.write(
      [
        row.name,
        row.referenceCues,
        row.candidateCues,
        row.missing,
        row.extra,
        row.unverified,
        row.endMismatches,
        `${row.exactTextMatches}/${row.referenceCues}`,
        percent(row.characterErrorRate),
      ].join("\t"),
    );
    process.stdout.write("\n");
  }
}

function printTimingFirstTable(rows) {
  const header = [
    "file",
    "ref",
    "got",
    "miss",
    "extra",
    "unverified",
    "end",
    "timing",
    "cer",
  ];
  process.stdout.write(`${header.join("\t")}\n`);
  for (const row of rows) {
    process.stdout.write(
      [
        row.name,
        row.referenceCues,
        row.candidateCues,
        row.missing,
        row.extra,
        row.unverified,
        row.endMismatches,
        row.missing === 0 && row.extra === 0 && row.endMismatches === 0
          ? row.unverified > 0
            ? "unverified"
            : "ok"
          : "check",
        percent(row.characterErrorRate),
      ].join("\t"),
    );
    process.stdout.write("\n");
  }
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeCsv(path, rows) {
  const header = [
    "file",
    "reference_cues",
    "candidate_cues",
    "missing",
    "extra",
    "unverified",
    "raw_extra",
    "end_mismatches",
    "exact_text_matches",
    "character_error_rate",
    "text_edit_distance",
    "reference_characters",
  ];
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.name,
        row.referenceCues,
        row.candidateCues,
        row.missing,
        row.extra,
        row.unverified,
        row.rawExtra,
        row.endMismatches,
        row.exactTextMatches,
        row.characterErrorRate,
        row.textEditDistance,
        row.referenceCharacters,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function compareDirectory(
  examplesDir,
  candidateDir,
  includeDetails = false,
  detailOptions = {},
) {
  const files = await readdir(examplesDir);
  const sourceFiles = files.filter((file) => /\.(sup|idx)$/iu.test(file)).sort();
  const rows = [];
  const details = [];
  const missingCandidates = [];

  for (const sourceFile of sourceFiles) {
    const base = basename(sourceFile, extname(sourceFile));
    const referencePath = join(examplesDir, `${base}-eng.srt`);
    const preferredCandidate = join(candidateDir, `${base}-eng.srt`);
    const alternateCandidate = join(candidateDir, `${base}.srt`);
    const candidatePath = existsSync(preferredCandidate)
      ? preferredCandidate
      : alternateCandidate;

    if (!existsSync(referencePath) || !existsSync(candidatePath)) {
      missingCandidates.push({ base, referencePath, candidatePath });
      continue;
    }

    const metrics = await compareSrtFiles(referencePath, candidatePath);
    rows.push(summarize(base, metrics));
    if (includeDetails) {
      details.push(detailedSummary(base, referencePath, candidatePath, metrics, detailOptions));
    }
  }

  return { rows, details, missingCandidates };
}

function aggregate(rows) {
  const totals = rows.reduce(
    (sum, row) => ({
      name: "TOTAL",
      referenceCues: sum.referenceCues + row.referenceCues,
      candidateCues: sum.candidateCues + row.candidateCues,
      missing: sum.missing + row.missing,
      extra: sum.extra + row.extra,
      unverified: sum.unverified + row.unverified,
      rawExtra: sum.rawExtra + row.rawExtra,
      endMismatches: sum.endMismatches + row.endMismatches,
      exactTextMatches: sum.exactTextMatches + row.exactTextMatches,
      textEditDistance: sum.textEditDistance + row.textEditDistance,
      referenceCharacters: sum.referenceCharacters + row.referenceCharacters,
    }),
    {
      name: "TOTAL",
      referenceCues: 0,
      candidateCues: 0,
      missing: 0,
      extra: 0,
      unverified: 0,
      rawExtra: 0,
      endMismatches: 0,
      exactTextMatches: 0,
      textEditDistance: 0,
      referenceCharacters: 0,
    },
  );
  totals.characterErrorRate = totals.referenceCharacters
    ? totals.textEditDistance / totals.referenceCharacters
    : 0;
  return totals;
}

function evaluateQualityGate(total, missingCandidates, thresholds) {
  const failures = [];
  if (missingCandidates.length) {
    failures.push(`missing candidate/reference pairs: ${missingCandidates.length}`);
  }
  if (thresholds.maxMissing !== null && total.missing > thresholds.maxMissing) {
    failures.push(`missing cues ${total.missing} > ${thresholds.maxMissing}`);
  }
  if (thresholds.maxExtra !== null && total.extra > thresholds.maxExtra) {
    failures.push(`extra cues ${total.extra} > ${thresholds.maxExtra}`);
  }
  if (
    thresholds.maxEndMismatches !== null &&
    total.endMismatches > thresholds.maxEndMismatches
  ) {
    failures.push(
      `end mismatches ${total.endMismatches} > ${thresholds.maxEndMismatches}`,
    );
  }
  if (
    thresholds.maxCharacterErrorRate !== null &&
    total.characterErrorRate > thresholds.maxCharacterErrorRate
  ) {
    failures.push(
      `CER ${percent(total.characterErrorRate)} > ${percent(thresholds.maxCharacterErrorRate)}`,
    );
  }

  return {
    enabled: Object.values(thresholds).some((value) => value !== null),
    passed: failures.length === 0,
    failures,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage);
    return;
  }

  const json = process.argv.includes("--json");
  const timingFirst = process.argv.includes("--timing-first");
  const reference = option("--reference");
  const candidate = option("--candidate");
  const examplesDir = option("--examples-dir");
  const candidateDir = option("--candidate-dir");
  const csv = option("--csv");
  const detailsPath = option("--details");
  const thresholds = {
    maxMissing: numberOption("--max-missing"),
    maxExtra: numberOption("--max-extra"),
    maxEndMismatches: numberOption("--max-end-mismatches"),
    maxCharacterErrorRate: numberOption("--max-cer"),
  };
  const maxTextMismatches = Number(option("--max-text-mismatches", "100"));
  const detailOptions = {
    maxTextMismatches:
      Number.isFinite(maxTextMismatches) && maxTextMismatches >= 0
        ? maxTextMismatches
        : 100,
  };

  let rows = [];
  let details = [];
  let missingCandidates = [];
  if (reference && candidate) {
    const referencePath = resolve(reference);
    const candidatePath = resolve(candidate);
    const metrics = await compareSrtFiles(referencePath, candidatePath);
    const name = basename(referencePath).replace(/-eng\.srt$/i, "");
    rows = [summarize(name, metrics)];
    if (detailsPath) {
      details = [detailedSummary(name, referencePath, candidatePath, metrics, detailOptions)];
    }
  } else if (examplesDir && candidateDir) {
    const result = await compareDirectory(
      resolve(examplesDir),
      resolve(candidateDir),
      Boolean(detailsPath),
      detailOptions,
    );
    rows = result.rows;
    details = result.details;
    missingCandidates = result.missingCandidates;
  } else {
    process.stderr.write(usage);
    process.exit(1);
  }

  const total = aggregate(rows);
  const gate = evaluateQualityGate(total, missingCandidates, thresholds);
  if (csv) {
    await writeCsv(resolve(csv), [...rows, total]);
  }
  if (detailsPath) {
    await writeFile(
      resolve(detailsPath),
      JSON.stringify({ rows: details, total, missingCandidates }, null, 2),
      "utf8",
    );
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          rows,
          total,
          missingCandidates,
          details: detailsPath ? undefined : details,
          qualityGate: gate.enabled ? gate : undefined,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
  } else {
    if (timingFirst) {
      printTimingFirstTable([...rows, total]);
    } else {
      printTable([...rows, total]);
    }
    if (missingCandidates.length) {
      process.stderr.write(`Missing candidate/reference pairs: ${missingCandidates.length}\n`);
      for (const item of missingCandidates.slice(0, 20)) {
        process.stderr.write(`  ${item.base}\n`);
      }
    }
  }

  if (gate.enabled) {
    if (gate.passed) {
      process.stderr.write("OCR quality gate passed.\n");
    } else {
      process.stderr.write("OCR quality gate failed:\n");
      for (const failure of gate.failures) {
        process.stderr.write(`  ${failure}\n`);
      }
      process.exit(2);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
