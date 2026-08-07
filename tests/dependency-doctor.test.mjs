import assert from "node:assert/strict";
import test from "node:test";
import { resolveImageMagickCommand } from "../lib/platform-paths.mjs";
import {
  formatDoctorReport,
  installInstructionsForPlatform,
  isBelowMinimumVersion,
  parseVersionTriple,
  runBinaryCheck,
  summarizeDoctorReport,
} from "../lib/dependency-doctor.mjs";

test("prints platform-specific install help", () => {
  assert.match(installInstructionsForPlatform("darwin").join("\n"), /brew install/);
  assert.match(installInstructionsForPlatform("win32").join("\n"), /winget install/);
  assert.match(installInstructionsForPlatform("linux").join("\n"), /apt install/);
});

test("never tries the `convert` alternate on Windows", () => {
  const check = {
    name: "magick",
    command: "magick",
    alternates: ["convert"],
    args: ["-version"],
    required: true,
  };
  const lookup = (name) => (name === "convert" ? "C:\\Windows\\System32\\convert.exe" : null);

  const winResult = runBinaryCheck(check, { platform: "win32", lookup });
  assert.equal(winResult.path, null);
  assert.equal(winResult.error, "Not found on PATH");

  const macResult = runBinaryCheck(check, { platform: "darwin", lookup });
  assert.equal(macResult.path, "C:\\Windows\\System32\\convert.exe");
});

test("warns about a Tesseract older than the version floor", () => {
  // Measured on Windows: 5.4.0 recognises three low-contrast drop-shadowed
  // frames as empty, and an empty recognition drops the cue outright -- 6 cues
  // lost across the SUP corpus. 5.5.3 reads them, matching the macOS baseline.
  assert.deepEqual(parseVersionTriple("tesseract v5.5.3.20260724"), [5, 5, 3]);
  assert.deepEqual(parseVersionTriple("tesseract v5.4.0.20240606"), [5, 4, 0]);
  assert.equal(parseVersionTriple("no digits here"), null);

  assert.equal(isBelowMinimumVersion("tesseract v5.4.0.20240606", "5.5.0"), true);
  assert.equal(isBelowMinimumVersion("tesseract v5.5.0.20241111", "5.5.0"), false);
  assert.equal(isBelowMinimumVersion("tesseract v5.5.3.20260724", "5.5.0"), false);
  assert.equal(isBelowMinimumVersion("tesseract v6.0.0", "5.5.0"), false);
  assert.equal(isBelowMinimumVersion("tesseract v4.1.1", "5.5.0"), true);
  // An unrecognised banner must never claim the tool is too old.
  assert.equal(isBelowMinimumVersion("tesseract (unknown build)", "5.5.0"), false);
  assert.equal(isBelowMinimumVersion(null, "5.5.0"), false);
});

test("an out-of-date tool warns without making the install unready", () => {
  const report = {
    binaries: [
      { name: "tesseract", ok: true, required: true, warning: "Older than 5.5.0; ..." },
    ],
    languages: [],
  };
  const summary = summarizeDoctorReport(report);
  // Lossier, not broken: the conversion still runs.
  assert.equal(summary.ready, true);
  assert.equal(summary.warnings.length, 1);

  const output = formatDoctorReport({
    platform: "win32",
    arch: "x64",
    binaries: [
      {
        name: "tesseract",
        ok: true,
        path: "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
        version: "tesseract v5.4.0.20240606",
        warning: "Older than 5.5.0; some subtitle frames are recognised as empty.",
      },
    ],
    languages: [],
    install: installInstructionsForPlatform("win32"),
    summary: { ready: true, warnings: [{ name: "tesseract" }] },
  });
  assert.match(output, /OLD\s+tesseract/u);
  assert.match(output, /recognised as empty/u);
  assert.match(output, /with warnings above/u);
});

test("summarizes binary and language failures", () => {
  const report = {
    binaries: [
      { name: "node", ok: true, required: true },
      { name: "ffmpeg", ok: false, required: true },
    ],
    languages: [{ name: "tesseract language: eng", ok: false, required: true }],
  };

  const summary = summarizeDoctorReport(report);
  assert.equal(summary.ready, false);
  assert.equal(summary.binaryFailures.length, 1);
  assert.equal(summary.binaryFailures[0].name, "ffmpeg");
  assert.equal(summary.languageFailures.length, 1);
});

test("formats a readable doctor report", () => {
  const output = formatDoctorReport({
    platform: "darwin",
    arch: "arm64",
    binaries: [
      {
        name: "node",
        ok: true,
        path: "/opt/homebrew/bin/node",
        version: "v26.6.0",
      },
      {
        name: "ffmpeg",
        ok: false,
        path: null,
        version: null,
        error: "Not found on PATH",
      },
    ],
    languages: [
      {
        language: "eng",
        ok: false,
        error: 'Language data "eng" is not installed.',
      },
    ],
    install: installInstructionsForPlatform("darwin"),
    summary: {
      ready: false,
    },
  });

  assert.match(output, /Subtitle Workbench doctor/);
  assert.match(output, /Platform: darwin arm64/);
  assert.match(output, /Status: missing requirements/);
  assert.match(output, /MISSING\s+ffmpeg/);
  assert.match(
    formatDoctorReport({
      platform: "darwin",
      arch: "arm64",
      binaries: [
        {
          name: "mkvinfo",
          ok: false,
          path: "/opt/homebrew/bin/mkvinfo",
          version: "dyld: Library not loaded",
          error: "Terminated by SIGABRT",
        },
      ],
      languages: [],
      install: installInstructionsForPlatform("darwin"),
      summary: { ready: false },
    }),
    /BROKEN\s+mkvinfo/,
  );
  assert.match(output, /Language data "eng" is not installed/);
  assert.match(output, /brew install node ffmpeg tesseract imagemagick mkvtoolnix/);
});

test("the pipeline's ImageMagick fallback carries the same Windows guard", () => {
  // Same trap runBinaryCheck guards against: System32's convert.exe is a
  // disk utility, and accepting it passes preflight then fails
  // mid-conversion. Found by fixing doctor and forgetting the pipeline.
  const lookup = (name) => name === "convert";

  assert.equal(resolveImageMagickCommand({ platform: "win32", lookup }), null);
  assert.equal(resolveImageMagickCommand({ platform: "darwin", lookup }), "convert");
  assert.equal(resolveImageMagickCommand({ platform: "linux", lookup }), "convert");
  assert.equal(
    resolveImageMagickCommand({ platform: "win32", lookup: (name) => name === "magick" }),
    "magick",
  );
});
