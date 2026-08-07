type BridgeJob = {
  command: "sup-to-srt" | "subidx-to-srt" | "itt-to-srt";
  inputs: string[];
  language?: string;
  fps?: string;
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
  path: string;
  name: string;
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
  index: number;
};

// The bridge serves this bundle from its own origin, so requests are relative
// and same-origin in the shipped app. Only the Vite dev server (a different
// port) needs an explicit origin, which the bridge must be started with --dev
// to accept.
const bridgeOrigin = import.meta.env.DEV ? "http://127.0.0.1:8765" : "";

export async function runBridgeJob(
  job: BridgeJob,
  onEvent: (event: BridgeEvent) => void,
) {
  const response = await fetch(`${bridgeOrigin}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Local bridge returned ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (event) onEvent(event);
    }
  }

  if (buffer) {
    const event = parseSseEvent(buffer);
    if (event) onEvent(event);
  }
}

export async function uploadBridgeFiles(files: File[]) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  const response = await fetch(`${bridgeOrigin}/uploads`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Local bridge upload returned ${response.status}`);
  }
  return (await response.json()) as BridgeUpload;
}

export async function pickBridgeFile(extensions: string[]) {
  const response = await fetch(`${bridgeOrigin}/files/pick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extensions }),
  });
  if (!response.ok) {
    throw new Error(`Local bridge file picker returned ${response.status}`);
  }
  return (await response.json()) as BridgePickedFile;
}

export async function inspectBridgeVideo(input: string) {
  const response = await fetch(`${bridgeOrigin}/videos/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!response.ok) {
    throw new Error(`Local bridge video inspection returned ${response.status}`);
  }
  return (await response.json()) as {
    input: string;
    tracks: BridgeVideoTrack[];
  };
}

export async function extractBridgeVideo(input: string, tracks: BridgeVideoTrack[]) {
  const response = await fetch(`${bridgeOrigin}/videos/extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, tracks }),
  });
  if (!response.ok) {
    throw new Error(`Local bridge video extraction returned ${response.status}`);
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
