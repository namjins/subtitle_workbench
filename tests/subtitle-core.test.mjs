import assert from "node:assert/strict";
import test from "node:test";
import {
  convertToSrt,
  outputNameFor,
  parseFps,
  toSrtDocument,
} from "../lib/subtitle-core.mjs";

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
  // An omitted rate still defaults; an unusable one is now an error rather
  // than a silent 23.976 that shifts every frame-based cue.
  assert.equal(parseFps(undefined), 23.976);
  assert.throws(() => parseFps("nope"), /frame rate/iu);
});

test("creates SRT output names", () => {
  assert.equal(outputNameFor("movie.en.ass"), "movie.en.srt");
});

test("preserves every cue of a standard SRT file", () => {
  // The end timecode was split on /\s+/ without trimming, so the leading space
  // after "-->" produced an empty first element, end parsed as 0, and the
  // `end > start` filter then dropped every cue. Output was just "\n".
  const source = [
    "1",
    "00:00:01,000 --> 00:00:05,000",
    "Hello world",
    "",
    "2",
    "00:00:06,000 --> 00:00:09,250",
    "Second cue",
    "",
  ].join("\n");

  const output = convertToSrt(source, "in.srt");

  assert.match(output, /00:00:01,000 --> 00:00:05,000/);
  assert.match(output, /Hello world/);
  assert.match(output, /00:00:06,000 --> 00:00:09,250/);
  assert.match(output, /Second cue/);
});

test("does not mistake SRT dialogue for another format", () => {
  // "[Events]" and "<sami" were sniffed before "-->", so an SRT whose dialogue
  // happened to contain either string was routed to the wrong parser and
  // silently produced zero cues.
  for (const line of ["See the [Events] log", "He typed <sami> on screen"]) {
    const output = convertToSrt(
      ["1", "00:00:01,000 --> 00:00:02,000", line, ""].join("\n"),
      "in.srt",
    );
    assert.match(output, /00:00:01,000 --> 00:00:02,000/, `mis-sniffed: ${line}`);
  }
});

test("never derives an output name equal to its input", () => {
  // outputNameFor("foo.srt") returned "foo.srt", so a conversion with no
  // explicit --out would have written over the file it was reading.
  assert.notEqual(outputNameFor("movie.srt"), "movie.srt");
  assert.equal(outputNameFor("movie.itt"), "movie.srt");
});

test("reports malformed timecodes instead of silently dropping cues", () => {
  // parseTimecode returned 0 on no-match, so a broken timecode became
  // 00:00:00, failed the end > start filter, and vanished with no diagnostic.
  assert.throws(
    () =>
      convertToSrt(
        ["1", "not-a-timecode --> also-not", "Text", ""].join("\n"),
        "in.srt",
      ),
    /timecode/iu,
  );
});

test("honours ttp:frameRate over the requested fps", () => {
  const output = convertToSrt(
    `<tt xmlns="http://www.w3.org/ns/ttml" ttp:frameRate="30">
      <body><div><p begin="00:00:01:15" end="00:00:02:15">Half a second in</p></div></body>
    </tt>`,
    "sample.itt",
    { fps: 24 },
  );

  // 15 frames at 30fps is 0.5s; at the requested 24fps it would be 0.625s.
  assert.match(output, /00:00:01,500 --> 00:00:02,500/);
});

test("parses bare-seconds TTML times on both begin and end", () => {
  const output = convertToSrt(
    `<tt xmlns="http://www.w3.org/ns/ttml">
      <body><div><p begin="1.5" end="3.5">Bare seconds</p></div></body>
    </tt>`,
    "sample.itt",
  );

  assert.match(output, /00:00:01,500 --> 00:00:03,500/);
});

test("tolerates > inside TTML attribute values", () => {
  const output = convertToSrt(
    `<tt xmlns="http://www.w3.org/ns/ttml">
      <body><div><p begin="00:00:01.000" end="00:00:02.000" style="a>b">Attr text</p></div></body>
    </tt>`,
    "sample.itt",
  );

  assert.match(output, /\nAttr text/);
});

test("keeps cues beyond 99 hours", () => {
  const output = convertToSrt(
    ["1", "100:00:00,000 --> 100:00:02,000", "Late cue", ""].join("\n"),
    "in.srt",
  );

  assert.match(output, /Late cue/);
});

test("rejects an unusable frame rate rather than silently defaulting", () => {
  assert.throws(() => parseFps("0"), /frame rate/iu);
  assert.throws(() => parseFps("0/0"), /frame rate/iu);
  assert.throws(() => parseFps("nonsense"), /frame rate/iu);
});

test("preserves italic and bold markup on SRT-family conversions", () => {
  const output = convertToSrt(
    ["1", "00:00:01,000 --> 00:00:02,000", "<i>Whispered</i> aloud", ""].join("\n"),
    "in.srt",
  );

  assert.match(output, /<i>Whispered<\/i> aloud/);
});

test("emits one SRT dialect regardless of source format", () => {
  // The OCR path wrote BOM + CRLF and the text path bare LF, so the same tool
  // produced byte-different files depending on where the subtitles came from.
  const document = toSrtDocument("1\n00:00:01,000 --> 00:00:02,000\nHi\n");

  assert.equal(document.startsWith("\uFEFF"), true, "missing BOM");
  assert.match(document, /\r\n/u, "expected CRLF line endings");
  assert.doesNotMatch(document.slice(1), /(?<!\r)\n/u, "found a bare LF");

  // An empty result is still a valid, recognisable SRT file.
  assert.equal(toSrtDocument(""), "\uFEFF");
});
