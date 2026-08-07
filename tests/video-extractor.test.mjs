import assert from "node:assert/strict";
import test from "node:test";
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
      "2:/tmp/out/Spy Game (2001).sub",
      "3:/tmp/out/Spy Game (2001)1-forced.sup",
    ],
  );
  assert.deepEqual(plan[0].outputs, [
    "/tmp/out/Spy Game (2001).sub",
    "/tmp/out/Spy Game (2001).idx",
  ]);
});
