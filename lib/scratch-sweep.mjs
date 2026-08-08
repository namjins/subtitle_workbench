import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { cacheDirectory } from "./platform-paths.mjs";

/**
 * Reclaim scratch directories orphaned by a killed conversion.
 *
 * Stopping a run SIGKILLs the OCR process group, so the converter's own
 * cleanup `finally` never runs and its `subtitle-ocr-*` directory of PNGs
 * survives in cacheDirectory("scratch") forever. Swept at bridge startup —
 * but only when it is provably safe:
 *  - never a directory marked `kept-on-purpose` (--keep-temp),
 *  - never one whose owner.pid is still alive (a CLI run in another
 *    terminal — `activeJobs === 0` proves nothing about those),
 *  - never one younger than maxAgeMs, as a belt for clock/marker races.
 */
export async function sweepStaleScratch({
  root = cacheDirectory("scratch"),
  maxAgeMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
  isPidAlive = defaultIsPidAlive,
} = {}) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return []; // No scratch root yet: nothing to do.
  }

  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("subtitle-ocr-")) continue;
    const directory = join(root, entry.name);
    try {
      await stat(join(directory, "kept-on-purpose"));
      continue; // The user asked for this one with --keep-temp.
    } catch {
      // Not kept; keep checking.
    }

    let ownerPid = null;
    try {
      ownerPid = Number((await readFile(join(directory, "owner.pid"), "utf8")).trim());
    } catch {
      // Pre-marker directory: fall through to the age check alone.
    }
    if (ownerPid && isPidAlive(ownerPid)) continue;

    try {
      const info = await stat(directory);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(directory, { force: true, recursive: true });
      removed.push(directory);
    } catch {
      // Vanished mid-sweep or unreadable: leave it for next time.
    }
  }
  return removed;
}

function defaultIsPidAlive(pid) {
  try {
    // Signal 0 probes existence without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return error.code === "EPERM";
  }
}
