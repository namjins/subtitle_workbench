import { readFile } from "node:fs/promises";

export function parseSrtTime(value) {
  const match = String(value ?? "").match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/u);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000
  );
}

export function parseSrtText(source) {
  const clean = source.replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if (!clean) return [];

  return clean
    .split(/\n\n+/)
    .map((block, index) => {
      // Accept "-->" without the surrounding spaces: our own converter accepts
      // that form on input, so refusing it here made a valid file benchmark as
      // zero cues.
      const timing = block.split("\n").find((line) => line.includes("-->"));
      const lines = block.split("\n");
      if (!timing) return null;
      const [startRaw, endRaw] = timing.split("-->");
      const start = parseSrtTime(startRaw?.trim());
      const end = parseSrtTime(endRaw?.trim().split(/\s+/u)[0]);
      if (start === null || end === null) return null;
      const cueNumber = Number(lines[0]);
      return {
        index,
        number: Number.isFinite(cueNumber) ? cueNumber : index + 1,
        start,
        end,
        timing,
        text: lines.slice(lines.indexOf(timing) + 1).join("\n").trim(),
      };
    })
    .filter(Boolean);
}

export async function parseSrtFile(path) {
  return parseSrtText(await readFile(path, "utf8"));
}

export function levenshtein(left, right) {
  const columns = right.length;
  let previous = Array.from({ length: columns + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= columns; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[columns];
}

/**
 * Pairs reference and candidate cues once, greedily by nearest start time,
 * and never reuses a candidate.
 *
 * The previous code called a plain `.find` three separate times over the same
 * arrays, so a single candidate could satisfy several reference cues: it was
 * scored repeatedly, all of those references were excluded from `missing`, and
 * the resulting counts did not add up. That directly weakened the quality gate
 * this module exists to enforce.
 */
function pairCues(reference, candidate, toleranceSeconds) {
  // Two-pointer over start-sorted copies. parseSrtText preserves file order
  // and never sorts, and a greedy nearest match cannot short-circuit the way
  // `.find` did, so sorting first keeps this linear over 26k cues.
  const references = [...reference].sort((left, right) => left.start - right.start);
  const candidates = [...candidate].sort((left, right) => left.start - right.start);

  const pairs = new Map();
  const usedCandidates = new Set();
  let cursor = 0;

  for (const referenceCue of references) {
    while (
      cursor < candidates.length &&
      candidates[cursor].start < referenceCue.start - toleranceSeconds
    ) {
      cursor += 1;
    }

    let best = null;
    let bestDelta = Infinity;
    for (let index = cursor; index < candidates.length; index += 1) {
      const candidateCue = candidates[index];
      const delta = candidateCue.start - referenceCue.start;
      if (delta > toleranceSeconds) break;
      if (usedCandidates.has(candidateCue)) continue;
      const distance = Math.abs(delta);
      // On an exact tie the earlier candidate wins, which keeps duplicate-start
      // cues paired in file order instead of collapsing onto one another.
      if (distance < bestDelta) {
        best = candidateCue;
        bestDelta = distance;
      }
    }

    if (best) {
      pairs.set(referenceCue, best);
      usedCandidates.add(best);
    }
  }

  return { pairs, usedCandidates };
}

function textSimilarity(left, right) {
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;
  return 1 - levenshtein(left, right) / maxLength;
}

function findShiftedTextMatches(missing, candidate, options) {
  const windowSeconds = options.shiftWindowSeconds ?? 3;
  const minimumSimilarity = options.shiftMinimumSimilarity ?? 0.92;
  return missing
    .map((referenceCue) => {
      const candidates = candidate
        .map((candidateCue) => {
          const shiftSeconds = candidateCue.start - referenceCue.start;
          const absShiftSeconds = Math.abs(shiftSeconds);
          if (!referenceCue.text || absShiftSeconds > windowSeconds) return null;
          const similarity = textSimilarity(referenceCue.text, candidateCue.text);
          if (similarity < minimumSimilarity) return null;
          return {
            reference: referenceCue,
            candidate: candidateCue,
            shiftSeconds,
            absShiftSeconds,
            textSimilarity: similarity,
          };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (right.textSimilarity !== left.textSimilarity) {
            return right.textSimilarity - left.textSimilarity;
          }
          return left.absShiftSeconds - right.absShiftSeconds;
        });
      return candidates[0] ?? null;
    })
    .filter(Boolean);
}

export function compareSrt(reference, candidate, options = {}) {
  const toleranceSeconds = options.toleranceSeconds ?? 0.04;
  // One pairing drives every figure below, so missing, extra and the per-cue
  // scoring can no longer disagree with each other.
  const { pairs, usedCandidates } = pairCues(reference, candidate, toleranceSeconds);
  const missing = reference.filter((cue) => !pairs.has(cue));
  const extra = candidate.filter((cue) => !usedCandidates.has(cue));
  const endMismatches = [];
  const textMismatches = [];
  let exactTextMatches = 0;
  let textEditDistance = 0;
  let referenceCharacters = 0;

  for (const referenceCue of reference) {
    const candidateCue = pairs.get(referenceCue);
    if (!candidateCue) {
      textEditDistance += referenceCue.text.length;
      referenceCharacters += referenceCue.text.length;
      continue;
    }

    if (Math.abs(candidateCue.end - referenceCue.end) > toleranceSeconds) {
      endMismatches.push({ reference: referenceCue, candidate: candidateCue });
    }
    if (candidateCue.text === referenceCue.text) {
      exactTextMatches += 1;
    }
    const cueEditDistance = levenshtein(candidateCue.text, referenceCue.text);
    if (cueEditDistance > 0) {
      textMismatches.push({
        reference: referenceCue,
        candidate: candidateCue,
        editDistance: cueEditDistance,
        referenceCharacters: referenceCue.text.length,
        characterErrorRate: referenceCue.text.length
          ? cueEditDistance / referenceCue.text.length
          : 0,
      });
    }
    textEditDistance += cueEditDistance;
    referenceCharacters += referenceCue.text.length;
  }

  textMismatches.sort((left, right) => {
    if (right.editDistance !== left.editDistance) {
      return right.editDistance - left.editDistance;
    }
    return right.characterErrorRate - left.characterErrorRate;
  });
  const shiftedTextMatches = findShiftedTextMatches(missing, candidate, options);

  return {
    referenceCues: reference.length,
    candidateCues: candidate.length,
    missing,
    extra,
    endMismatches,
    textMismatches,
    shiftedTextMatches,
    exactTextMatches,
    textEditDistance,
    referenceCharacters,
    // Edit distance can exceed the reference length when the candidate
    // hallucinates a much longer line, so this is not bounded by 1. Reported
    // uncapped, but flagged, so a --max-cer threshold is not silently compared
    // against a number outside the 0..1 range it implies.
    characterErrorRate: referenceCharacters
      ? textEditDistance / referenceCharacters
      : 0,
    exceedsReferenceLength: textEditDistance > referenceCharacters,
  };
}

export async function compareSrtFiles(referencePath, candidatePath, options = {}) {
  return compareSrt(
    await parseSrtFile(referencePath),
    await parseSrtFile(candidatePath),
    options,
  );
}
