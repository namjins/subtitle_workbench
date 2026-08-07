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
  // Flags first, then `--`, then inputs: an input that looks like a flag must
  // not be re-parsed as one by the CLI.
  assert.deepEqual(args.slice(1), [
    "sup-to-srt",
    "--lang",
    "eng",
    "--jobs",
    "4",
    "--ocr-engine",
    "auto",
    "--json-events",
    "--out-dir",
    "/tmp/out",
    "--",
    "/tmp/movie.sup",
  ]);
  assert.ok(
    args.indexOf("--json-events") < args.indexOf("--"),
    "--json-events must precede the terminator or the progress stream is lost",
  );
});

test("uses automatic safe jobs when local runner jobs are omitted", () => {
  const args = subtitleWorkbenchArgs({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
  });
  const jobsIndex = args.indexOf("--jobs");

  assert.equal(args[jobsIndex + 1], String(detectSafeJobs()));
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

test("does not pass an injected option from an input path", () => {
  const args = subtitleWorkbenchArgs({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup", "--ocr-command", "/bin/sh"],
  });

  // The strings still appear, but only after `--`, where the CLI treats them
  // as positional paths rather than options.
  const terminator = args.indexOf("--");
  assert.ok(terminator > 0);
  assert.ok(args.indexOf("--ocr-command") > terminator);
});

test("omits --ocr-command when a job does not carry one", () => {
  const args = subtitleWorkbenchArgs({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
  });
  assert.equal(args.includes("--ocr-command"), false);
});

test("cancelling a job kills the whole process tree", async () => {
  // The CLI spawns OCR workers of its own, so killing only the direct child
  // would leave tesseract/magick running after the client disconnected.
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    process.stdout.write(JSON.stringify({ type: "spawned", pid: child.pid }) + "\\n");
    setTimeout(() => {}, 30000);
  `;

  const controller = new AbortController();
  let grandchildPid = null;

  const run = runLocalCommand(process.execPath, ["-e", script], {
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "spawned") {
        grandchildPid = event.pid;
        controller.abort();
      }
    },
  });

  await assert.rejects(run, (error) => error.cancelled === true);
  assert.ok(grandchildPid, "expected the child to report its grandchild pid");

  // Give the kernel a moment to reap the group.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(
    () => process.kill(grandchildPid, 0),
    /ESRCH/u,
    "grandchild process survived cancellation",
  );
});
