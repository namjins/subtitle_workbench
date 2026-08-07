import assert from "node:assert/strict";
import test from "node:test";
import { detectSafeJobs, maxAutomaticJobs, normalizeJobs } from "../lib/cpu-jobs.mjs";

test("scales the automatic job count with the machine", () => {
  // One core is reserved so the machine stays usable during a long batch.
  assert.equal(detectSafeJobs({ cores: 1 }), 1);
  assert.equal(detectSafeJobs({ cores: 2 }), 1);
  assert.equal(detectSafeJobs({ cores: 6 }), 5);
  assert.equal(detectSafeJobs({ cores: 12 }), 11);

  // Large machines are capped, but not at a number small enough to waste them.
  // This used to cap at 8, so a 24-core host ran 8 workers and left two thirds
  // of the CPU idle.
  assert.equal(detectSafeJobs({ cores: 24 }), maxAutomaticJobs);
  assert.equal(detectSafeJobs({ cores: 64 }), maxAutomaticJobs);
  assert.ok(maxAutomaticJobs >= 16, "the ceiling should not throttle a big machine");
});

test("allows explicit job overrides while defaulting to auto", () => {
  assert.equal(normalizeJobs("4", { cores: 16 }), 4);
  assert.equal(normalizeJobs(12, { cores: 16 }), 12);
  assert.equal(normalizeJobs("auto", { cores: 16 }), 15);
  assert.equal(normalizeJobs("", { cores: 4 }), 3);
  assert.equal(normalizeJobs("not-a-number", { cores: 4 }), 3);
});

test("clamps only values that arrive over the network", () => {
  // A human asking for 32 gets 32; the same number in an HTTP body does not.
  assert.equal(normalizeJobs(32, { cores: 24 }), 32);
  assert.equal(normalizeJobs(32, { cores: 24, clamp: true }), maxAutomaticJobs);
});
