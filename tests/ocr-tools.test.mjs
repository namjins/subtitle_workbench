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
  ]);
  assert.equal(createOcrEngine("auto", { mode: "sup-to-srt" }).name, "tesseract-accurate");
  assert.equal(
    createOcrEngine("auto", { mode: "subidx-to-srt" }).name,
    isMacosVisionAvailable() ? "macos-vision" : "tesseract-accurate",
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
