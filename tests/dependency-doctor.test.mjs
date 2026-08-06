import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDoctorReport,
  installInstructionsForPlatform,
  summarizeDoctorReport,
} from "../lib/dependency-doctor.mjs";

test("prints platform-specific install help", () => {
  assert.match(installInstructionsForPlatform("darwin").join("\n"), /brew install/);
  assert.match(installInstructionsForPlatform("win32").join("\n"), /winget install/);
  assert.match(installInstructionsForPlatform("linux").join("\n"), /apt install/);
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
