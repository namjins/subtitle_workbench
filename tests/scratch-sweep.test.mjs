import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sweepStaleScratch } from "../lib/scratch-sweep.mjs";

async function makeScratchDir(root, name, { pid, kept = false, ageHours = 48 } = {}) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  if (pid !== undefined) await writeFile(join(directory, "owner.pid"), String(pid));
  if (kept) await writeFile(join(directory, "kept-on-purpose"), "");
  const past = new Date(Date.now() - ageHours * 3600 * 1000);
  await utimes(directory, past, past);
  return directory;
}

test("sweeps only dead-owner, old, unkept scratch directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "subtitle-workbench-sweep-"));
  try {
    const deadPid = 999999;
    const livePid = 1111;
    const orphan = await makeScratchDir(root, "subtitle-ocr-orphan", { pid: deadPid });
    const kept = await makeScratchDir(root, "subtitle-ocr-kept", { pid: deadPid, kept: true });
    const live = await makeScratchDir(root, "subtitle-ocr-live", { pid: livePid });
    const young = await makeScratchDir(root, "subtitle-ocr-young", {
      pid: deadPid,
      ageHours: 1,
    });
    const unrelated = await makeScratchDir(root, "something-else", { pid: deadPid });

    const removed = await sweepStaleScratch({
      root,
      isPidAlive: (pid) => pid === livePid,
    });

    // Only the orphan goes: kept-on-purpose survives --keep-temp, a live owner
    // survives a concurrent CLI run, young survives clock races, and the sweep
    // never touches directories it did not name.
    assert.deepEqual(removed, [orphan]);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(kept), true);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(young), true);
    assert.equal(existsSync(unrelated), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a missing scratch root is a no-op", async () => {
  const removed = await sweepStaleScratch({ root: join(tmpdir(), "does-not-exist-xyz") });
  assert.deepEqual(removed, []);
});
