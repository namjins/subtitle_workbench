import assert from "node:assert/strict";
import test from "node:test";
import { createJobEvent, formatJobEvent } from "../lib/local-job-events.mjs";

test("formats local execution bridge events as JSON lines", () => {
  const event = createJobEvent("job-started", {
    input: "/tmp/movie.sup",
    output: "/tmp/movie.srt",
    language: "eng",
  });

  assert.equal(event.type, "job-started");
  assert.equal(event.input, "/tmp/movie.sup");
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/u);

  const line = formatJobEvent("job-finished", { output: "/tmp/movie.srt" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(JSON.parse(line).type, "job-finished");
});
