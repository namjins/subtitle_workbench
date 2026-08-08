import assert from "node:assert/strict";
import test from "node:test";
import { detectSafeJobs, maxAutomaticJobs } from "../lib/cpu-jobs.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBridgePort,
  safeUploadName,
  uniqueUploadName,
  validateExtractRequest,
  validateJob,
  validatePickRequest,
  validateRevealRequest,
  windowsPickScript,
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

test("shows the Windows file dialog owned by a topmost form", () => {
  // Regression: an unowned ShowDialog() opened the picker *behind* the browser,
  // because a background process cannot take focus. The dialog is modal, so the
  // app looked frozen. Verified on Windows 11 by z-order probe: unowned it sat
  // behind the browser, owned by this topmost form it comes out in front.
  const script = windowsPickScript({ extensions: ["sup"], multiple: true });
  assert.match(script, /\$owner\.TopMost = \$true/u);
  assert.match(script, /\$owner\.ShowInTaskbar = \$false/u);
  assert.match(script, /ShowDialog\(\$owner\)/u);
  // The owner must never be visible, and must always be cleaned up.
  assert.match(script, /SetBounds\(-32000, -32000, 1, 1\)/u);
  assert.match(script, /finally \{ \$owner\.Dispose\(\) \}/u);
  // A bare ShowDialog() is exactly the bug; it must not reappear.
  assert.doesNotMatch(script, /ShowDialog\(\)/u);

  assert.match(script, /\$d\.Multiselect = \$true/u);
  assert.match(windowsPickScript({}), /\$d\.Multiselect = \$false/u);
  assert.match(windowsPickScript({}), /All files/u);
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

test("rejects an outDir that looks like an option, on both endpoints", () => {
  // outDir reaches a spawned tool; a value like "-rf" must never arrive as a
  // flag. inputs were already guarded; outDir was the gap.
  assert.throws(
    () => validateJob({ command: "sup-to-srt", inputs: ["/tmp/movie.sup"], outDir: "-rf" }),
    /not an option/u,
  );
  assert.throws(
    () =>
      validateExtractRequest({
        input: "/tmp/movie.mkv",
        tracks: [{ trackId: 2, codec: "S_VOBSUB" }],
        outDir: "--output",
      }),
    /not an option/u,
  );
});

test("rejects a non-integer or negative stemIndex on extract requests", () => {
  const send = (stemIndex) =>
    validateExtractRequest({
      input: "/tmp/movie.mkv",
      tracks: [{ trackId: 2, codec: "S_VOBSUB", stemIndex }],
    });
  // stemIndex is interpolated into the output filename; a bad value could
  // collapse two tracks onto one file.
  assert.throws(() => send(-1), /non-negative integer/u);
  assert.throws(() => send(1.5), /non-negative integer/u);
  assert.throws(() => send("0"), /non-negative integer/u);
  // A well-formed request passes it through.
  assert.equal(
    send(2).tracks[0].stemIndex,
    2,
  );
});

test("reveal refuses anything but an absolute path to an existing file", () => {
  // One of only two paths where network data reaches an OS binary. The three
  // invariants — absolute, exists, is a file — are exactly what a refactor
  // quietly loosens.
  const dir = mkdtempSync(join(tmpdir(), "subtitle-workbench-reveal-"));
  try {
    const file = join(dir, "movie.srt");
    writeFileSync(file, "1\n");

    assert.deepEqual(validateRevealRequest({ path: file }), { path: file });
    assert.throws(() => validateRevealRequest({ path: "relative/movie.srt" }), /absolute/iu);
    assert.throws(() => validateRevealRequest({ path: dir }), /existing file/iu);
    assert.throws(() => validateRevealRequest({ path: join(dir, "missing.srt") }), /existing file/iu);
    assert.throws(() => validateRevealRequest({}), /absolute/iu);
    assert.throws(() => validateRevealRequest(null), /absolute/iu);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("suffixes colliding upload names instead of overwriting", () => {
  // Two files named movie.idx in one upload must not overwrite each other
  // before a conversion reads them.
  const used = new Map();
  assert.equal(uniqueUploadName("movie.idx", used), "movie.idx");
  assert.equal(uniqueUploadName("movie.idx", used), "movie-2.idx");
  assert.equal(uniqueUploadName("movie.idx", used), "movie-3.idx");
  assert.equal(uniqueUploadName("movie.sub", used), "movie.sub");
  assert.equal(uniqueUploadName("no-extension", used), "no-extension");
  assert.equal(uniqueUploadName("no-extension", used), "no-extension-2");
});

test("parses and validates a bridge port", () => {
  assert.equal(parseBridgePort("9000"), 9000);
  assert.equal(parseBridgePort(undefined), 8765);
  assert.equal(parseBridgePort(""), 8765);
  assert.equal(parseBridgePort("0"), 0);
  // NaN used to reach listen(), which then bound a random port and printed a
  // http://127.0.0.1:NaN/ banner.
  assert.throws(() => parseBridgePort("abc"), /Invalid port/u);
  assert.throws(() => parseBridgePort("70000"), /Invalid port/u);
  assert.throws(() => parseBridgePort("-1"), /Invalid port/u);
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
