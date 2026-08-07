import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workbenchUrl = new URL("../app/SubtitleWorkbench.tsx", import.meta.url);
const clientUrl = new URL("../app/localBridgeClient.ts", import.meta.url);

/**
 * These assert on source text, which is weak, but the alternative is a full
 * DOM harness that Phase 2b-ii will introduce along with the state-model
 * rewrite. Until then these guard the specific regression that mattered most:
 * a run that produced nothing reporting itself as finished.
 */
test("the run handler has no simulated progress or success path", async () => {
  const workbench = await readFile(workbenchUrl, "utf8");

  // The old fallthrough was three setTimeouts ending in setOcrRunStatus("complete").
  const timerBlocks = workbench.match(/window\.setTimeout\(/gu) ?? [];
  assert.equal(
    timerBlocks.length,
    1,
    "only the extract progress animation should use a timer",
  );
  assert.match(
    workbench,
    /window\.clearTimeout\(advanceProgress\)/u,
    "the extract timer must be cancellable or a failure re-flips rows to extracting",
  );

  // Filenames shown to the user must come from the CLI, never be predicted.
  assert.doesNotMatch(workbench, /predictedSrtFiles/u);
  assert.doesNotMatch(
    workbench,
    /\$\{item\.name\}-\$\{item\.language\}\.srt/u,
    "predicted names can never match the CLI's <base>.srt output",
  );
  assert.match(workbench, /const visibleSrtFiles = completedSrtFiles;/u);
});

test("a failed run returns to idle rather than complete", async () => {
  const workbench = await readFile(workbenchUrl, "utf8");

  const start = workbench.indexOf("async function startBatch()");
  assert.ok(start > 0, "expected startBatch");
  const body = workbench.slice(start, workbench.indexOf("\n  }\n", start));

  const failurePath = body.slice(body.lastIndexOf("} catch (error) {"));
  assert.ok(failurePath.length > 0, "expected a catch block in startBatch");

  // The failure path must reset, not celebrate.
  assert.match(failurePath, /setOcrRunStatus\("idle"\)/u);
  assert.match(failurePath, /setCompletedSrtFiles\(\[\]\)/u);
  assert.doesNotMatch(failurePath, /setOcrRunStatus\("complete"\)/u);

  // Exactly one place may declare the run complete, and it is after the loop.
  assert.equal(
    (body.match(/setOcrRunStatus\("complete"\)/gu) ?? []).length,
    1,
    "success should be declared in exactly one place",
  );
});

test("in-flight runs cannot write into a different tool's panel", async () => {
  const workbench = await readFile(workbenchUrl, "utf8");

  // Switching tools or clearing invalidates the token, and every async write
  // checks it, so a job finishing later cannot land on the wrong screen.
  assert.match(workbench, /const runToken = useRef\(0\)/u);
  assert.match(workbench, /const isCurrentRun = \(\) => runToken\.current === token/u);
  assert.match(
    workbench,
    /function selectTool\(toolId: ToolId\) \{\s*\n\s*\/\/[^\n]*\n\s*runToken\.current \+= 1;/u,
    "selectTool must invalidate in-flight runs",
  );
});

test("the SSE client rejects when the bridge reports a failure", async () => {
  const client = await readFile(clientUrl, "utf8");

  // The server sends HTTP 200 before the job runs, so response.ok proves
  // nothing; failures only arrive as events.
  assert.match(client, /bridge-error/u);
  assert.match(client, /job-failed/u);
  assert.match(client, /if \(failure\) throw new Error\(failure\)/u);
});

test("bridge connection failures produce an actionable message", async () => {
  const workbench = await readFile(workbenchUrl, "utf8");

  // "Failed to fetch" on its own tells the user nothing; the usual cause is
  // that the bridge simply is not running.
  assert.match(workbench, /export function bridgeFailureMessage/u);
  assert.match(workbench, /Could not reach the local bridge/u);
  assert.match(workbench, /npm run app/u);
  assert.match(
    workbench,
    /setBridgeError\(bridgeFailureMessage\(error\)\)/u,
    "both run handlers should use it",
  );
});
