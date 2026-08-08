type BridgeJob = {
  command: "sup-to-srt" | "subidx-to-srt";
  inputs: string[];
  language?: string;
  outDir?: string;
  jobs?: number;
  ocrEngine?: string;
};

type BridgeEvent = {
  type: string;
  output?: string;
  [key: string]: unknown;
};

type BridgeUpload = {
  workspace: string;
  files: Array<{
    name: string;
    path: string;
    size: number;
  }>;
};

type BridgePickedFile = {
  // Both are null when the user cancelled the dialog.
  path: string | null;
  name: string | null;
};

export type BridgeVideoTrack = {
  id: string;
  trackId: number;
  label: string;
  languageCode: string;
  language: string;
  languageIetf?: string;
  codec: string;
  format: "sub + idx" | "sup";
  defaultTrack: boolean;
  forcedTrack: boolean;
  // Per-suffix output-name counter assigned by the bridge over the full track
  // list. It must round-trip back on extraction, or a subset extraction
  // renumbers from 0 and overwrites a sibling track's file.
  stemIndex: number;
};

// The bridge serves this bundle from its own origin, so requests are relative
// and same-origin in the shipped app. Only the Vite dev server (a different
// port) needs an explicit origin, which the bridge must be started with --dev
// to accept.
const bridgeOrigin = import.meta.env.DEV ? "http://127.0.0.1:8765" : "";

declare global {
  interface Window {
    __SUBTITLE_WORKBENCH_TOKEN__?: string;
  }
}

/**
 * The bridge injects a per-session token into the page it serves, so only a
 * document that came from the bridge can authenticate. Under `vite dev` the
 * page is served by Vite and has no token; the bridge must then be started
 * with --dev, which allowlists the dev origin instead.
 */
function bridgeHeaders(extra: Record<string, string> = {}) {
  const token = typeof window === "undefined" ? undefined : window.__SUBTITLE_WORKBENCH_TOKEN__;
  return token ? { ...extra, "x-subtitle-workbench-token": token } : extra;
}

export type BridgeDoctorReport = {
  summary: {
    ready: boolean;
    binaryFailures: Array<{ name: string }>;
    languageFailures: Array<{ language: string }>;
    // Tools that work but are lossier than they should be (e.g. Tesseract
    // below the version floor). Present but previously undeclared, so the UI
    // silently dropped them.
    warnings?: Array<{ name: string; warning: string }>;
  };
  install: string[];
};

/**
 * Read the bridge's JSON error body instead of discarding it. Every failure
 * path on the bridge sends { error: "<reason>" }; rendering only the status
 * turned "Uploaded file is too large" into "Local bridge upload returned 400".
 */
async function bridgeErrorFor(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  const message =
    body && typeof body.error === "string" && body.error
      ? body.error
      : `${fallback} (HTTP ${response.status})`;
  return new Error(message);
}

/**
 * Pull the last diagnostic line out of a failed job's stderr. Two traps:
 * the tail is usually noise (`FAILED movie.sup: node exited with 1`, the
 * batch summary, and the runner's own generic message repeat there), and OCR
 * progress lines can dominate. Walk backwards past the known-generic shapes
 * to the first line that actually says something.
 */
function lastMeaningfulStderrLine(stderr: string): string | null {
  const noise = [
    /exited with \d+$/u,
    /terminated by SIG\w+$/u,
    /^FAILED [^:]+: /u,
    /^\d+ of \d+ file\(s\) failed/u,
    /^\d+ file\(s\) failed to convert\.?$/u,
    /^OCR \d+\/\d+: /u,
    /^Wrote \d+ cues to /u,
    /^Starting /u,
    /^Recognising \d+ distinct/u,
    /^Probed \d+ frame/u,
  ];
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (noise.some((pattern) => pattern.test(line))) continue;
    return line;
  }
  return null;
}

export async function fetchBridgeDoctorReport(): Promise<BridgeDoctorReport> {
  const response = await fetch(`${bridgeOrigin}/doctor`, {
    headers: bridgeHeaders(),
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Dependency check failed");
  }
  return response.json();
}

export async function runBridgeJob(
  job: BridgeJob,
  onEvent: (event: BridgeEvent) => void,
  options: { signal?: AbortSignal } = {},
) {
  const response = await fetch(`${bridgeOrigin}/jobs`, {
    method: "POST",
    headers: bridgeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(job),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw await bridgeErrorFor(response, "Local bridge job request failed");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // The server writes HTTP 200 before the job starts, so response.ok says
  // nothing about whether it succeeded. Failures arrive as SSE events, and
  // ignoring them is what let a failed run render as a completed one.
  let failure: string | null = null;

  const handle = (event: BridgeEvent) => {
    if (event.type === "bridge-error" || event.type === "job-failed") {
      // job-failed and bridge-error both carry the runner's generic
      // "<node> exited with 1" — the real reason (a tesseract error, missing
      // traineddata) only travels in bridge-error's stderr. Prefer that.
      const fromStderr =
        typeof event.stderr === "string" && event.stderr
          ? lastMeaningfulStderrLine(event.stderr)
          : null;
      failure =
        fromStderr ??
        (typeof event.error === "string" && event.error
          ? event.error
          : "The local bridge reported a failed job.");
    }
    onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (event) handle(event);
    }
  }

  if (buffer) {
    const event = parseSseEvent(buffer);
    if (event) handle(event);
  }

  if (failure) throw new Error(failure);
}

export async function uploadBridgeFiles(
  files: File[],
  options: { signal?: AbortSignal } = {},
) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  // The signal matters here too: uploads run before the job starts, so a Stop
  // pressed during the upload phase would otherwise do nothing.
  const response = await fetch(`${bridgeOrigin}/uploads`, {
    method: "POST",
    headers: bridgeHeaders(),
    body: formData,
    signal: options.signal,
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Local bridge upload failed");
  }
  return (await response.json()) as BridgeUpload;
}

export async function pickBridgeFile(extensions: string[]) {
  const response = await fetch(`${bridgeOrigin}/files/pick`, {
    method: "POST",
    headers: bridgeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ extensions }),
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Local bridge file picker failed");
  }
  // A cancelled dialog comes back as { path: null } — a normal outcome the
  // caller should treat as "do nothing", not an error.
  return (await response.json()) as BridgePickedFile;
}

/** Ask the OS file manager to reveal this file in its folder. */
export async function revealBridgeFile(path: string) {
  const response = await fetch(`${bridgeOrigin}/files/reveal`, {
    method: "POST",
    headers: bridgeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Local bridge reveal failed");
  }
}

/** Multi-select variant; a cancelled dialog resolves to an empty array. */
export async function pickBridgeFiles(extensions: string[]) {
  const response = await fetch(`${bridgeOrigin}/files/pick`, {
    method: "POST",
    headers: bridgeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ extensions, multiple: true }),
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Local bridge file picker failed");
  }
  const result = (await response.json()) as { files?: BridgePickedFile[] };
  return (result.files ?? []).filter((file) => Boolean(file.path));
}

export async function inspectBridgeVideo(input: string) {
  const response = await fetch(`${bridgeOrigin}/videos/inspect`, {
    method: "POST",
    headers: bridgeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ input }),
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Local bridge video inspection failed");
  }
  return (await response.json()) as {
    input: string;
    tracks: BridgeVideoTrack[];
  };
}

export async function extractBridgeVideo(input: string, tracks: BridgeVideoTrack[]) {
  const response = await fetch(`${bridgeOrigin}/videos/extract`, {
    method: "POST",
    headers: bridgeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ input, tracks }),
  });
  if (!response.ok) {
    throw await bridgeErrorFor(response, "Local bridge video extraction failed");
  }
  return (await response.json()) as {
    input: string;
    outDir: string;
    outputs: string[];
    tracks: BridgeVideoTrack[];
  };
}

function parseSseEvent(chunk: string): BridgeEvent | null {
  const eventName = chunk.match(/^event:\s*(.+)$/mu)?.[1];
  const data = chunk.match(/^data:\s*(.+)$/mu)?.[1];
  if (!data) return eventName ? { type: eventName } : null;
  try {
    const parsed = JSON.parse(data) as BridgeEvent;
    // The SSE event name is authoritative: spreading `parsed` last would let a
    // payload `type` silently override it, which matters for bridge-error.
    return { ...parsed, type: eventName ?? parsed.type };
  } catch {
    return eventName ? { type: eventName } : null;
  }
}
