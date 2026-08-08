import assert from "node:assert/strict";
import test from "node:test";
import { dedupeByHash, mapBounded } from "../lib/image-dedupe.mjs";

test("fans a shared hash back out to the first index that carried it", () => {
  // Images 0 and 2 are byte-identical; 1 is different. The representative set
  // must be [0, 1], and every lookup through firstByHash must land on the
  // recognised index — a misalignment here silently attaches the wrong text
  // to a cue across a whole track.
  const hashes = ["aaa", "bbb", "aaa"];
  const { representatives, firstByHash } = dedupeByHash(hashes);

  assert.deepEqual(representatives, [0, 1]);
  assert.equal(firstByHash.get(hashes[0]), 0);
  assert.equal(firstByHash.get(hashes[1]), 1);
  assert.equal(firstByHash.get(hashes[2]), 0);

  // Simulate the fan-out: recognise only representatives, then read back
  // through the map for every image.
  const ocrByIndex = [];
  for (const index of representatives) ocrByIndex[index] = `text-${index}`;
  const fanned = hashes.map((hash) => ocrByIndex[firstByHash.get(hash)]);
  assert.deepEqual(fanned, ["text-0", "text-1", "text-0"]);
});

test("all-distinct and all-identical inputs keep their shape", () => {
  assert.deepEqual(dedupeByHash(["a", "b", "c"]).representatives, [0, 1, 2]);
  assert.deepEqual(dedupeByHash(["a", "a", "a"]).representatives, [0]);
  assert.deepEqual(dedupeByHash([]).representatives, []);
});

test("mapBounded preserves order and honours the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapBounded([10, 20, 30, 40, 50], 2, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
  assert.ok(peak <= 2, `expected at most 2 in flight, saw ${peak}`);
});
