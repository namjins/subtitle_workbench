import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createSupProbeEngine } from "./ocr-engine-probe.mjs";
import { createExternalCommandEngine } from "./ocr-external-command.mjs";
import { createMacosVisionEngine } from "./ocr-macos-vision.mjs";

function hasCommand(command) {
  const lookup =
    process.platform === "win32"
      ? spawnSync("where", [command], { encoding: "utf8" })
      : spawnSync("which", [command], { encoding: "utf8" });
  return lookup.status === 0;
}

export function isMacosVisionAvailable() {
  return process.platform === "darwin" && hasCommand("swiftc");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`${command} failed: ${error.message}`));
    });
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${
            signal ? `terminated by ${signal}` : `exited with ${status}`
          }\n${stderr}`.trim(),
        ),
      );
    });
  });
}

/**
 * Repairs that describe how bitmap OCR fails in general: glyph confusions the
 * renderer causes (| for I, f/J for a music note), punctuation normalisation,
 * and bracket/ellipsis damage. These are defensible on any subtitle track.
 */
function genericCleanup(line) {
  return (
    line
      .replace(/[‘’]/gu, "'")
      .replace(/[“”]/gu, '"')
      .trim()
      .replace(/^[‘'`]+/u, "")
      .replace(/^\[['‘`]+(?=[A-Za-z])/u, "[")
      // A music note commonly reads as f, J, #, ¢ or &.
      .replace(/^[fJ#¢&]\s+(?=[A-Za-z".])/u, "♪ ")
      .replace(/\s+[fJ£]$/u, " ♪")
      .replace(/^\|--$/u, "")
      // Leading ellipsis damage.
      .replace(/^\.\.-+(?=[A-Za-z0-9])/u, "...")
      .replace(/^\.(?:-+|\s+)(?=[A-Za-z0-9])/u, "...")
      .replace(/^\.\.\s+(?=[A-Za-z])/u, "...")
      // Pipe/I confusion.
      .replace(/^\|(?=\s|[a-z])/u, "I")
      .replace(/\s\|(?=\s?[A-Za-z])/gu, " I")
      .replace(/\.\.\.\|(?=\s?[A-Za-z])/gu, "...I")
      .replace(/^[-_]\s*/u, "- ")
      // Bracketed sound cues whose brackets were misread.
      .replace(/^I([a-z][a-z ]+)\]_?,?$/u, "[$1]")
      .replace(/^([a-z][a-z ]+)\]_?,?$/u, "[$1]")
      .replace(/^\[([^\]]+)\],$/u, "[$1]")
      .replace(/^I(?=[A-Z][A-Za-z ]+(?:[1IJl]|\]|$))/u, "[")
      .replace(/^\[([^\]]+?)\s*[1IJl]$/u, "[$1]")
      .replace(/^\[([^\]]+?)J$/u, "[$1]")
      .replace(/^([A-Z])(?:[A-Z]|[cz])\.$/u, "$1...")
      .replace(/^([A-Z])\.\.$/u, "$1...")
      .replace(/[ \t]{2,}/g, " ")
  );
}

/**
 * Rules fitted to the reference corpus: they name specific words
 * ("know", "want", "of", "as") rather than describing a glyph confusion, and
 * `I Know` -> `I know` is a language correction, not an OCR repair.
 *
 * These are off by default. They flatter the benchmark on the very data they
 * were derived from, so leaving them on made the headline CER partly a measure
 * of its own training set. Enable with `--text-cleanup fitted` to reproduce
 * historical numbers.
 */
function corpusFittedCleanup(line) {
  return line
    .replace(/^\.\.{1,2}-[@&8]{1,2}\s+/u, "...as ")
    .replace(/^\.\.-0f\b/u, "...of")
    .replace(/^\.\.-1(?=\s)/u, "...I")
    .replace(/\|(?=\s?[Kk]now\b)/gu, "I")
    .replace(/\bI Know\b/gu, "I know")
    .replace(/^\/(?=\s?want\b)/iu, "I");
}

export const textCleanupProfiles = new Set(["generic", "fitted"]);

export function cleanOcrText(text, { profile = "generic" } = {}) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      if (profile !== "fitted") return genericCleanup(line);
      // Either side of the generic pass: some fitted rules match the raw
      // damage (`..-0f` before the ellipsis is normalised), others match what
      // generic produces (`I Know` only exists after `...|` becomes `...I`).
      return corpusFittedCleanup(genericCleanup(corpusFittedCleanup(line.trim())));
    })
    .filter(Boolean);
  return lines.join("\n").trim();
}

function parseTesseractTsv(tsv, variant, profile) {
  const lines = tsv.replace(/\r/g, "").trim().split("\n").slice(1);
  const wordRows = lines
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 12 && columns[0] === "5" && columns[11]);

  const groupedLines = [];
  let previousLineKey = "";
  const confidences = [];

  for (const columns of wordRows) {
    const confidence = Number(columns[10]);
    if (Number.isFinite(confidence) && confidence >= 0) {
      confidences.push(confidence);
    }

    const lineKey = columns.slice(1, 5).join(":");
    if (lineKey !== previousLineKey) {
      groupedLines.push([]);
      previousLineKey = lineKey;
    }
    groupedLines.at(-1).push(columns.slice(11).join("\t"));
  }

  const confidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  const text = cleanOcrText(groupedLines.map((line) => line.join(" ")).join("\n"), {
    profile,
  });

  return { confidence, text, variant };
}

function candidateScore(candidate) {
  if (!candidate.text) return 0;
  return candidate.confidence + Math.min(candidate.text.length, 120) * 0.02;
}

function textLines(text) {
  return text.split("\n").filter(Boolean);
}

function hasFragmentLines(text) {
  const lines = textLines(text);
  if (lines.length < 2) return false;
  return lines.filter((line) => line.length <= 3).length >= 2;
}

function imageDimensions(imagePath) {
  try {
    const buffer = readFileSync(imagePath);
    const isPng =
      buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;
    if (!isPng) return null;
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  } catch {
    return null;
  }
}

function isWeakPrimaryCandidate(candidate, imagePath) {
  if (!candidate.text) return false;
  const lines = textLines(candidate.text);
  if (lines.length >= 3 || hasFragmentLines(candidate.text)) return true;
  if (/^[A-Za-z]{1,3}$/u.test(candidate.text)) return true;

  const dimensions = imageDimensions(imagePath);
  return Boolean(
    dimensions &&
      dimensions.height >= 150 &&
      (lines.length === 1 || (candidate.variant === "psm-11" && lines.length <= 2)),
  );
}

function isUsableFallback(candidate) {
  if (!candidate.text) return false;
  if (/^\[[A-Za-z][A-Za-z -]+\]$/u.test(candidate.text)) {
    return candidate.confidence >= 10;
  }
  if (/\b(?:just|think)\.\.\.$/iu.test(candidate.text)) {
    return candidate.confidence >= 35;
  }
  // A single capital trailing into an ellipsis is a genuine subtitle shape — a
  // cut-off word or a stammer. Rejecting it outright is why this function used
  // to carry literal "H..."/"E..." exceptions to rescue two specific cues.
  //
  // The threshold is low because these candidates are genuinely low
  // confidence: the cue that motivated it reads as "Ec." at confidence 13.
  // Measured across all 42 SUP fixtures (26,415 cues), this recovers the cue
  // the literals existed for and introduces no extra cues at all:
  //   literals      0 missing, 0 extra, 0.6758% CER
  //   this gate     0 missing, 0 extra, 0.6807% CER
  //   neither       1 missing, 0 extra, 0.6813% CER
  if (/^[A-Z]\.\.\.$/u.test(candidate.text)) {
    return candidate.confidence >= 10;
  }
  if (/^[A-Za-z]{1,2}$/u.test(candidate.text)) {
    return false;
  }
  return candidate.confidence >= 45 && candidate.text.length >= 3;
}

function isHighPrecisionSingleLineFallback(candidate) {
  if (!candidate.text) return false;
  if (candidate.text.includes("\n")) return false;
  return candidate.confidence >= 80 && candidate.text.length >= 2;
}

function isThresholdDilateFallback(candidate) {
  if (!isUsableFallback(candidate)) return false;
  if (/^[A-Za-z]{1,3}$/u.test(candidate.text)) {
    return candidate.confidence >= 80;
  }
  return true;
}

function shouldPreferThresholdDilate(primary, fallback) {
  if (!isThresholdDilateFallback(fallback)) return false;
  if (fallback.confidence < 70) return false;

  const primaryLines = textLines(primary.text);
  const fallbackLines = textLines(fallback.text);
  if (
    fallbackLines.length > primaryLines.length &&
    fallback.text.length >= primary.text.length + 4
  ) {
    return true;
  }
  if (fallback.confidence >= 80 && fallback.text.length >= primary.text.length + 8) {
    return true;
  }
  if (hasFragmentLines(primary.text) && fallback.text.length >= primary.text.length - 2) {
    return true;
  }
  return /^[A-Za-z]{1,3}$/u.test(primary.text) && fallback.text.length > primary.text.length;
}

async function ocrCandidate(imagePath, language, psm, variant = `psm-${psm}`, profile) {
  return parseTesseractTsv(
    await run("tesseract", [imagePath, "stdout", "-l", language, "--psm", psm, "tsv"]),
    variant,
    profile,
  );
}

async function transformImage(imagePath, suffix, args) {
  const outputPath = join(
    dirname(imagePath),
    `${basename(imagePath, extname(imagePath))}-${suffix}.png`,
  );
  await run("magick", [imagePath, ...args, `PNG24:${outputPath}`]);
  return outputPath;
}

async function thresholdDilatePath(imagePath) {
  return transformImage(imagePath, "threshold-dilate", [
    "-colorspace",
    "Gray",
    "-threshold",
    "94%",
    "-morphology",
    "Dilate",
    "Disk:1",
  ]);
}

/**
 * Some discs render subtitles as a light fill over a darker offset copy of
 * every glyph — a 3-D extrusion shadow. The shadow is a full copy, so its
 * area rivals the fill's and binarisation latches onto it instead of the
 * letters; on the first such disc in the corpus that read as 15.7% CER with
 * dropped cues. When the shadow is present, erase everything at or below the
 * tonal midpoint and binarise the remaining fill.
 *
 * Detection is structural, not tuned to a title: a shadow's dark ink mass is
 * comparable to the light fill's (measured dark/light ratio 1.2–1.3), while
 * an outline is a thin border at a fraction of it (0.5 on outlined fonts,
 * ~0.1 on plain ones). Outlined and plain tracks return null and are left
 * alone — stripping a mere outline measured slightly worse, not better.
 */
async function grayHistogram(imagePath) {
  const histogram = await run("magick", [
    imagePath,
    "-colorspace",
    "Gray",
    "-format",
    "%c",
    "histogram:info:",
  ]);
  const bins = new Array(256).fill(0);
  for (const match of histogram.matchAll(/^\s*(\d+): \((\d+),/gmu)) {
    bins[Number(match[2])] += Number(match[1]);
  }
  return bins;
}

async function shadowStripPath(imagePath, bins) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  const background = bins.slice(250).reduce((sum, count) => sum + count, 0);
  // Only the light-ink-on-white rendering our decoders produce is understood
  // here; a dark or busy background means the assumptions below are wrong.
  if (!total || background < total * 0.4) return null;

  let darkMass = 0;
  let darkPeak = 0;
  let lightMass = 0;
  let lightPeak = 128;
  for (let value = 0; value <= 127; value += 1) {
    darkMass += bins[value];
    if (bins[value] > bins[darkPeak]) darkPeak = value;
  }
  for (let value = 128; value <= 249; value += 1) {
    lightMass += bins[value];
    if (bins[value] > bins[lightPeak]) lightPeak = value;
  }

  if (lightMass < 100 || darkMass < lightMass * 0.85) return null;
  // A fill this close to the background leaves no band to select.
  if (lightPeak - darkPeak < 64 || lightPeak > 235) return null;

  const low = Math.round(((darkPeak + lightPeak) / 2 / 255) * 100);
  const high = Math.round(((lightPeak + 255) / 2 / 255) * 100);
  // Keep only pixels between the two thresholds (the fill), as black on white.
  return transformImage(imagePath, "shadow-strip", [
    "-colorspace",
    "Gray",
    "(",
    "-clone",
    "0",
    "-threshold",
    `${low}%`,
    ")",
    "(",
    "-clone",
    "0",
    "-threshold",
    `${high}%`,
    "-negate",
    ")",
    "-delete",
    "0",
    "-compose",
    "multiply",
    "-composite",
    "-negate",
  ]);
}

/**
 * DVD subtitles draw a bright fill inside a dark outline over whatever tone
 * the player composes behind them — on the corpus's worst title that is a
 * mid-grey band, leaving 41 luminance levels between fill and background
 * against the outline's 190. Global binarisation then keeps the outline
 * blobs, and whole lines read as garbage ("Don't just stand there." came
 * back as "Donrt just staiel tinea,"). The fill is the brightest tonal
 * cluster, so select it alone: threshold midway between the fill peak and
 * the next tone below, drop everything else.
 *
 * When the brightest tone dominates the image it is a background, not a
 * fill — a white-backed frame from the PGS renderer, say — and there is
 * nothing to select; those return null and are handled by the other
 * variants.
 */
async function fillSelectPath(imagePath, bins) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const significant = Math.max(50, total * 0.005);

  let fillPeak = -1;
  for (let value = 255; value >= 64; value -= 1) {
    if (bins[value] >= significant) {
      fillPeak = value;
      break;
    }
  }
  if (fillPeak === -1) return null;

  // The fill cluster spans the anti-aliased shoulder just under its peak.
  let clusterLow = fillPeak;
  let clusterMass = 0;
  while (clusterLow >= 0 && (bins[clusterLow] >= significant || fillPeak - clusterLow < 8)) {
    clusterMass += bins[clusterLow];
    clusterLow -= 1;
  }
  if (clusterMass > total * 0.35) return null;

  let nextPeak = -1;
  for (let value = clusterLow; value >= 0; value -= 1) {
    if (bins[value] >= significant) {
      nextPeak = value;
      break;
    }
  }
  if (nextPeak === -1 || fillPeak - nextPeak < 24) return null;

  const threshold = Math.round(((fillPeak + nextPeak) / 2 / 255) * 100);
  return transformImage(imagePath, "fill-select", [
    "-colorspace",
    "Gray",
    "-threshold",
    `${threshold}%`,
    "-negate",
  ]);
}

/**
 * Some DVD tracks draw glyphs hollow: a thin dark contour whose interior is
 * the same tone as the band behind it. No threshold can separate that fill
 * from the background (they are the same colour), and connectivity cannot
 * either — any letter tall enough to poke out of the band has its contour
 * merge with the surrounding dark region, which is why flood-fill repairs
 * kept eating exactly the capitals and descenders. The invariant that
 * survives is scale: stroke interiors are small enclosed islands, the band
 * is enormous. Upscale, binarise, and keep only the white components small
 * enough to be letter innards; their union is the solid text.
 *
 * Triggered only on (near-)bilevel frames: hollow rendering has no mid
 * tones, while every anti-aliased rendering does. The area cutoff is
 * calibrated to the fixed 400% upscale.
 */
async function hollowFillPath(imagePath, bins) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  let extremes = 0;
  let white = 0;
  for (let value = 0; value <= 16; value += 1) extremes += bins[value];
  for (let value = 240; value <= 255; value += 1) {
    extremes += bins[value];
    white += bins[value];
  }
  if (extremes < total * 0.97) return null;
  if (white < total * 0.02 || white > total * 0.5) return null;

  const scaled = await transformImage(imagePath, "hollow-scale", [
    "-colorspace",
    "Gray",
    "-resize",
    "400%",
    "-threshold",
    "55%",
  ]);
  return transformImage(scaled, "hollow-fill", [
    "(",
    "-clone",
    "0",
    "-define",
    "connected-components:area-threshold=6000",
    "-define",
    "connected-components:mean-color=true",
    "-connected-components",
    "8",
    ")",
    "-compose",
    "difference",
    "-composite",
    "-negate",
    // The reconstructed cores are the stroke interiors only — thinner than
    // the letters they came from. A slight thickening reads better.
    "-morphology",
    "Erode",
    "Disk:1.5",
  ]);
}

export function createTesseractHybridEngine(options = {}) {
  const alwaysTryThreshold = options.alwaysTryThreshold ?? false;
  const profile = options.textCleanup ?? "generic";

  return {
    name: alwaysTryThreshold ? "tesseract-accurate" : "tesseract-hybrid",
    requiredBinaries: ["tesseract", "magick"],
    async recognize(imagePath, { language = "eng" } = {}) {
      const started = performance.now();
      const candidates = await Promise.all(
        ["6", "11"].map((psm) => ocrCandidate(imagePath, language, psm, `psm-${psm}`, profile)),
      );
      let thresholdCandidate = null;
      if (alwaysTryThreshold) {
        const bins = await grayHistogram(imagePath);
        let repairCandidates = [];
        [thresholdCandidate, ...repairCandidates] = await Promise.all([
          thresholdDilatePath(imagePath).then((path) =>
            ocrCandidate(path, language, "6", "threshold-dilate-psm-6", profile),
          ),
          ...[
            ["shadow-strip-psm-6", shadowStripPath],
            ["fill-select-psm-6", fillSelectPath],
            ["hollow-fill-psm-6", hollowFillPath],
          ].map(([variant, repair]) =>
            repair(imagePath, bins).then((path) =>
              path ? ocrCandidate(path, language, "6", variant, profile) : null,
            ),
          ),
        ]);
        if (isThresholdDilateFallback(thresholdCandidate)) {
          candidates.push(thresholdCandidate);
        }
        // Repairs compete on score like every candidate: where the direct
        // reads are damaged they come back 15+ confidence points lower than
        // the repaired image's read, so the repair wins exactly where it
        // should and loses everywhere else.
        for (const repairCandidate of repairCandidates) {
          if (repairCandidate && isUsableFallback(repairCandidate)) {
            candidates.push(repairCandidate);
          }
        }
      }
      candidates.sort((left, right) => candidateScore(right) - candidateScore(left));

      let selected = candidates[0];
      if (
        selected.text &&
        alwaysTryThreshold &&
        thresholdCandidate &&
        shouldPreferThresholdDilate(selected, thresholdCandidate)
      ) {
        selected = thresholdCandidate;
      }
      if (!selected.text) {
        const [resize2Path, grayAutoPath, thresholdPath] = await Promise.all([
          transformImage(imagePath, "resize2", ["-resize", "200%"]),
          transformImage(imagePath, "gray-auto", [
            "-colorspace",
            "Gray",
            "-auto-level",
          ]),
          thresholdCandidate ? null : thresholdDilatePath(imagePath),
        ]);
        const fallbackCandidates = (await Promise.all([
          ocrCandidate(imagePath, language, "10", "psm-10", profile),
          thresholdCandidate ??
            ocrCandidate(thresholdPath, language, "6", "threshold-dilate-psm-6", profile),
          ocrCandidate(resize2Path, language, "7", "resize2-psm-7", profile),
          ocrCandidate(resize2Path, language, "13", "resize2-psm-13", profile),
          ocrCandidate(grayAutoPath, language, "6", "gray-auto-psm-6", profile),
          ocrCandidate(grayAutoPath, language, "13", "gray-auto-psm-13", profile),
          ocrCandidate(imagePath, language, "13", "psm-13", profile),
        ])).filter((candidate) =>
          candidate.variant === "psm-10"
            ? isHighPrecisionSingleLineFallback(candidate)
            : candidate.variant === "threshold-dilate-psm-6"
              ? isThresholdDilateFallback(candidate)
            : isUsableFallback(candidate),
        );

        fallbackCandidates.sort(
          (left, right) => candidateScore(right) - candidateScore(left),
        );
        candidates.push(...fallbackCandidates);
        selected = fallbackCandidates[0] ?? selected;
      } else if (!alwaysTryThreshold && isWeakPrimaryCandidate(selected, imagePath)) {
        thresholdCandidate = await ocrCandidate(
          await thresholdDilatePath(imagePath),
          language,
          "6",
          "threshold-dilate-psm-6",
          profile,
        );
        candidates.push(thresholdCandidate);
        if (shouldPreferThresholdDilate(selected, thresholdCandidate)) {
          selected = thresholdCandidate;
        }
      }

      return {
        text: selected.text,
        confidence: selected.confidence,
        engine: alwaysTryThreshold ? "tesseract-accurate" : "tesseract-hybrid",
        model: "tesseract",
        variant: selected.variant,
        durationMs: Math.round(performance.now() - started),
        warnings: selected.text ? [] : ["blank-result"],
        candidates,
      };
    },
  };
}

export function createOcrEngine(name = "auto", options = {}) {
  const textCleanup = options.textCleanup ?? "generic";
  if (!textCleanupProfiles.has(textCleanup)) {
    throw new Error(`Unknown text cleanup profile: ${textCleanup}`);
  }

  if (name === "auto") {
    if (options.mode === "subidx-to-srt" && isMacosVisionAvailable()) {
      return createMacosVisionEngine({ textCleanup });
    }
    // For SUP the engines' order of merit depends on the track's rendering
    // style, not the flow: tuned Tesseract wins narrowly on clean outlined
    // fonts and loses catastrophically on shadowed ones (15.7% vs 2.2% CER on
    // Stargate). Where Vision exists, probe the track and let the result pick.
    if (options.mode === "sup-to-srt" && isMacosVisionAvailable()) {
      return createSupProbeEngine({
        defaultEngine: createTesseractHybridEngine({
          alwaysTryThreshold: true,
          textCleanup,
        }),
        challengerEngine: createMacosVisionEngine({ textCleanup }),
      });
    }
    return createTesseractHybridEngine({ alwaysTryThreshold: true, textCleanup });
  }
  if (name === "tesseract-accurate") {
    return createTesseractHybridEngine({ alwaysTryThreshold: true, textCleanup });
  }
  if (name === "tesseract" || name === "tesseract-hybrid") {
    return createTesseractHybridEngine({ textCleanup });
  }
  if (name === "external-command") {
    return createExternalCommandEngine(
      options.ocrCommand ?? process.env.SUBTITLE_WORKBENCH_OCR_COMMAND,
      { textCleanup },
    );
  }
  if (name === "macos-vision") {
    if (process.platform !== "darwin") {
      throw new Error(
        "macos-vision OCR is only available on macOS. Use auto, tesseract-accurate, or tesseract-hybrid on this system.",
      );
    }
    return createMacosVisionEngine({ textCleanup });
  }
  throw new Error(`Unknown OCR engine: ${name}`);
}

export function availableOcrEngines() {
  return [
    "auto",
    ...(isMacosVisionAvailable() ? ["macos-vision"] : []),
    "tesseract-accurate",
    "tesseract-hybrid",
    "external-command",
  ];
}
