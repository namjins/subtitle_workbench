import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// SRT Cleaner and a generic "Convert to SRT" are deliberately deferred past the
// first release (see docs/product-roadmap.md). These guards used to live in
// the server-rendered HTML test, which went away with the Cloudflare worker.
// They assert over the workbench source instead: there is no server-rendered
// HTML left to inspect, and a source grep is enough to catch a tool card or
// label being added back before the feature is ready.
test("keeps SRT Cleaner and Convert to SRT out of the shipped UI", async () => {
  const workbench = await readFile(
    new URL("../app/SubtitleWorkbench.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(workbench, /Convert to SRT/);
  assert.doesNotMatch(workbench, /SRT Cleaner/);
});
