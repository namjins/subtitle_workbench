import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the subtitle workbench shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Subtitle Workbench<\/title>/i);
  assert.match(html, /Local subtitle workbench/);
  assert.match(html, /Sup to Srt/);
  assert.match(html, /SUB\/IDX to SRT/);
  assert.match(html, /Extract from Video/);
  assert.doesNotMatch(html, /Convert to SRT/);
  assert.doesNotMatch(html, /SRT Cleaner/);
  assert.doesNotMatch(html, /Your site is taking shape/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("keeps the app wired to the real subtitle workbench", async () => {
  const [page, layout, packageJson, workbench, extractor] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/SubtitleWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../tools/extract_english_subs.sh", import.meta.url), "utf8"),
  ]);

  assert.match(page, /SubtitleWorkbench/);
  assert.match(layout, /title:\s*"Subtitle Workbench"/);
  assert.match(workbench, /Convert PGS subtitles/);
  assert.match(workbench, /About \.sup files/);
  assert.match(workbench, /Subtitle language for OCR/);
  assert.match(workbench, /Subpicture batch/);
  assert.match(workbench, /Subpicture batch #208/);
  assert.match(workbench, /Uploading to batches/);
  assert.match(workbench, /Uploading sub\/idx files/);
  assert.match(workbench, /Apply this language to other subpictures/);
  assert.match(workbench, /Start batch/);
  assert.match(workbench, /Subpicture batches/);
  assert.match(workbench, /Download results/);
  assert.match(workbench, /Below are/);
  assert.match(workbench, /Select language/);
  assert.match(workbench, /Download Srt/);
  assert.match(workbench, /Extract Subtitles from Video/);
  assert.match(workbench, /Download \.sub/);
  assert.match(workbench, /Download \.idx/);
  assert.match(workbench, /extractPgsPreviewsFromBuffer/);
  assert.match(extractor, /S_VOBSUB\*/);
  assert.match(extractor, /\.idx/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
