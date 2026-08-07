import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const result = runCli(["sup-to-srt", "--lang", "eng", "--out", output, "--quiet", "--", realSup]);

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

    const result = runCli(["sup-to-srt", "--out", join(dir, "out.srt"), "--quiet", "--", input]);

    assert.notEqual(result.status, 0, "decoding nothing must not report success");
    assert.equal(existsSync(join(dir, "out.srt")), false, "no empty SRT should be left behind");
  });
});

test("refuses an input path that is really an option", async () => {
  const result = runCli(["itt-to-srt", "--", "--ocr-command"]);

  assert.notEqual(result.status, 0);
  // The string still appears, because it is named as the missing input. What
  // matters is that it was treated as a path rather than honoured as a flag.
  assert.match(result.stderr, /ENOENT|no such file|not found/iu);
});
