import assert from "node:assert/strict";
import test from "node:test";
import { detectSafeJobs } from "../lib/cpu-jobs.mjs";
import { runLocalCommand, subtitleWorkbenchArgs } from "../lib/local-runner.mjs";

test("builds subtitle-workbench JSON event command arguments", () => {
  const args = subtitleWorkbenchArgs({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
    language: "eng",
    outDir: "/tmp/out",
    jobs: 4,
  });

  assert.match(args[0], /tools\/subtitle-workbench\.mjs$/u);
  assert.deepEqual(args.slice(1), [
    "sup-to-srt",
    "/tmp/movie.sup",
    "--lang",
    "eng",
    "--jobs",
    "4",
    "--ocr-engine",
    "auto",
    "--json-events",
    "--out-dir",
    "/tmp/out",
  ]);
});

test("uses automatic safe jobs when local runner jobs are omitted", () => {
  const args = subtitleWorkbenchArgs({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
  });
  const jobsIndex = args.indexOf("--jobs");

  assert.equal(args[jobsIndex + 1], String(detectSafeJobs()));
});

test("builds ITT conversion args without OCR-only options", () => {
  const args = subtitleWorkbenchArgs({
    command: "itt-to-srt",
    inputs: ["/tmp/captions.itt"],
    fps: "24000/1001",
    outDir: "/tmp/out",
    jobs: 8,
    language: "eng",
  });

  assert.deepEqual(args.slice(1), [
    "itt-to-srt",
    "/tmp/captions.itt",
    "--fps",
    "24000/1001",
    "--json-events",
    "--out-dir",
    "/tmp/out",
  ]);
  assert.equal(args.includes("--lang"), false);
  assert.equal(args.includes("--jobs"), false);
  assert.equal(args.includes("--ocr-engine"), false);
});

test("streams JSONL local job events from stdout", async () => {
  const seen = [];
  const result = await runLocalCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'job-started', input: 'a.sup' }));",
        "console.log('human text');",
        "console.log(JSON.stringify({ type: 'job-finished', output: 'a.srt' }));",
      ].join(""),
    ],
    { onEvent: (event) => seen.push(event.type) },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(seen, ["job-started", "job-finished"]);
  assert.equal(result.events[1].output, "a.srt");
  assert.match(result.stdout, /human text/u);
});

test("rejects failed local commands with captured diagnostics", async () => {
  await assert.rejects(
    () =>
      runLocalCommand(process.execPath, [
        "-e",
        "console.error('nope'); process.exit(7);",
      ]),
    (error) => {
      assert.match(error.message, /exited with 7/u);
      assert.match(error.result.stderr, /nope/u);
      return true;
    },
  );
});
