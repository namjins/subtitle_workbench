import { readFile } from "node:fs/promises";

export function parseSrtTime(value) {
  const match = value.match(/^(\d+):(\d{2}):(\d{2}),(\d{3})$/);
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
      const lines = block.split("\n");
      const timing = lines.find((line) => line.includes(" --> "));
      if (!timing) return null;
      const [startRaw, endRaw] = timing.split(" --> ");
      const start = parseSrtTime(startRaw);
      const end = parseSrtTime(endRaw);
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

function findByStart(cues, start, toleranceSeconds) {
  return cues.find((cue) => Math.abs(cue.start - start) <= toleranceSeconds);
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
  const missing = reference.filter(
    (cue) => !findByStart(candidate, cue.start, toleranceSeconds),
  );
  const extra = candidate.filter(
    (cue) => !findByStart(reference, cue.start, toleranceSeconds),
  );
  const endMismatches = [];
  const textMismatches = [];
  let exactTextMatches = 0;
  let textEditDistance = 0;
  let referenceCharacters = 0;

  for (const referenceCue of reference) {
    const candidateCue = findByStart(candidate, referenceCue.start, toleranceSeconds);
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
    characterErrorRate: referenceCharacters
      ? textEditDistance / referenceCharacters
      : 0,
  };
}

export async function compareSrtFiles(referencePath, candidatePath, options = {}) {
  return compareSrt(
    await parseSrtFile(referencePath),
    await parseSrtFile(candidatePath),
    options,
  );
}
