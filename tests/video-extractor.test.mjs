import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  buildMkvExtractPlan,
  parseMkvSubtitleTracks,
  subtitleFormat,
} from "../lib/video-extractor.mjs";

test("maps MKV subtitle tracks to extraction-ready rows", () => {
  const tracks = parseMkvSubtitleTracks({
    tracks: [
      { id: 0, type: "video", codec: "V_MPEG4" },
      {
        id: 2,
        type: "subtitles",
        codec: "S_VOBSUB",
        properties: { language: "eng", default_track: true, forced_track: false },
      },
      {
        id: 3,
        type: "subtitles",
        codec: "S_HDMV/PGS",
        properties: { language: "spa", default_track: false, forced_track: true },
      },
    ],
  });

  assert.equal(tracks.length, 2);
  assert.deepEqual(
    tracks.map((track) => [track.trackId, track.languageCode, track.format, track.forcedTrack]),
    [
      [2, "eng", "sub + idx", false],
      [3, "spa", "sup", true],
    ],
  );
});

test("builds mkvextract output specs for VobSub and PGS", () => {
  const plan = buildMkvExtractPlan(
    "/tmp/Spy Game (2001).mkv",
    [
      { trackId: 2, codec: "S_VOBSUB", languageCode: "eng", forcedTrack: false },
      { trackId: 3, codec: "S_HDMV/PGS", languageCode: "eng", forcedTrack: true },
    ],
    "/tmp/out",
  );

  assert.equal(subtitleFormat("S_VOBSUB"), "sub + idx");
  assert.deepEqual(
    plan.map((item) => item.spec),
    [
      `2:${join("/tmp/out", "Spy Game (2001).sub")}`,
      `3:${join("/tmp/out", "Spy Game (2001)1-forced.sup")}`,
    ],
  );
  assert.deepEqual(plan[0].outputs, [
    join("/tmp/out", "Spy Game (2001).sub"),
    join("/tmp/out", "Spy Game (2001).idx"),
  ]);
});

test("assigns per-suffix stem indices over the full track list", () => {
  const tracks = parseMkvSubtitleTracks({
    tracks: [
      { id: 2, type: "subtitles", codec: "S_HDMV/PGS", properties: { language: "eng" } },
      { id: 3, type: "subtitles", codec: "S_HDMV/PGS", properties: { language: "eng" } },
      {
        id: 4,
        type: "subtitles",
        codec: "S_HDMV/PGS",
        properties: { language: "eng", forced_track: true },
      },
      { id: 5, type: "subtitles", codec: "S_HDMV/PGS", properties: { language: "spa" } },
    ],
  });

  // Two plain-eng tracks share a suffix and take 0 and 1; the forced-eng and
  // spa tracks have distinct suffixes so each starts back at 0 — the numeral
  // only ever disambiguates within a suffix.
  assert.deepEqual(
    tracks.map((track) => [track.trackId, track.stemIndex]),
    [
      [2, 0],
      [3, 1],
      [4, 0],
      [5, 0],
    ],
  );
});

test("output names are stable when a subset of tracks is extracted", () => {
  const [first, second] = parseMkvSubtitleTracks({
    tracks: [
      { id: 2, type: "subtitles", codec: "S_HDMV/PGS", properties: { language: "eng" } },
      { id: 3, type: "subtitles", codec: "S_HDMV/PGS", properties: { language: "eng" } },
    ],
  });

  const fullPlan = buildMkvExtractPlan("/tmp/movie.mkv", [first, second], "/tmp/out");
  // Re-running with only the second track pending used to renumber it to
  // position 0, writing its content over the first track's file.
  const subsetPlan = buildMkvExtractPlan("/tmp/movie.mkv", [second], "/tmp/out");

  assert.equal(fullPlan[0].output, join("/tmp/out", "movie.sup"));
  assert.equal(fullPlan[1].output, join("/tmp/out", "movie1.sup"));
  assert.equal(subsetPlan[0].output, fullPlan[1].output);
});

test("refuses a plan where two tracks resolve to the same output file", () => {
  // stemIndex arrives over the network on the bridge path; two tracks carrying
  // the same value would silently overwrite each other mid-extraction.
  assert.throws(
    () =>
      buildMkvExtractPlan(
        "/tmp/movie.mkv",
        [
          { trackId: 2, codec: "S_HDMV/PGS", languageCode: "eng", forcedTrack: false, stemIndex: 0 },
          { trackId: 3, codec: "S_HDMV/PGS", languageCode: "eng", forcedTrack: false, stemIndex: 0 },
        ],
        "/tmp/out",
      ),
    /same output file/,
  );
});

test("does not offer DVB subtitle tracks for extraction", () => {
  // DVB is not PGS. Extracting it to a .sup produced a file the OCR path
  // decoded to nothing and reported as a successful, empty conversion.
  const rows = parseMkvSubtitleTracks({
    tracks: [
      { id: 2, type: "subtitles", properties: { codec_id: "S_DVBSUB", language: "eng" } },
      { id: 3, type: "subtitles", properties: { codec_id: "S_HDMV/PGS", language: "eng" } },
    ],
  });

  assert.deepEqual(
    rows.map((row) => row.codec),
    ["S_HDMV/PGS"],
  );
});
