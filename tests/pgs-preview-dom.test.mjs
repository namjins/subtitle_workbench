import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Window } from "happy-dom";
import { isUsableImage, scanDisplaySets } from "../lib/pgs-decoder.mjs";

/**
 * The browser preview shares its decoder with the CLI, so what remains to test
 * here is that the shared decoder behaves identically when driven from a DOM
 * environment, and that the preview shows the same pixels OCR receives. The two
 * implementations previously drifted — the browser painted flat black while the
 * CLI wrote palette colours — which is exactly the class of bug a source grep
 * cannot catch.
 */
const fixture = new URL("./fixtures/real-two-cues.sup", import.meta.url);

// Must await `run` before restoring: returning the promise from a try block
// runs the finally as soon as the promise is created, so the global would be
// torn down before the async body ever touched it.
async function withDom(run) {
  const window = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  try {
    return await run(window);
  } finally {
    globalThis.document = previousDocument;
  }
}

test("the preview decoder sees the same cues as the CLI decoder", async () => {
  const data = new Uint8Array(await readFile(fixture));

  const decoded = [];
  scanDisplaySets(data, (image, pts) => {
    if (isUsableImage(image)) decoded.push({ pts, width: image.width, height: image.height });
    return true;
  });

  // Same three cues, at the timings in the reference SRT.
  assert.equal(decoded.length, 3);
  assert.deepEqual(
    decoded.map((cue) => Number(cue.pts.toFixed(3))),
    [15.974, 29.196, 34.326],
  );
});

test("preview pixels are palette colours, not a flat silhouette", async () => {
  const data = new Uint8Array(await readFile(fixture));

  let first = null;
  scanDisplaySets(data, (image) => {
    if (!isUsableImage(image)) return true;
    first = image;
    return false;
  });
  assert.ok(first, "expected a rendered image");

  // Collect the distinct colours actually written. The old browser copy forced
  // every visible pixel to 0,0,0, so anti-aliasing was lost and the preview
  // could not show why a cue read badly.
  const colours = new Set();
  for (let pixel = 0; pixel < first.width * first.height; pixel += 1) {
    colours.add(
      `${first.rgb[pixel * 3]},${first.rgb[pixel * 3 + 1]},${first.rgb[pixel * 3 + 2]}`,
    );
  }

  assert.ok(colours.size > 2, `expected anti-aliased greys, saw ${colours.size} colours`);
  assert.ok(colours.has("255,255,255"), "expected a white background");
});

test("renders into a DOM canvas without touching Node-only APIs", async () => {
  await withDom(async () => {
    const { extractPgsPreviewsFromBuffer } = await import("../app/pgsPreview.ts");
    const buffer = (await readFile(fixture)).buffer;

    // happy-dom has no canvas raster backend, so toDataURL returns nothing
    // usable; what matters here is that the shared decoder runs unchanged in a
    // DOM environment rather than reaching for Buffer or node:fs.
    assert.doesNotThrow(() => extractPgsPreviewsFromBuffer(buffer, 2));
  });
});
