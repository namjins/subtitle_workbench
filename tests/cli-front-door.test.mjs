import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { appVersion } from "../lib/conversion-cache.mjs";

const cli = join(fileURLToPath(new URL("..", import.meta.url)), "tools", "subtitle-workbench.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

const subcommands = [
  "ui",
  "doctor",
  "extract-english",
  "peek-sup",
  "sup-to-srt",
  "subidx-to-srt",
  "benchmark-ocr",
  "inspect-missing-ocr",
];

test("--help lists every documented subcommand", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  for (const command of subcommands) {
    assert.match(result.stdout, new RegExp(`subtitle-workbench ${command}\\b`), `missing ${command}`);
  }
});

test("no arguments prints usage and exits 0", () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subtitle Workbench CLI/u);
});

test("an unknown command exits non-zero and points at --help", () => {
  const result = runCli(["convert-everything"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command/u);
  assert.match(result.stderr, /--help/u);
});

test("--version prints the package version and exits 0", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), appVersion());
});

test("sup-to-srt --help prints usage instead of erroring on a missing input", () => {
  // --help used to fall through to the converter and die with "No input file".
  const result = runCli(["sup-to-srt", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subtitle Workbench CLI/u);
});

test("doctor --json emits a parseable report whose exit status matches readiness", () => {
  const result = runCli(["doctor", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.summary.ready, "boolean");
  // Assert the relationship, not a fixed status, so this passes on both a fully
  // provisioned machine and a bare CI runner.
  assert.equal(result.status, report.summary.ready ? 0 : 1);
});

test("an invalid --port is rejected rather than binding a random port", () => {
  const result = runCli(["ui", "--port", "not-a-port", "--no-open"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid port/u);
});
