import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "./png.mjs";
import { isUsableImage, scanDisplaySets, SEGMENT } from "./pgs-decoder.mjs";

/**
 * Node-side PGS extraction: decode with the shared decoder, sink to PNG.
 * The decoding itself lives in lib/pgs-decoder.mjs so the browser preview
 * cannot drift away from what OCR actually receives.
 */

async function writePng(image, outputPath) {
  // Encoded in process. This used to write a PPM and spawn ImageMagick to
  // convert it, once per cue, synchronously — so decoding a 668-cue track meant
  // 668 blocking process spawns on a single core before OCR could start.
  await writeFile(outputPath, encodePng(image));
}

/**
 * Counts display sets without rendering, so a caller can tell "this is not a
 * PGS file" apart from "this is a PGS file containing nothing visible".
 * Blank forced/overlay tracks are real and legitimately produce no cues.
 */
export async function countPgsDisplaySets(inputPath) {
  const data = await readFile(inputPath);
  let offset = 0;
  let displaySets = 0;

  while (offset + 13 <= data.length) {
    if (data[offset] !== 0x50 || data[offset + 1] !== 0x47) {
      offset += 1;
      continue;
    }
    const length = (data[offset + 11] << 8) | data[offset + 12];
    if (data[offset + 10] === SEGMENT.END) displaySets += 1;
    offset += 13 + length;
  }

  return displaySets;
}

export async function extractPgsPreviewImages(inputPath, outputDirectory, count = 3) {
  const data = await readFile(inputPath);
  await mkdir(outputDirectory, { recursive: true });

  const pending = [];
  scanDisplaySets(data, (image, pts) => {
    if (pending.length >= count) return false;

    if (isUsableImage(image)) {
      // Every cue ends at the next display set, whether that is a clear or the
      // following cue. Only the last output used to receive an end time, and a
      // content display set that failed to render was misread as a clear.
      const previous = pending[pending.length - 1];
      if (previous && !previous.endPts && pts > previous.pts) previous.endPts = pts;
      pending.push({ image, pts });
    } else if (pending.length) {
      const last = pending[pending.length - 1];
      if (!last.endPts && pts > last.pts) last.endPts = pts;
    }
    return true;
  });

  const outputs = [];
  for (const [index, item] of pending.entries()) {
    const outputPath = join(
      outputDirectory,
      `preview-${String(index + 1).padStart(6, "0")}.png`,
    );
    await writePng(item.image, outputPath);
    outputs.push({
      path: outputPath,
      pts: item.pts,
      endPts: item.endPts,
      width: item.image.width,
      height: item.image.height,
    });
  }

  return outputs;
}

function secondsForFilename(seconds) {
  return String(Math.round(seconds * 1000)).padStart(10, "0");
}

function nearestUnmatchedTarget(targets, pts, toleranceSeconds) {
  let nearest = null;
  for (const target of targets) {
    if (target.matched) continue;
    const delta = Math.abs(target.start - pts);
    if (delta > toleranceSeconds) continue;
    if (!nearest || delta < nearest.delta) {
      nearest = { target, delta };
    }
  }
  return nearest;
}

export async function extractPgsImagesAtTimes(
  inputPath,
  outputDirectory,
  starts,
  options = {},
) {
  // NaN would disable the check entirely (every comparison with NaN is false),
  // silently matching the globally nearest cue instead of erroring.
  const requested = Number(options.toleranceSeconds ?? 0.08);
  const toleranceSeconds = Number.isFinite(requested) ? requested : 0.08;

  const targets = starts.map((start, index) => ({ index, start, matched: null }));
  const data = await readFile(inputPath);
  await mkdir(outputDirectory, { recursive: true });

  const pending = [];
  scanDisplaySets(data, (image, pts) => {
    if (!targets.some((target) => !target.matched)) return false;
    const match = nearestUnmatchedTarget(targets, pts, toleranceSeconds);
    if (image && match) {
      match.target.matched = { pts, delta: match.delta };
      pending.push({ image, pts, delta: match.delta, target: match.target });
    }
    return true;
  });

  const outputs = [];
  for (const item of pending) {
    const outputPath = join(
      outputDirectory,
      `cue-${String(item.target.index + 1).padStart(4, "0")}-${secondsForFilename(item.target.start)}.png`,
    );
    await writePng(item.image, outputPath);
    outputs.push({
      requestedStart: item.target.start,
      path: outputPath,
      pts: item.pts,
      delta: item.delta,
      width: item.image.width,
      height: item.image.height,
    });
  }

  return {
    images: outputs,
    unmatched: targets
      .filter((target) => !target.matched)
      .map((target) => ({ index: target.index, requestedStart: target.start })),
  };
}
