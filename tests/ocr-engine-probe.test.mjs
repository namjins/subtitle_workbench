import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseEngineByProbe,
  createSupProbeEngine,
  sampleEvenly,
  scoreOcrText,
} from "../lib/ocr-engine-probe.mjs";

test("scores real subtitle text above shadow-damaged OCR of the same lines", () => {
  // Real pairs from the Stargate fixture: Tesseract reading a bold font with
  // a thick same-grey extrusion shadow, versus the reference. The damage
  // lands mostly on function words, which is what the word list is for.
  const pairs = [
    ["What have we here?", "Whet have we here?"],
    ["It's fantastic.", "i?s anksiie."],
    ["I wish I knew.", "Uwish I knew."],
    ["Looks like some kind of fossil.", "Looks Wke some kind of fosell."],
  ];
  for (const [clean, damaged] of pairs) {
    assert.ok(
      scoreOcrText(clean) > scoreOcrText(damaged),
      `expected "${clean}" to outscore "${damaged}"`,
    );
  }
});

test("treats empty text as unscorable, not as a zero", () => {
  assert.equal(scoreOcrText(""), null);
  assert.equal(scoreOcrText("   "), null);
  assert.equal(scoreOcrText(null), null);
  // "..." has no letters at all; there is nothing to judge.
  assert.equal(scoreOcrText("..."), null);
});

test("samples deterministically, keeping the first and last frames", () => {
  const items = Array.from({ length: 100 }, (_, index) => `frame-${index}`);
  const sample = sampleEvenly(items, 24);
  assert.equal(sample.length, 24);
  assert.equal(sample[0], "frame-0");
  assert.equal(sample.at(-1), "frame-99");
  assert.deepEqual(sample, sampleEvenly(items, 24));

  // Fewer items than the sample size: take everything, once.
  assert.deepEqual(sampleEvenly(["a", "b"], 24), ["a", "b"]);
});

// The bands below are frozen from running the real 24-frame probe over five
// local tracks (2026-08-07). They are what SCORE_MARGIN and CONFIDENCE_FLOOR
// in lib/ocr-engine-probe.mjs were calibrated between:
//
//   track                        score delta   default confidence
//   Stranger Things S1D1 t00        0.000            95.1
//   Stranger Things S3D2 t00       -0.004            95.0
//   The Matrix                     -0.005            95.2
//   Stargate                       +0.060            81.7
//   Stargate1                      +0.047            81.0
const thresholds = { margin: 0.025, confidenceFloor: 88 };

function result(text, confidence) {
  return { text, confidence };
}

test("keeps the default engine when both bands say the track is healthy", () => {
  // Clean-band shape: near-identical text, high default confidence.
  const defaults = [
    result("I found something beautiful.", 95),
    result("What have we here?", 96),
  ];
  const challenger = [
    result("I found something beautiful.", 100),
    result("What have we here?", 100),
  ];
  const decision = chooseEngineByProbe(defaults, challenger, thresholds);
  assert.equal(decision.useChallenger, false);
});

test("switches engines only when both signals fire together", () => {
  const damaged = [
    result("Whet have we here?", 81),
    result("i?s anksiie.", 78),
    result("Uwish I knew.", 84),
  ];
  const healthy = [
    result("What have we here?", 100),
    result("It's fantastic.", 100),
    result("I wish I knew.", 100),
  ];

  // Shadow-band shape: challenger reads better and the default self-reports
  // low confidence.
  assert.equal(chooseEngineByProbe(damaged, healthy, thresholds).useChallenger, true);

  // Same damaged text but confident: text advantage alone must not switch —
  // one noisy signal is not allowed to flip a track.
  const confidentDamaged = damaged.map(({ text }) => result(text, 95));
  assert.equal(
    chooseEngineByProbe(confidentDamaged, healthy, thresholds).useChallenger,
    false,
  );

  // Low confidence but no text advantage: also stay.
  const shakyButRight = healthy.map(({ text }) => result(text, 80));
  assert.equal(
    chooseEngineByProbe(shakyButRight, healthy, thresholds).useChallenger,
    false,
  );
});

test("counts cues the default engine dropped against it", () => {
  // Blanks on frames the challenger can read score 0 for the default; frames
  // neither engine reads are excluded rather than dragging both down.
  const defaults = [result("", 0), result("", 0), result("", 0)];
  const challenger = [
    result("You should not have opened the gate.", 100),
    result("Give my regards to King Tut.", 100),
    result("", 0),
  ];
  const decision = chooseEngineByProbe(defaults, challenger, thresholds);
  assert.equal(decision.sampledReadable, 2);
  assert.equal(decision.defaultScore, 0);
  assert.equal(decision.useChallenger, true);
});

function fakeEngine(name, text, confidence) {
  return {
    name,
    requiredBinaries: [name],
    recognize: async () => ({ text, confidence }),
    recognizeBatch: async (paths) => paths.map(() => ({ text, confidence })),
  };
}

test("probe engine selects by reading frames and reports what it saw", async () => {
  const struggling = fakeEngine("struggling", "i?s anksiie. thet wes", 70);
  const fluent = fakeEngine("fluent", "It's fantastic. That was", 100);
  const probe = createSupProbeEngine({
    defaultEngine: struggling,
    challengerEngine: fluent,
  });

  assert.deepEqual(probe.requiredBinaries, ["struggling", "fluent"]);

  const selection = await probe.selectEngine(["a.png", "b.png"], { language: "eng" });
  assert.equal(selection.probed, true);
  assert.equal(selection.engine.name, "fluent");
  assert.equal(selection.sampled, 2);
  assert.ok(selection.challengerScore > selection.defaultScore);
});

test("probe engine keeps the default for non-English tracks", async () => {
  // The health score's word list is English; without it the probe cannot
  // tell a bad reading from a good one, so it must not pretend to.
  const defaultEngine = fakeEngine("default", "irrelevant", 50);
  const probe = createSupProbeEngine({
    defaultEngine,
    challengerEngine: fakeEngine("challenger", "irrelevant", 100),
  });

  const selection = await probe.selectEngine(["a.png"], { language: "deu" });
  assert.equal(selection.probed, false);
  assert.equal(selection.engine, defaultEngine);
});

test("probe engine recognises with the default before any selection", async () => {
  const defaultEngine = fakeEngine("default", "Hello there.", 90);
  const probe = createSupProbeEngine({
    defaultEngine,
    challengerEngine: fakeEngine("challenger", "Hello there.", 100),
  });
  const recognised = await probe.recognize("a.png", { language: "eng" });
  assert.equal(recognised.text, "Hello there.");
});
