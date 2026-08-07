import assert from "node:assert/strict";
import test from "node:test";
import { convertToSrt, outputNameFor, parseFps } from "../lib/subtitle-core.mjs";

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

test("converts ITT frame cues using fractional FPS and preserves line breaks", () => {
  const output = convertToSrt(
    `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:00:00:24" end="00:00:01:24">Hello &amp; welcome<br/>Line two</p>
    </div>
  </body>
</tt>`,
    "sample.itt",
    { fps: "24000/1001" },
  );

  assert.match(output, /00:00:01,001 --> 00:00:02,001/);
  assert.match(output, /Hello & welcome\nLine two/);
});

test("converts ITT duration cues and namespace-prefixed paragraphs", () => {
  const output = convertToSrt(
    `<tt:tt xmlns:tt="http://www.w3.org/ns/ttml">
  <tt:body>
    <tt:div>
      <tt:p begin="00:00:03.500" dur="1500ms">Duration cue</tt:p>
    </tt:div>
  </tt:body>
</tt:tt>`,
    "sample.itt",
  );

  assert.match(output, /00:00:03,500 --> 00:00:05,000/);
  assert.match(output, /Duration cue/);
});

test("parses decimal and fractional FPS values", () => {
  assert.equal(parseFps("25"), 25);
  assert.equal(parseFps("24000/1001").toFixed(3), "23.976");
  assert.equal(parseFps("nope"), 23.976);
});

test("creates SRT output names", () => {
  assert.equal(outputNameFor("movie.en.ass"), "movie.en.srt");
});
