// The SUP engine choice used to be static: tesseract-accurate, chosen on a
// corpus that was entirely one show. The first held-out titles showed why that
// was fragile — on Stargate's bold font with a thick same-grey extrusion
// shadow, Tesseract hit 15.7% CER and dropped cues while Vision read the same
// bitmaps at 2.2%. On clean outlined fonts (Stranger Things, The Matrix) the
// order reverses, by a much smaller margin. So the rendering style of the
// track, not the flow, is what should pick the engine — and the only way to
// see the style is to look at the track itself.
//
// The probe OCRs a small spread of frames with both engines and keeps the one
// whose *text* looks healthier. It never sees reference subtitles; the score
// below is the stand-in for ground truth.

// Common English words, weighted toward function words because that is what
// subtitle dialogue is made of — and exactly what shadow damage corrupts
// (`What`→`Whet`, `was`→`wes`, `that`→`thet`). A misread content word keeps a
// plausible shape and scores 0.5 either way; a misread function word falls out
// of this set and the score drops. That asymmetry is the signal.
const COMMON_WORDS = new Set(
  (
    "the be to of and a in that have i it for not on with he as you do at " +
    "this but his by from they we say her she or an will my one all would " +
    "there their what so up out if about who get which go me when make can " +
    "like time no just him know take into your good some could them see " +
    "other than then now look only come its over think also back after use " +
    "two how our work first well way even new want because any these give " +
    "day most us is are was were been has had did does said got don't " +
    "can't won't didn't doesn't isn't wasn't couldn't wouldn't shouldn't " +
    "it's i'm i'll i've you're you'll that's what's let's we're we'll " +
    "they're he's she's there's here's who's where's ain't gonna gotta " +
    "here where why yes okay right sorry please thank thanks hello hey " +
    "man sir oh no yeah um uh mr mrs dr never really something nothing " +
    "everything anything someone everyone anyone been being going came " +
    "went tell told still much more very too again down off away need " +
    "help stop wait little long people year years"
  ).split(/\s+/),
);

function tokenScore(rawToken) {
  // Strip surrounding punctuation but keep internal apostrophes: "don't,"
  // must land in the word set, while "i?s" must not.
  const bare = rawToken
    .toLowerCase()
    .replace(/^[^a-z0-9']+/u, "")
    .replace(/'+$/u, "")
    .replace(/[^a-z0-9']+$/u, "");
  if (!bare) return null;
  if (COMMON_WORDS.has(bare)) return 1;
  if (/^\d+(?:[.,:]\d+)*$/u.test(bare)) return 0.75;
  if (/^[a-z]+(?:'[a-z]+)?$/u.test(bare)) return 0.5;
  // Digits jammed into a word, stray symbols, multiple apostrophes: the
  // shapes OCR garbage takes and dialogue does not.
  return 0;
}

/**
 * 0..1 estimate of how much a piece of OCR output looks like real subtitle
 * text, with no reference to compare against. Returns null for empty text so
 * callers can treat "read nothing" separately from "read badly".
 */
export function scoreOcrText(text) {
  const tokens = (text ?? "")
    .split(/\s+/u)
    .map(tokenScore)
    .filter((score) => score !== null);
  if (!tokens.length) return null;
  return tokens.reduce((sum, score) => sum + score, 0) / tokens.length;
}

/**
 * Evenly spread sample of up to `count` items, always including the first and
 * last. Deterministic: the probe must pick the same engine on every run over
 * the same track.
 */
export function sampleEvenly(items, count) {
  if (items.length <= count) return [...items];
  const sampled = [];
  const step = (items.length - 1) / (count - 1);
  for (let index = 0; index < count; index += 1) {
    sampled.push(items[Math.round(index * step)]);
  }
  return [...new Set(sampled)];
}

/**
 * Score one engine's probe results as a whole. A blank counts as 0 only when
 * the image is readable (`readableIndices`) — i.e. some engine got text from
 * it — so genuinely blank frames don't drag both engines down equally, while
 * an engine that drops cues the other can read is penalised.
 */
function aggregateScore(results, readableIndices) {
  if (!readableIndices.length) return 0;
  let total = 0;
  for (const index of readableIndices) {
    total += scoreOcrText(results[index]?.text) ?? 0;
  }
  return total / readableIndices.length;
}

/**
 * Pure decision logic, separated from process-spawning so it can be tested on
 * canned results. Two independent signals must both fire before the default
 * engine is abandoned:
 *
 *  - the challenger's text must look healthier by `margin`, and
 *  - the default engine's own mean confidence must sit below
 *    `confidenceFloor` — it has to be self-reporting a struggle.
 *
 * Requiring both means noise in one signal cannot flip a healthy track to the
 * challenger; on a genuine rendering-style failure both move together and far
 * (see the calibration constants below).
 */
export function chooseEngineByProbe(
  defaultResults,
  challengerResults,
  { margin, confidenceFloor },
) {
  const readableIndices = [];
  for (let index = 0; index < defaultResults.length; index += 1) {
    if (defaultResults[index]?.text || challengerResults[index]?.text) {
      readableIndices.push(index);
    }
  }
  const defaultScore = aggregateScore(defaultResults, readableIndices);
  const challengerScore = aggregateScore(challengerResults, readableIndices);
  const defaultConfidence = readableIndices.length
    ? readableIndices.reduce(
        (sum, index) => sum + (defaultResults[index]?.confidence ?? 0),
        0,
      ) / readableIndices.length
    : 0;
  return {
    useChallenger:
      challengerScore > defaultScore + margin &&
      defaultConfidence < confidenceFloor,
    defaultScore,
    challengerScore,
    defaultConfidence,
    sampledReadable: readableIndices.length,
  };
}

// Calibrated by running the real 24-frame probe on five tracks (frozen in
// tests/ocr-engine-probe.test.mjs). The two bands are far apart on both axes:
//
//                          score delta (vision − tess)   tess confidence
//   clean outlined fonts       −0.005 … 0.000               95.0 … 95.2
//   shadowed font (Stargate)   +0.047 … +0.060              81.0 … 81.7
//
// Each threshold sits midway between its bands. When the engines are equally
// healthy the default (Tesseract) wins the tie deliberately: it measured
// slightly better on clean fonts and is the only engine that exists off macOS.
const SCORE_MARGIN = 0.025;
const CONFIDENCE_FLOOR = 88;
const PROBE_SAMPLE_COUNT = 24;

/**
 * The `auto` SUP engine on macOS. Behaves as the default engine until
 * `selectEngine` has probed the track; the conversion pipeline calls that once
 * per input file, after frame extraction and dedup. The two engines are
 * passed in (rather than constructed here) so this module stays free of
 * process-spawning imports and the decision logic can be tested with fakes.
 */
export function createSupProbeEngine({ defaultEngine, challengerEngine }) {
  return {
    name: "auto-probe",
    // The union: the probe runs both engines before choosing one.
    requiredBinaries: [
      ...defaultEngine.requiredBinaries,
      ...challengerEngine.requiredBinaries,
    ],

    async selectEngine(imagePaths, { language = "eng", jobs = 4 } = {}) {
      // The score's word list is English. Without it the probe cannot tell a
      // bad reading from a good one, so other languages keep the default.
      if (!/^eng?$/u.test(language)) {
        return { engine: defaultEngine, probed: false, reason: "non-english" };
      }

      const sample = sampleEvenly(imagePaths, PROBE_SAMPLE_COUNT);

      const defaultResults = new Array(sample.length);
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < sample.length) {
          const index = nextIndex;
          nextIndex += 1;
          defaultResults[index] = await defaultEngine.recognize(sample[index], {
            language,
          });
        }
      }
      let challengerResults;
      try {
        [challengerResults] = await Promise.all([
          challengerEngine.recognizeBatch(sample, { language }),
          Promise.all(
            Array.from({ length: Math.min(jobs, sample.length) }, () => worker()),
          ),
        ]);
      } catch (error) {
        // A challenger that cannot run must not kill the whole conversion —
        // this is reachable on a Mac where swiftc exists (so preflight passes)
        // but the Vision build fails (Xcode CLT without an SDK, unaccepted
        // licence). The default engine would have converted the track fine, so
        // fall back to it and say why.
        process.stderr.write(
          `Engine probe failed (${error.message}); continuing with ${defaultEngine.name}.\n`,
        );
        return { engine: defaultEngine, probed: false, reason: "probe-failed" };
      }

      const decision = chooseEngineByProbe(defaultResults, challengerResults, {
        margin: SCORE_MARGIN,
        confidenceFloor: CONFIDENCE_FLOOR,
      });
      return {
        engine: decision.useChallenger ? challengerEngine : defaultEngine,
        probed: true,
        sampled: sample.length,
        sampledReadable: decision.sampledReadable,
        defaultScore: decision.defaultScore,
        defaultConfidence: decision.defaultConfidence,
        challengerScore: decision.challengerScore,
      };
    },

    // Callers that never probe (or before probing) get the previous default.
    recognize: (imagePath, options) => defaultEngine.recognize(imagePath, options),
  };
}
