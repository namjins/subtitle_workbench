import assert from "node:assert/strict";
import test from "node:test";
import { convertToSrt, outputNameFor } from "../lib/subtitle-core.mjs";

test("converts WebVTT cues to SRT", () => {
  const output = convertToSrt(
    `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello there
`,
    "sample.vtt",
  );

  assert.match(output, /1\n00:00:01,000 --> 00:00:03,500\nHello there/);
});

test("converts ASS dialogue to SRT", () => {
  const output = convertToSrt(
    `[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:02.00,0:00:04.00,Default,{\\i1}General Kenobi`,
    "sample.ass",
  );

  assert.match(output, /1\n00:00:02,000 --> 00:00:04,000\nGeneral Kenobi/);
});

test("converts MicroDVD frames using the requested frame rate", () => {
  const output = convertToSrt("{24}{48}One second in", "sample.sub", {
    fps: 24,
  });

  assert.match(output, /00:00:01,000 --> 00:00:02,000/);
});

test("creates SRT output names", () => {
  assert.equal(outputNameFor("movie.en.ass"), "movie.en.srt");
});
