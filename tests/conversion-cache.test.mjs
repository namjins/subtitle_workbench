import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appVersion,
  conversionCacheKey,
  isCachedConversionStale,
  readCachedConversion,
  writeCachedConversion,
} from "../lib/conversion-cache.mjs";

async function withTempCache(run) {
  const dir = await mkdtemp(join(tmpdir(), "subtitle-workbench-cache-"));
  const previous = process.env.SUBTITLE_WORKBENCH_CACHE_DIR;
  process.env.SUBTITLE_WORKBENCH_CACHE_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.SUBTITLE_WORKBENCH_CACHE_DIR;
    } else {
      process.env.SUBTITLE_WORKBENCH_CACHE_DIR = previous;
    }
    await rm(dir, { force: true, recursive: true });
  }
}

const baseOptions = {
  mode: "sup-to-srt",
  language: "eng",
  engine: "auto",
  textCleanup: "generic",
};

test("an entry from a different recogniser is stale, but a missing one is not", () => {
  const v55 = "tesseract v5.5.3.20260724";
  const v54 = "tesseract v5.4.0.20240606";

  // The bug this exists for: "auto" is unchanged by a Tesseract upgrade, but
  // the text is not. 5.4 reads some low-contrast frames as empty and drops
  // those cues; 5.5 reads them. Upgrading must not leave the lossy result in
  // place with nothing to show the upgrade did nothing.
  assert.equal(isCachedConversionStale({ engineVersion: v54 }, v55), true);
  assert.equal(isCachedConversionStale({ engineVersion: v55 }, v55), false);

  // Never stale when either side is unknown. `absent` means the tools are gone,
  // and an entry predating this field has nothing to compare -- in both cases
  // the cached result is the best answer available, not a stale one. Throwing
  // it away would undo a finished conversion for someone who has since
  // uninstalled Tesseract.
  assert.equal(isCachedConversionStale({ engineVersion: v54 }, "absent"), false);
  assert.equal(isCachedConversionStale({ engineVersion: "absent" }, v55), false);
  assert.equal(isCachedConversionStale({}, v55), false);
  assert.equal(isCachedConversionStale({ engineVersion: "" }, v55), false);
  assert.equal(isCachedConversionStale(null, v55), false);
});

test("keys by content, not by name or location", async () => {
  await withTempCache(async (dir) => {
    const original = join(dir, "movie.sup");
    const renamedCopy = join(dir, "completely different name.sup");
    await writeFile(original, "identical bytes");
    await writeFile(renamedCopy, "identical bytes");

    const first = await conversionCacheKey({ ...baseOptions, sourcePaths: [original] });
    const second = await conversionCacheKey({
      ...baseOptions,
      sourcePaths: [renamedCopy],
    });
    assert.equal(first, second);

    await writeFile(renamedCopy, "different bytes");
    assert.notEqual(
      await conversionCacheKey({ ...baseOptions, sourcePaths: [renamedCopy] }),
      first,
    );
  });
});

test("keys change with any option that changes the output", async () => {
  await withTempCache(async (dir) => {
    const source = join(dir, "movie.sup");
    await writeFile(source, "bytes");
    const sourcePaths = [source];

    const base = await conversionCacheKey({ ...baseOptions, sourcePaths });
    for (const variation of [
      { language: "deu" },
      { engine: "macos-vision" },
      { textCleanup: "fitted" },
      { mode: "subidx-to-srt" },
      { ocrCommand: "./sidecar" },
    ]) {
      assert.notEqual(
        await conversionCacheKey({ ...baseOptions, sourcePaths, ...variation }),
        base,
        `expected ${JSON.stringify(variation)} to change the key`,
      );
    }
  });
});

test("stores one entry per key and replaces it wholesale", async () => {
  await withTempCache(async () => {
    const entry = {
      appVersion: "0.0.9",
      srt: "1\n00:00:01,000 --> 00:00:02,000\nOld\n",
      cueCount: 1,
    };
    await writeCachedConversion("some-key", entry);
    assert.deepEqual(await readCachedConversion("some-key"), entry);

    const replacement = { ...entry, appVersion: appVersion(), srt: "new" };
    await writeCachedConversion("some-key", replacement);
    assert.deepEqual(await readCachedConversion("some-key"), replacement);

    assert.equal(await readCachedConversion("other-key"), null);
  });
});

test("treats a malformed entry as a miss", async () => {
  await withTempCache(async (dir) => {
    await writeFile(join(dir, "conversions", "bad-key.json"), "{not json").catch(
      () => {},
    );
    // Whether the write above succeeded (directory may not exist yet) or the
    // file is absent, the reader must simply miss.
    assert.equal(await readCachedConversion("bad-key"), null);

    await writeCachedConversion("half-key", { appVersion: "1.0.0" });
    // Missing `srt` — an entry that cannot be served must read as a miss.
    assert.equal(await readCachedConversion("half-key"), null);
  });
});
