import assert from "node:assert/strict";
import test from "node:test";
import { detectSafeJobs, normalizeJobs } from "../lib/cpu-jobs.mjs";

test("detects a conservative automatic job count", () => {
  assert.equal(detectSafeJobs({ cores: 1 }), 1);
  assert.equal(detectSafeJobs({ cores: 2 }), 1);
  assert.equal(detectSafeJobs({ cores: 6 }), 5);
  assert.equal(detectSafeJobs({ cores: 32 }), 8);
});

test("allows explicit job overrides while defaulting to auto", () => {
  assert.equal(normalizeJobs("4", { cores: 16 }), 4);
  assert.equal(normalizeJobs(12, { cores: 16 }), 12);
  assert.equal(normalizeJobs("auto", { cores: 16 }), 8);
  assert.equal(normalizeJobs("", { cores: 4 }), 3);
  assert.equal(normalizeJobs("not-a-number", { cores: 4 }), 3);
});
