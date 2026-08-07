import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeJobs } from "./cpu-jobs.mjs";
import { runSubtitleWorkbenchJob } from "./local-runner.mjs";
import { extractMkvTracks, inspectMkv } from "./video-extractor.mjs";

const allowedCommands = new Set(["sup-to-srt", "subidx-to-srt", "itt-to-srt"]);
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultUiRoot = join(repoRoot, "dist");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function createLocalBridgeServer(options = {}) {
  const runJob = options.runJob ?? runSubtitleWorkbenchJob;
  const pickFile = options.pickFile ?? pickLocalFile;
  const uiRoot = options.uiRoot === undefined ? defaultUiRoot : options.uiRoot;

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true }, request);
        return;
      }

      if (uiRoot && (request.method === "GET" || request.method === "HEAD")) {
        if (await serveUiAsset(request, response, uiRoot)) return;
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      if (request.method === "POST" && request.url === "/files/pick") {
        const body = JSON.parse(await readRequestBody(request));
        const result = await pickFile(validatePickRequest(body));
        sendJson(response, 200, result, request);
        return;
      }

      if (request.method === "POST" && request.url === "/uploads") {
        const result = await receiveUploadedFiles(request);
        sendJson(response, 200, result, request);
        return;
      }

      if (request.method === "POST" && request.url === "/videos/inspect") {
        const body = JSON.parse(await readRequestBody(request));
        if (typeof body.input !== "string" || !body.input) {
          throw badRequest("Video inspection requires an input path.");
        }
        sendJson(response, 200, inspectMkv(body.input), request);
        return;
      }

      if (request.method === "POST" && request.url === "/videos/extract") {
        const body = JSON.parse(await readRequestBody(request));
        if (typeof body.input !== "string" || !body.input) {
          throw badRequest("Video extraction requires an input path.");
        }
        if (!Array.isArray(body.tracks) || !body.tracks.length) {
          throw badRequest("Video extraction requires selected subtitle tracks.");
        }
        const result = await extractMkvTracks({
          input: body.input,
          tracks: body.tracks,
          outDir: typeof body.outDir === "string" ? body.outDir : undefined,
        });
        sendJson(response, 200, result, request);
        return;
      }

      if (request.method !== "POST" || request.url !== "/jobs") {
        sendJson(response, 404, { error: "Not found" }, request);
        return;
      }

      const job = validateJob(JSON.parse(await readRequestBody(request)));
      response.writeHead(200, {
        ...corsHeaders(request),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      writeSse(response, "bridge-accepted", {
        command: job.command,
        inputs: job.inputs,
      });

      const result = await runJob(job, {
        onEvent: (event) => writeSse(response, event.type, event),
      });

      writeSse(response, "bridge-complete", {
        status: result.status,
        events: result.events.length,
      });
      response.end();
    } catch (error) {
      if (response.headersSent) {
        writeSse(response, "bridge-error", {
          error: error.message,
          stderr: error.result?.stderr ?? "",
        });
        response.end();
      } else {
        sendJson(response, error.statusCode ?? 500, { error: error.message }, request);
      }
    }
  });
}

export function resolveUiAssetPath(uiRoot, requestUrl) {
  const root = resolve(uiRoot);
  const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  const relative = normalize(pathname).replace(/^(\.\.(?:[\\/]|$))+/u, "");
  const candidate = resolve(root, `.${sep}${relative}`);
  // Never serve outside the build directory, whatever the request path claims.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function readUiFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

async function serveUiAsset(request, response, uiRoot) {
  const target = resolveUiAssetPath(uiRoot, request.url ?? "/");
  if (!target) return false;

  const indexPath = join(resolve(uiRoot), "index.html");
  // Try the exact file, then the SPA entry so client-side routes still resolve.
  let servedPath = target;
  let body = await readUiFile(target);
  if (!body && !extname(target)) {
    servedPath = indexPath;
    body = await readUiFile(indexPath);
  }
  if (!body) return false;

  response.writeHead(200, {
    "content-type": contentTypes.get(extname(servedPath)) ?? "application/octet-stream",
    "content-length": body.length,
    // The bundle is content-hashed; the entry document must not be cached.
    "cache-control": extname(servedPath) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
  return true;
}

export function validatePickRequest(body) {
  const extensions = Array.isArray(body?.extensions)
    ? body.extensions
        .filter((extension) => typeof extension === "string")
        .map((extension) => extension.replace(/^\./u, "").toLowerCase())
        .filter((extension) => /^[a-z0-9]+$/u.test(extension))
    : [];
  return { extensions };
}

export async function pickLocalFile({ extensions = [] } = {}) {
  if (platform() !== "darwin") {
    const error = new Error("Native file picking is only available on macOS in this web bridge.");
    error.statusCode = 501;
    throw error;
  }

  const typeClause = extensions.length
    ? ` of type {${extensions.map((extension) => JSON.stringify(extension)).join(", ")}}`
    : "";
  const script = `POSIX path of (choose file with prompt "Choose a subtitle source file"${typeClause})`;
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    maxBuffer: 1024 * 1024,
  });
  const path = stdout.trim();
  return { path, name: basename(path) };
}

export function validateJob(body) {
  if (!body || typeof body !== "object") {
    throw badRequest("Request body must be a JSON object.");
  }
  if (!allowedCommands.has(body.command)) {
    throw badRequest("Unsupported subtitle job command.");
  }
  if (!Array.isArray(body.inputs) || !body.inputs.every((input) => typeof input === "string")) {
    throw badRequest("Job inputs must be an array of file paths.");
  }
  if (!body.inputs.length) {
    throw badRequest("At least one input file is required.");
  }
  return {
    command: body.command,
    inputs: body.inputs,
    language: typeof body.language === "string" ? body.language : "eng",
    fps: typeof body.fps === "string" || typeof body.fps === "number" ? body.fps : undefined,
    outDir: typeof body.outDir === "string" ? body.outDir : undefined,
    jobs: normalizeJobs(body.jobs),
    ocrEngine: typeof body.ocrEngine === "string" ? body.ocrEngine : "auto",
    ocrCommand: typeof body.ocrCommand === "string" ? body.ocrCommand : undefined,
  };
}

export function writeSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function safeUploadName(name) {
  const clean = basename(String(name || "subtitle-file"))
    .replace(/[^\w .()[\]-]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  return clean || "subtitle-file";
}

async function receiveUploadedFiles(request) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) {
    throw badRequest("Uploads must use multipart/form-data.");
  }

  const webRequest = new Request("http://127.0.0.1/uploads", {
    method: "POST",
    headers: { "content-type": contentType },
    body: Readable.toWeb(request),
    duplex: "half",
  });
  const formData = await webRequest.formData();
  const files = formData.getAll("files").filter((file) => file instanceof File);
  if (!files.length) throw badRequest("At least one file is required.");

  const workspace = await mkdtemp(join(tmpdir(), "subtitle-workbench-"));
  const uploaded = [];
  const usedNames = new Map();
  for (const file of files) {
    const safeName = uniqueUploadName(safeUploadName(file.name), usedNames);
    const path = join(workspace, safeName);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    uploaded.push({
      name: file.name,
      path,
      size: file.size,
    });
  }

  return { workspace, files: uploaded };
}

function uniqueUploadName(name, usedNames) {
  const count = usedNames.get(name) ?? 0;
  usedNames.set(name, count + 1);
  if (!count) return name;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem}-${count + 1}${extension}`;
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw badRequest("Request body is too large.");
  }
  return body || "{}";
}

function sendJson(response, status, body, request) {
  response.writeHead(status, {
    ...corsHeaders(request),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function corsHeaders(request) {
  const origin = request?.headers?.origin;
  const allowedOrigin =
    typeof origin === "string" && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/u.test(origin)
      ? origin
      : "http://localhost:3000";
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
