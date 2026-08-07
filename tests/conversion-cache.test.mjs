import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appVersion,
  conversionCacheKey,
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
