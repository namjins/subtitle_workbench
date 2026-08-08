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

  // Zero, not one: the last timer was the extract panel's 28→65→100 animation
  // against a non-streaming endpoint — fiction, and now removed. Any new timer
  // in this component needs a very good reason; the honest treatment for an
  // operation with no progress signal is the indeterminate meter.
  const timerBlocks = workbench.match(/window\.setTimeout\(/gu) ?? [];
  assert.equal(timerBlocks.length, 0, "no simulated progress timers");

  // Filenames shown to the user must come from the CLI, never be predicted —
  // on both panels. The extract side re-grew a predicted list once.
  assert.doesNotMatch(workbench, /predictedSrtFiles/u);
  assert.doesNotMatch(workbench, /extractFileBase/u);
  assert.doesNotMatch(
    workbench,
    /\$\{item\.name\}-\$\{item\.language\}\.srt/u,
    "predicted names can never match the CLI's <base>-<lang>.srt output",
  );
  assert.match(workbench, /const visibleSrtFiles = completedSrtFiles;/u);
  assert.match(workbench, /const visibleExtractFiles = completedExtractFiles;/u);
});

test("a failed run returns to idle rather than complete", async () => {
  const workbench = await readFile(workbenchUrl, "utf8");

  const start = workbench.indexOf("async function startBatch()");
  assert.ok(start > 0, "expected startBatch");
  const body = workbench.slice(start, workbench.indexOf("\n  }\n", start));

  const catchStart = body.lastIndexOf("} catch (error) {");
  assert.ok(catchStart > 0, "expected a catch block in startBatch");
  const failurePath = body.slice(catchStart);

  // The failure path must reset, not celebrate. It now *keeps* the outputs
  // that did finish (the CLI deliberately converts the rest of a batch past a
  // bad file) — which is only safe because the success banner and reveal
  // button are gated on ocrRunStatus === "complete", asserted below.
  assert.match(failurePath, /setOcrRunStatus\("idle"\)/u);
  assert.doesNotMatch(failurePath, /setOcrRunStatus\("complete"\)/u);

  // Exactly one place may declare the run complete, and it is after the loop.
  assert.equal(
    (body.match(/setOcrRunStatus\("complete"\)/gu) ?? []).length,
    1,
    "success should be declared in exactly one place",
  );

  // The status gate that makes keeping partial outputs safe: the "ready"
  // heading only renders in the complete state. Weakening this reopens
  // "a failed run looks successful".
  assert.match(
    workbench,
    /\{ocrRunStatus === "complete"\s*\n\s*\? "SRT files ready"/u,
    "the success heading must stay gated on the complete status",
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
