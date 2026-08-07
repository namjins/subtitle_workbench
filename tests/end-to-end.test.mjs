import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hasCommand } from "../lib/platform-paths.mjs";
import { extractPgsPreviewImages } from "../lib/pgs-peek.mjs";
import { buildPgsFixture } from "../tools/make_pgs_fixture.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(repoRoot, "tools", "subtitle-workbench.mjs");
const realSup = fileURLToPath(new URL("./fixtures/real-two-cues.sup", import.meta.url));

// OCR needs tesseract and ImageMagick. Skip rather than fail where they are
// absent (a bare CI runner), but never skip the decode-only assertions.
const canOcr = hasCommand("tesseract") && hasCommand("magick") && hasCommand("ffmpeg");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? repoRoot,
    // cacheDir redirects the whole cache root — used by the cache test for a
    // private conversion cache. Left unset elsewhere so the prebuilt Vision
    // helper is reused rather than rebuilt per run.
    env: {
      ...process.env,
      ...(options.cacheDir
        ? { SUBTITLE_WORKBENCH_CACHE_DIR: options.cacheDir }
        : {}),
      ...(options.env ?? {}),
    },
  });
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "subtitle-workbench-e2e-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("decodes a real PGS track to the timings in its reference SRT", async () => {
  // Truncated from an mkvextract-produced .sup, so the bytes come from real
  // tooling rather than from our own encoder.
  await withTempDir(async (dir) => {
    const images = await extractPgsPreviewImages(realSup, dir, Infinity);

    assert.equal(images.length, 3);
    assert.deepEqual(
      images.map((image) => [Number(image.pts.toFixed(3)), Number(image.endPts.toFixed(3))]),
      [
        [15.974, 17.976],
        [29.196, 30.364],
        [34.326, 35.536],
      ],
    );
  });
});

test("converts a real PGS track end to end", { skip: !canOcr && "OCR tools unavailable" }, async () => {
  await withTempDir(async (dir) => {
    const output = join(dir, "out.srt");
    const result = runCli(["sup-to-srt", "--lang", "eng", "--out", output, "--quiet", "--no-cache", "--", realSup]);

    assert.equal(result.status, 0, result.stderr);
    const srt = await readFile(output, "utf8");

    // Text and timing both come from the reference SRT for this track.
    assert.match(srt, /00:00:15,974 --> 00:00:17,976\r?\n\[gasping and sputtering\]/u);
    assert.match(srt, /00:00:29,196 --> 00:00:30,364\r?\nHello\?/u);
    assert.match(srt, /00:00:34,326 --> 00:00:35,536\r?\nNancy\?/u);
  });
});

test("decodes composition objects that carry a crop flag", async () => {
  // No fixture in the real corpus uses cropping, so this one is synthetic:
  // a cropped entry is 16 bytes rather than 8, and assuming 8 desynchronised
  // every later object in the composition.
  await withTempDir(async (dir) => {
    const path = join(dir, "cropped.sup");
    await writeFile(path, buildPgsFixture([{ start: 1, end: 3 }], { cropped: true }));

    const images = await extractPgsPreviewImages(path, dir, Infinity);
    assert.equal(images.length, 1, "a cropped composition object should still decode");
  });
});

test("keeps palette entries a palette-update segment does not mention", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "palette-update.sup");
    await writeFile(path, buildPgsFixture([{ start: 1, end: 3 }], { paletteUpdate: true }));

    const images = await extractPgsPreviewImages(path, dir, Infinity);
    assert.equal(images.length, 1, "a partial palette update must not blank the cue");
  });
});

test("converts ITT through the CLI", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "captions.itt");
    await writeFile(
      input,
      `<tt xmlns="http://www.w3.org/ns/ttml" ttp:frameRate="25">
        <body><div>
          <p begin="00:00:01:00" end="00:00:03:00">First <i>cue</i></p>
          <p begin="00:00:04:00" dur="00:00:02:00">Second cue</p>
        </div></div></body>
      </tt>`,
    );

    const result = runCli(["itt-to-srt", "--out", join(dir, "out.srt"), "--", input]);
    assert.equal(result.status, 0, result.stderr);

    const srt = await readFile(join(dir, "out.srt"), "utf8");
    // 25fps comes from ttp:frameRate, not from the default 23.976.
    assert.match(srt, /00:00:01,000 --> 00:00:03,000/u);
    assert.match(srt, /First <i>cue<\/i>/u);
    assert.match(srt, /00:00:04,000 --> 00:00:06,000/u);
  });
});

test("round-trips an SRT without destroying it", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "movie.srt");
    const source = ["1", "00:00:01,000 --> 00:00:05,000", "Hello world", ""].join("\r\n");
    await writeFile(input, `\uFEFF${source}`);

    const result = runCli(["itt-to-srt", "--", input]);
    assert.equal(result.status, 0, result.stderr);

    // The output must not be the input path, and the input must survive.
    assert.equal(await readFile(input, "utf8"), `\uFEFF${source}`);
    assert.ok(existsSync(join(dir, "movie-converted.srt")));
    assert.match(await readFile(join(dir, "movie-converted.srt"), "utf8"), /Hello world/u);
  });
});

test("fails loudly instead of writing an empty SRT", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "empty.sup");
    await writeFile(input, Buffer.alloc(0));

    const result = runCli(["sup-to-srt", "--out", join(dir, "out.srt"), "--quiet", "--no-cache", "--", input]);

    assert.notEqual(result.status, 0, "decoding nothing must not report success");
    assert.equal(existsSync(join(dir, "out.srt")), false, "no empty SRT should be left behind");
  });
});

test("writes an empty SRT for a track that renders nothing", async () => {
  // A blank forced/overlay track is real — several exist in the fixture corpus
  // with correctly empty reference SRTs — so it must not be treated as damaged.
  await withTempDir(async (dir) => {
    const input = join(dir, "blank.sup");
    await writeFile(input, buildPgsFixture([{ start: 1, end: 3 }], { blank: true }));
    const output = join(dir, "blank.srt");

    const result = runCli(["sup-to-srt", "--out", output, "--quiet", "--no-cache", "--", input]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no visible subtitles/iu);
    assert.equal(existsSync(output), true);
  });
});

test("keeps converting a batch after one file fails", async () => {
  await withTempDir(async (dir) => {
    const good = join(dir, "good.sup");
    const bad = join(dir, "bad.sup");
    await writeFile(good, buildPgsFixture([{ start: 1, end: 3 }]));
    await writeFile(bad, Buffer.from("not a subtitle file"));

    const result = runCli([
      "sup-to-srt", "--out-dir", dir, "--quiet", "--", bad, good,
    ]);

    // The bad file is reported and the exit status is honest...
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAILED bad\.sup/u);
    // ...but the good file after it still converted.
    assert.equal(existsSync(join(dir, "good-eng.srt")), true, "batch stopped at the first failure");
  });
});

test("refuses an input path that is really an option", async () => {
  const result = runCli(["itt-to-srt", "--", "--ocr-command"]);

  assert.notEqual(result.status, 0);
  // The string still appears, because it is named as the missing input. What
  // matters is that it was treated as a path rather than honoured as a flag.
  assert.match(result.stderr, /ENOENT|no such file|not found/iu);
});

test("counts a candidate cue in a declared reference gap as unverified, not extra", async () => {
  // The Matrix's retail reference SRT skips a cue the stream provably
  // displays ("I..." at 01:39:54.5, verified from the decoded bitmap), so the
  // correct OCR reading counted as an extra cue and failed the gate. Fixture
  // metadata can declare such verified gaps; a cue inside one is unverified.
  await withTempDir(async (dir) => {
    const examples = join(dir, "examples");
    const candidates = join(dir, "candidates");
    await mkdir(examples, { recursive: true });
    await mkdir(candidates, { recursive: true });

    // Pairing scans for source files by name; the benchmark never reads them.
    await writeFile(join(examples, "movie.sup"), "");
    await writeFile(
      join(examples, "movie-eng.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
    );
    await writeFile(
      join(candidates, "movie.srt"),
      [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "Hello",
        "",
        "2",
        "00:00:05,000 --> 00:00:06,000",
        "I...",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        examples: {
          movie: {
            status: "reference-missing-cue",
            knownReferenceGaps: [{ start: 5, end: 6 }],
          },
        },
      }),
    );

    const gateArgs = [
      "benchmark-ocr",
      "--examples-dir",
      examples,
      "--candidate-dir",
      candidates,
      "--max-extra",
      "0",
      "--json",
    ];

    // Without the metadata the same comparison must keep failing: the gap
    // machinery only excuses cues someone has explicitly verified.
    const undeclared = runCli(gateArgs);
    assert.notEqual(undeclared.status, 0);

    const declared = runCli([...gateArgs, "--fixture-metadata", join(dir, "metadata.json")]);
    assert.equal(declared.status, 0, declared.stderr);
    const report = JSON.parse(declared.stdout);
    assert.equal(report.rows[0].extra, 0);
    assert.equal(report.rows[0].unverified, 1);
    assert.equal(report.rows[0].note, "reference-missing-cue");
  });
});

test("serves a repeat conversion from the cache, keyed by content and stamped with the producing version", { skip: !canOcr && "OCR tools unavailable" }, async () => {
  await withTempDir(async (dir) => {
    const cacheDir = join(dir, "cache");
    const original = join(dir, "movie.sup");
    const renamed = join(dir, "same bytes, different name.sup");
    await writeFile(original, await readFile(realSup));
    await writeFile(renamed, await readFile(realSup));
    // tesseract-accurate, not auto: auto's probe would build the Vision
    // helper inside the test-private cache directory on macOS.
    const convertArgs = (input, output) => [
      "sup-to-srt", "--lang", "eng", "--ocr-engine", "tesseract-accurate",
      "--out", output, "--quiet", "--", input,
    ];

    const first = runCli(convertArgs(original, join(dir, "a.srt")), { cacheDir });
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stderr, /reused cached conversion/u);

    // Same bytes under another name: a hit, byte-identical output.
    const second = runCli(convertArgs(renamed, join(dir, "b.srt")), { cacheDir });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /reused cached conversion from app version \d/u);
    assert.equal(
      await readFile(join(dir, "b.srt"), "utf8"),
      await readFile(join(dir, "a.srt"), "utf8"),
    );

    // An entry from an older app version is served but says so, so the user
    // can decide whether to reconvert.
    const { readdir } = await import("node:fs/promises");
    const conversions = join(cacheDir, "conversions");
    const [entryFile] = await readdir(conversions);
    const entry = JSON.parse(await readFile(join(conversions, entryFile), "utf8"));
    await writeFile(
      join(conversions, entryFile),
      JSON.stringify({ ...entry, appVersion: "0.0.1" }),
    );
    const stale = runCli(convertArgs(original, join(dir, "c.srt")), { cacheDir });
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stderr, /app version 0\.0\.1 — current is \d/u);

    // --no-cache reconverts and replaces the entry with the current version.
    const forced = runCli(
      [...convertArgs(original, join(dir, "d.srt")).slice(0, -2), "--no-cache", "--", original],
      { cacheDir },
    );
    assert.equal(forced.status, 0, forced.stderr);
    assert.doesNotMatch(forced.stderr, /reused cached conversion/u);
    const replaced = JSON.parse(await readFile(join(conversions, entryFile), "utf8"));
    assert.notEqual(replaced.appVersion, "0.0.1");
  });
});

test("names every missing tool with install help before starting work", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "movie.sup");
    await writeFile(input, await readFile(realSup));

    // A PATH with no tools on it: preflight must name them all at once and
    // point at the platform's install commands, not fail one binary at a time.
    const result = runCli(
      ["sup-to-srt", "--out", join(dir, "out.srt"), "--quiet", "--", input],
      { cacheDir: join(dir, "cache"), env: { PATH: dir } },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required tools: .*ffmpeg/u);
    assert.match(result.stderr, /Missing required tools: .*magick/u);
    assert.match(result.stderr, /subtitle-workbench doctor/u);
  });
});

test("serves a cached conversion even when the tools are gone", { skip: !canOcr && "OCR tools unavailable" }, async () => {
  await withTempDir(async (dir) => {
    const cacheDir = join(dir, "cache");
    const input = join(dir, "movie.sup");
    await writeFile(input, await readFile(realSup));
    const args = (output) => [
      "sup-to-srt", "--lang", "eng", "--ocr-engine", "tesseract-accurate",
      "--out", output, "--quiet", "--", input,
    ];

    const seeded = runCli(args(join(dir, "a.srt")), { cacheDir });
    assert.equal(seeded.status, 0, seeded.stderr);

    // Uninstalling ffmpeg/tesseract must not take away conversions that are
    // already finished: preflight runs only after the cache misses.
    const withoutTools = runCli(args(join(dir, "b.srt")), {
      cacheDir,
      env: { PATH: dir },
    });
    assert.equal(withoutTools.status, 0, withoutTools.stderr);
    assert.match(withoutTools.stderr, /reused cached conversion/u);
  });
});
