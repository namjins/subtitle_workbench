/**
 * Hash-based image dedup for the OCR pipeline.
 *
 * Identical subtitle bitmaps recur within a track — a repeated sound cue, a
 * held caption re-sent as its own display set. OCR is by far the most
 * expensive step and identical bytes cannot produce a different reading, so
 * one representative per distinct image is recognised and the result fanned
 * back out. Extracted here so the index bookkeeping is unit-testable: a
 * misalignment silently attaches the wrong text to a cue.
 */

/**
 * @param {string[]} hashes one hash per image, in image order
 * @returns {{ representatives: number[], firstByHash: Map<string, number> }}
 *   representatives: the first index of each distinct hash, in order;
 *   firstByHash: hash -> that first index, for the fan-out.
 */
export function dedupeByHash(hashes) {
  const firstByHash = new Map();
  const representatives = [];
  hashes.forEach((hash, index) => {
    if (firstByHash.has(hash)) return;
    firstByHash.set(hash, index);
    representatives.push(index);
  });
  return { representatives, firstByHash };
}

/**
 * Map with a concurrency bound, preserving order. Promise.all over thousands
 * of items holds every intermediate buffer live at once; every other loop in
 * the OCR pipeline is capped at `jobs`, and this keeps hashing consistent.
 */
export async function mapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}
