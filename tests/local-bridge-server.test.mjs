import assert from "node:assert/strict";
import test from "node:test";
import { detectSafeJobs, maxAutomaticJobs } from "../lib/cpu-jobs.mjs";
import {
  safeUploadName,
  validateJob,
  validatePickRequest,
  writeSse,
} from "../lib/local-bridge-server.mjs";

test("validates local bridge job requests", () => {
  assert.deepEqual(
    validateJob({
      command: "sup-to-srt",
      inputs: ["/tmp/movie.sup"],
      language: "eng",
      jobs: "4",
    }),
    {
      command: "sup-to-srt",
      inputs: ["/tmp/movie.sup"],
      language: "eng",
      outDir: undefined,
      jobs: 4,
      ocrEngine: "auto",
    },
  );
  assert.throws(() => validateJob({ command: "rm", inputs: ["x"] }), /Unsupported/u);
  assert.throws(() => validateJob({ command: "sup-to-srt", inputs: [] }), /At least one/u);
});

test("refuses the removed ITT command", () => {
  // itt-to-srt was removed as a product surface; a stale client or replayed
  // request must not resurrect it.
  assert.throws(
    () => validateJob({ command: "itt-to-srt", inputs: ["/tmp/captions.itt"] }),
    /Unsupported/u,
  );
});

test("defaults bridge jobs to the safe automatic count", () => {
  assert.equal(
    validateJob({ command: "sup-to-srt", inputs: ["/tmp/movie.sup"] }).jobs,
    detectSafeJobs(),
  );
});

test("formats bridge events as Server-Sent Events", () => {
  let body = "";
  writeSse(
    {
      write: (chunk) => {
        body += chunk;
      },
    },
    "job-finished",
    { output: "/tmp/movie.srt" },
  );

  assert.match(body, /^event: job-finished\n/u);
  assert.equal(body.includes('data: {"output":"/tmp/movie.srt"}\n\n'), true);
});

test("sanitizes uploaded file names before writing bridge temp files", () => {
  assert.equal(safeUploadName("../Movie:Track?.sup"), "Movie_Track_.sup");
  assert.equal(safeUploadName("  Spy Game (2001).idx  "), "Spy Game (2001).idx");
  assert.equal(safeUploadName(""), "subtitle-file");
});

test("validates native file picker requests", () => {
  assert.deepEqual(validatePickRequest({ extensions: [".mkv", "SUP", "../bad"] }), {
    extensions: ["mkv", "sup"],
    multiple: false,
  });
  assert.deepEqual(validatePickRequest({}), { extensions: [], multiple: false });
});

test("refuses ocrCommand from the network", () => {
  // ocrCommand names a binary to execute, so it stays a CLI/env-only option
  // and is dropped rather than forwarded.
  const job = validateJob({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
    ocrCommand: "/bin/sh",
  });
  assert.equal("ocrCommand" in job, false);

  // The engine that would need it is not selectable over HTTP either.
  assert.throws(
    () =>
      validateJob({
        command: "sup-to-srt",
        inputs: ["/tmp/movie.sup"],
        ocrEngine: "external-command",
      }),
    /Unsupported OCR engine/u,
  );
});

test("rejects job inputs that look like options", () => {
  assert.throws(
    () => validateJob({ command: "sup-to-srt", inputs: ["--ocr-command"] }),
    /not options/u,
  );
});

test("clamps a network-supplied job count", () => {
  const job = validateJob({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
    jobs: 10000,
  });
  assert.ok(job.jobs <= maxAutomaticJobs, `expected clamped jobs, got ${job.jobs}`);
});

test("validates pick requests, including multi-select", () => {
  assert.deepEqual(validatePickRequest({ extensions: [".SUP", "idx", "bad ext"] }), {
    extensions: ["sup", "idx"],
    multiple: false,
  });
  assert.deepEqual(validatePickRequest({ extensions: [], multiple: true }), {
    extensions: [],
    multiple: true,
  });
  // Anything other than a literal true must not switch modes.
  assert.equal(validatePickRequest({ multiple: "yes" }).multiple, false);
});
