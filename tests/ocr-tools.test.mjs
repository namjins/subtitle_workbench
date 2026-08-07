import assert from "node:assert/strict";
import test from "node:test";
import {
  availableOcrEngines,
  cleanOcrText,
  createOcrEngine,
  isMacosVisionAvailable,
} from "../lib/ocr-tesseract.mjs";
import { compareSrt, parseSrtText } from "../lib/srt-metrics.mjs";

test("cleans common subtitle OCR artifacts conservatively", () => {
  assert.equal(cleanOcrText("-[growling]\n-[screaming]"), "- [growling]\n- [screaming]");
  assert.equal(cleanOcrText("sighs],"), "[sighs]");
  assert.equal(cleanOcrText("Ec."), "E...");
  assert.equal(cleanOcrText("f Every breath you take J"), "♪ Every breath you take ♪");
  assert.equal(cleanOcrText("| was here"), "I was here");
  assert.equal(cleanOcrText(".--Speak."), "...Speak.");
  assert.equal(cleanOcrText("..-even"), "...even");
  assert.equal(cleanOcrText("..-0f one"), "...of one");
  assert.equal(cleanOcrText("..-1 have"), "...I have");
  assert.equal(cleanOcrText("..-@8 your life"), "...as your life");
  assert.equal(cleanOcrText("...| Know you're good"), "...I know you're good");
  assert.equal(cleanOcrText("- | want him"), "- I want him");
  assert.equal(cleanOcrText("[Siren Blaring 1"), "[Siren Blaring]");
  assert.equal(cleanOcrText("['Speaking Chinese 1"), "[Speaking Chinese]");
  assert.equal(cleanOcrText("IGuard Shouting"), "[Guard Shouting");
  assert.equal(cleanOcrText("Have |?"), "Have |?");
  assert.equal(cleanOcrText("|--"), "");
  assert.equal(cleanOcrText("“Hi”"), '"Hi"');
  assert.equal(cleanOcrText("Oh."), "Oh.");
});

test("uses automatic OCR as the flow-aware default engine", () => {
  assert.deepEqual(availableOcrEngines(), [
    "auto",
    ...(isMacosVisionAvailable() ? ["macos-vision"] : []),
    "tesseract-accurate",
    "tesseract-hybrid",
    "external-command",
  ]);
  assert.equal(createOcrEngine("auto", { mode: "sup-to-srt" }).name, "tesseract-accurate");
  assert.equal(
    createOcrEngine("auto", { mode: "subidx-to-srt" }).name,
    isMacosVisionAvailable() ? "macos-vision" : "tesseract-accurate",
  );
});

test("requires a command for external OCR", () => {
  assert.throws(
    () => createOcrEngine("external-command", { ocrCommand: "" }),
    /requires --ocr-command/u,
  );
  assert.equal(
    createOcrEngine("external-command", { ocrCommand: "ocr-sidecar" }).name,
    "external-command",
  );
});

test("only allows macOS Vision OCR on macOS", () => {
  if (process.platform === "darwin") {
    assert.equal(createOcrEngine("macos-vision").name, "macos-vision");
  } else {
    assert.throws(
      () => createOcrEngine("macos-vision"),
      /only available on macOS/u,
    );
  }
});

test("compares SRT files by timestamp and text distance", () => {
  const reference = parseSrtText(`1
00:00:01,000 --> 00:00:02,000
Hello

2
00:00:03,000 --> 00:00:04,000
There
`);
  const candidate = parseSrtText(`1
00:00:01,000 --> 00:00:02,000
Hallo

2
00:00:05,000 --> 00:00:06,000
Extra
`);

  const result = compareSrt(reference, candidate);
  assert.equal(result.referenceCues, 2);
  assert.equal(result.candidateCues, 2);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].number, 2);
  assert.equal(result.extra.length, 1);
  assert.equal(result.exactTextMatches, 0);
  assert.equal(result.textEditDistance, 6);
  assert.equal(result.textMismatches.length, 1);
  assert.equal(result.textMismatches[0].editDistance, 1);
  assert.equal(result.textMismatches[0].reference.number, 1);
});

test("reports shifted same-text cues as a diagnostic", () => {
  const reference = parseSrtText(`1
00:00:01,000 --> 00:00:02,000
Hello
`);
  const candidate = parseSrtText(`1
00:00:03,000 --> 00:00:04,000
Hello
`);

  const result = compareSrt(reference, candidate, { shiftWindowSeconds: 3 });
  assert.equal(result.missing.length, 1);
  assert.equal(result.extra.length, 1);
  assert.equal(result.shiftedTextMatches.length, 1);
  assert.equal(result.shiftedTextMatches[0].shiftSeconds, 2);
  assert.equal(result.shiftedTextMatches[0].textSimilarity, 1);
});

test("never lets one candidate cue satisfy two reference cues", () => {
  // Two references inside the 40ms tolerance of a single candidate. The old
  // matcher used a plain .find per reference, so this candidate was counted
  // twice, both references were excluded from `missing`, and the totals no
  // longer reconciled with the cue counts.
  const reference = parseSrtText(
    [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "First",
      "",
      "2",
      "00:00:01,030 --> 00:00:02,030",
      "Second",
      "",
    ].join("\n"),
  );
  const candidate = parseSrtText(
    ["1", "00:00:01,010 --> 00:00:02,010", "First", ""].join("\n"),
  );

  const metrics = compareSrt(reference, candidate);

  assert.equal(metrics.referenceCues, 2);
  assert.equal(metrics.candidateCues, 1);
  assert.equal(metrics.missing.length, 1, "the unmatched reference must count as missing");
  assert.equal(metrics.extra.length, 0);
  // Pairing is the nearest reference, not simply the first.
  assert.equal(metrics.missing[0].text, "Second");
});

test("pairs duplicate-start cues in order rather than collapsing them", () => {
  const block = (index, text) =>
    [String(index), "00:00:05,000 --> 00:00:07,000", text, ""].join("\n");
  const reference = parseSrtText(`${block(1, "Top line")}\n${block(2, "Bottom line")}`);
  const candidate = parseSrtText(`${block(1, "Top line")}\n${block(2, "Bottom line")}`);

  const metrics = compareSrt(reference, candidate);

  assert.equal(metrics.missing.length, 0);
  assert.equal(metrics.extra.length, 0);
  assert.equal(metrics.exactTextMatches, 2);
});

test("parses cue timings written without spaces around the arrow", () => {
  const cues = parseSrtText(["1", "00:00:01,000-->00:00:02,000", "Tight", ""].join("\n"));

  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 2);
});
