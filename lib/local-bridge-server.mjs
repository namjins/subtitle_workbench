import { createServer } from "node:http";
import { statSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeJobs } from "./cpu-jobs.mjs";
import { buildDoctorReport } from "./dependency-doctor.mjs";
import { runSubtitleWorkbenchJob } from "./local-runner.mjs";
import { extractMkvTracks, inspectMkv, subtitleCodecs } from "./video-extractor.mjs";

export const defaultBridgePort = 8765;

/**
 * Parse a bridge port from a CLI arg or env var. `--port abc` used to yield
 * NaN, which listen() then treats as "pick any free port" — so the banner and
 * the browser both got http://127.0.0.1:NaN/. Reject anything that is not a
 * valid port number instead.
 */
export function parseBridgePort(value, fallback = defaultBridgePort) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}. Expected an integer between 0 and 65535.`);
  }
  return port;
}

const allowedCommands = new Set(["sup-to-srt", "subidx-to-srt"]);
// `external-command` is intentionally excluded: selecting it is only useful
// alongside an ocrCommand, which the bridge does not accept.
const allowedOcrEngines = new Set([
  "auto",
  "macos-vision",
  "tesseract",
  "tesseract-accurate",
  "tesseract-hybrid",
]);
const extractableCodecs = subtitleCodecs;
const maxUploadFileBytes = 64 * 1024 * 1024;
const maxUploadTotalBytes = 256 * 1024 * 1024;
const maxConcurrentJobs = 4;
const jobTimeoutMs = 6 * 60 * 60 * 1000;
let activeJobs = 0;
// The static handler runs first so the UI loads without a token, but it must
// never answer for an API route: the SPA fallback would otherwise return
// index.html for GET /health and every JSON client would see "<!doctype".
const apiPaths = new Set([
  "/doctor",
  "/files/reveal",
  "/health",
  "/jobs",
  "/uploads",
  "/files/pick",
  "/videos/inspect",
  "/videos/extract",
]);
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
  const revealFile = options.revealFile ?? revealLocalFile;
  const uiRoot = options.uiRoot === undefined ? defaultUiRoot : options.uiRoot;
  // A page served by this bridge gets the token injected; anything else has to
  // be told it out of band. Tests can pass `token: null` to opt out.
  const token = options.token === undefined ? randomUUID() : options.token;
  const devOrigins = options.devOrigins ?? [];

  const server = createServer(async (request, response) => {
    try {
      // The Host check runs before the static handler, unlike the token and
      // Origin checks (the UI must load without a token). The served HTML has
      // the session token injected into it, so a DNS-rebinding page framing
      // this bridge under its own hostname would otherwise read the token out
      // of a same-origin document.
      if (!isLoopbackHost(request.headers?.host ?? "")) {
        sendJson(response, 403, { error: "Bridge only accepts loopback requests." });
        return;
      }

      if (uiRoot && (request.method === "GET" || request.method === "HEAD")) {
        if (await serveUiAsset(request, response, uiRoot, token)) return;
      }

      // Everything past this point can act on the machine, so it is gated.
      // Health is included: it is a probe for "is a bridge here", and an
      // unauthenticated one lets any page fingerprint the install.
      const denial = checkRequestAuthorization(request, { token, devOrigins });
      if (denial) {
        sendJson(response, denial.status, { error: denial.message });
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && request.url === "/doctor") {
        // The UI asks once at startup and shows a banner only when something
        // is missing; when everything is present the user sees nothing.
        sendJson(response, 200, buildDoctorReport());
        return;
      }

      if (request.method === "POST" && request.url === "/files/reveal") {
        const body = await readJsonBody(request);
        await revealFile(validateRevealRequest(body));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && request.url === "/files/pick") {
        const body = await readJsonBody(request);
        const result = await pickFile(validatePickRequest(body));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && request.url === "/uploads") {
        const result = await receiveUploadedFiles(request);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && request.url === "/videos/inspect") {
        const body = await readJsonBody(request);
        if (typeof body.input !== "string" || !body.input) {
          throw badRequest("Video inspection requires an input path.");
        }
        sendJson(response, 200, await inspectMkv(body.input));
        return;
      }

      if (request.method === "POST" && request.url === "/videos/extract") {
        const result = await extractMkvTracks(
          validateExtractRequest(await readJsonBody(request)),
        );
        sendJson(response, 200, result);
        return;
      }

      if (request.method !== "POST" || request.url !== "/jobs") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const job = validateJob(await readJsonBody(request));
      if (activeJobs >= maxConcurrentJobs) {
        throw tooManyRequests(
          `The bridge is already running ${maxConcurrentJobs} jobs. Wait for one to finish.`,
        );
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      writeSse(response, "bridge-accepted", {
        command: job.command,
        inputs: job.inputs,
      });

      // Closing the tab must stop the work. Without this the whole
      // node -> ocr_image_subs -> N x (tesseract|magick) tree ran to
      // completion for a client that had already gone away.
      const controller = new AbortController();
      const onClose = () => controller.abort();
      request.on("close", onClose);

      activeJobs += 1;
      try {
        const result = await runJob(job, {
          signal: controller.signal,
          timeoutMs: jobTimeoutMs,
          onEvent: (event) => writeSse(response, event.type, event),
        });

        writeSse(response, "bridge-complete", {
          status: result.status,
          events: result.events.length,
        });
      } finally {
        activeJobs -= 1;
        request.off("close", onClose);
      }
      response.end();
    } catch (error) {
      if (response.headersSent) {
        writeSse(response, "bridge-error", {
          error: error.message,
          stderr: error.result?.stderr ?? "",
        });
        response.end();
      } else {
        sendJson(response, error.statusCode ?? 500, { error: error.message });
      }
    }
  });

  server.sessionToken = token;
  return server;
}

/**
 * The bridge can start jobs, read and write files, and spawn processes, so it
 * treats itself as a same-origin-only API. A browser cannot forge `Origin` or
 * `Host`, and a page that is not served by this bridge cannot read the token,
 * which together close the drive-by CSRF path that plain CORS headers do not:
 * CORS restricts reading a response, never the side effect of sending it.
 */
export function checkRequestAuthorization(request, { token, devOrigins = [] } = {}) {
  const host = request.headers?.host ?? "";
  if (!isLoopbackHost(host)) {
    // Blocks DNS rebinding: a hostile name resolved to 127.0.0.1 still carries
    // its own Host header.
    return { status: 403, message: "Bridge only accepts loopback requests." };
  }

  const origin = request.headers?.origin;
  if (typeof origin === "string" && origin && origin !== "null") {
    const allowed = [`http://${host}`, ...devOrigins];
    if (!allowed.includes(origin)) {
      return { status: 403, message: "Cross-origin requests are not accepted." };
    }
  }

  if (token) {
    const provided = request.headers?.["x-subtitle-workbench-token"];
    if (provided !== token) {
      return { status: 403, message: "Missing or invalid bridge session token." };
    }
  }

  return null;
}

function isLoopbackHost(host) {
  const name = String(host).replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
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

async function serveUiAsset(request, response, uiRoot, token) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (apiPaths.has(pathname)) return false;

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

  if (token && extname(servedPath) === ".html") {
    // Hand the session token to the page the bridge itself served. Only a
    // same-origin document can read it back out.
    body = Buffer.from(
      body
        .toString("utf8")
        .replace(
          "</head>",
          `<script>window.__SUBTITLE_WORKBENCH_TOKEN__=${JSON.stringify(token)}</script></head>`,
        ),
      "utf8",
    );
  }

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
  return { extensions, multiple: body?.multiple === true };
}

/** Cancelling the dialog is a normal outcome, not a failure. */
function isPickCancellation(error) {
  return /-128|cancel/iu.test(String(error?.message ?? error ?? ""));
}

export function validateRevealRequest(body) {
  const path = typeof body?.path === "string" ? body.path : "";
  // Reveal never executes what it is given: the binary is fixed per platform
  // and the path is only ever an argument. Still, only absolute paths to
  // files that actually exist are accepted — anything else is refused, not
  // guessed at.
  if (!path || !isAbsolute(path)) {
    throw badRequest("Reveal needs an absolute file path.");
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    stats = null;
  }
  if (!stats?.isFile()) {
    throw badRequest("Reveal needs a path to an existing file.");
  }
  return { path };
}

export async function revealLocalFile({ path }) {
  // Fixed binary per platform; the path is an argument, never a command.
  if (platform() === "darwin") {
    await execFileAsync("open", ["-R", path]);
    return;
  }
  if (platform() === "win32") {
    // explorer exits non-zero even on success; the window opening is the
    // contract, not the exit code.
    await execFileAsync("explorer", [`/select,${path}`]).catch(() => {});
    return;
  }
  await execFileAsync("xdg-open", [dirname(path)]);
}

export async function pickLocalFile({ extensions = [], multiple = false } = {}) {
  // The bridge always runs on the user's own machine, so a native picker is
  // available on every platform; which binary drives it differs.
  if (platform() === "win32") {
    return pickWindowsFile({ extensions, multiple });
  }
  if (platform() !== "darwin") {
    return pickLinuxFile({ extensions, multiple });
  }

  const typeClause = extensions.length
    ? ` of type {${extensions.map((extension) => JSON.stringify(extension)).join(", ")}}`
    : "";
  const multipleClause = multiple ? " with multiple selections allowed" : "";
  const script = [
    `set picked to choose file with prompt "Choose a subtitle source file"${typeClause}${multipleClause}`,
    // A single choice is an alias, a multiple choice is a list of them;
    // normalising to one POSIX path per line covers both.
    `if class of picked is not list then set picked to {picked}`,
    `set output to ""`,
    `repeat with f in picked`,
    `  set output to output & POSIX path of f & linefeed`,
    `end repeat`,
    `output`,
  ].join("\n");

  let stdout;
  try {
    ({ stdout } = await execFileAsync("osascript", ["-e", script], {
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    // Cancel used to surface as a 500, which the UI reported as "native
    // picking is unavailable" — wrong on both counts.
    if (isPickCancellation(error)) return { path: null, name: null, files: [] };
    throw error;
  }

  return pickedFromLines(stdout);
}

function pickedFromLines(stdout) {
  const files = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({ path, name: basename(path) }));
  const first = files[0] ?? { path: null, name: null };
  return { path: first.path, name: first.name, files };
}

/**
 * The dialog is shown owned by an off-screen TopMost form rather than with a
 * bare ShowDialog(). Unowned, it opened *behind* the browser: this PowerShell
 * child is not the foreground process, and Windows refuses to let a background
 * process take focus, so the dialog landed below whatever was foreground — the
 * page the user had just clicked in. Being modal, the app then looks frozen:
 * you press Browse and nothing happens.
 *
 * TopMost is what actually fixes it, not the focus attempt. WS_EX_TOPMOST
 * renders above every non-topmost window regardless of focus, and a dialog
 * owned by a topmost window sits in that band too. Measured on Windows 11:
 * unowned the dialog sat behind the browser (topmost=False, foreground=False);
 * owned it comes out in front. The owner is parked at -32000,-32000 at 1x1 so
 * it is never visible itself.
 */
export function windowsPickScript({ extensions = [], multiple = false } = {}) {
  const filter = extensions.length
    ? `Subtitle files (${extensions.map((e) => `*.${e}`).join(";")})|${extensions
        .map((e) => `*.${e}`)
        .join(";")}`
    : "All files (*.*)|*.*";
  return [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Filter = '${filter}'`,
    `$d.Multiselect = $${multiple ? "true" : "false"}`,
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.StartPosition = 'Manual'",
    "$owner.SetBounds(-32000, -32000, 1, 1)",
    "$owner.ShowInTaskbar = $false",
    "$owner.TopMost = $true",
    "$owner.Show()",
    "$owner.Activate()",
    // A cancelled dialog prints nothing and exits 0, so it parses as no files.
    "try { if ($d.ShowDialog($owner) -eq 'OK') { $d.FileNames | ForEach-Object { Write-Output $_ } } } finally { $owner.Dispose() }",
  ].join("; ");
}

async function pickWindowsFile({ extensions, multiple }) {
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", windowsPickScript({ extensions, multiple })],
    { maxBuffer: 1024 * 1024 },
  );
  return pickedFromLines(stdout);
}

async function pickLinuxFile({ extensions, multiple }) {
  const args = ["--file-selection", "--separator", "\n"];
  if (multiple) args.push("--multiple");
  if (extensions.length) {
    args.push(`--file-filter=Subtitle files | ${extensions.map((e) => `*.${e}`).join(" ")}`);
  }
  try {
    const { stdout } = await execFileAsync("zenity", args, { maxBuffer: 1024 * 1024 });
    return pickedFromLines(stdout);
  } catch (error) {
    // zenity exits 1 on cancel with empty output; a missing binary is the
    // real "unavailable" case.
    if (error?.code === "ENOENT") {
      const unavailable = new Error(
        "Native file picking needs `zenity` installed on this system.",
      );
      unavailable.statusCode = 501;
      throw unavailable;
    }
    return pickedFromLines("");
  }
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
  // An input that looks like a flag would be parsed as one by the CLI. The
  // argv builder also passes `--` before positionals, so this is defence in
  // depth rather than the only guard.
  if (body.inputs.some((input) => input.startsWith("-"))) {
    throw badRequest("Job inputs must be file paths, not options.");
  }
  if (body.language !== undefined && !isLanguageCode(body.language)) {
    throw badRequest("Job language must be a 2-3 letter code.");
  }
  if (body.ocrEngine !== undefined && !allowedOcrEngines.has(body.ocrEngine)) {
    throw badRequest("Unsupported OCR engine.");
  }
  if (typeof body.outDir === "string" && body.outDir.startsWith("-")) {
    // Same rejection as inputs: `-rf` or `--anything` must never reach the
    // CLI looking like an option.
    throw badRequest("Output directory must be a path, not an option.");
  }
  return {
    command: body.command,
    inputs: body.inputs,
    language: typeof body.language === "string" ? body.language : "eng",
    outDir: typeof body.outDir === "string" ? body.outDir : undefined,
    // Clamp only what arrives over the network. The CLI still honours an
    // explicit `--jobs 12` from a human who means it.
    jobs: normalizeJobs(body.jobs, { clamp: true }),
    ocrEngine: typeof body.ocrEngine === "string" ? body.ocrEngine : "auto",
    // `ocrCommand` is deliberately absent: it names a binary to execute, and
    // nothing that arrives over HTTP should be able to choose that. The
    // external-command engine stays available through the CLI flag and
    // SUBTITLE_WORKBENCH_OCR_COMMAND.
  };
}

export function validateExtractRequest(body) {
  if (!body || typeof body !== "object") {
    throw badRequest("Request body must be a JSON object.");
  }
  if (typeof body.input !== "string" || !body.input) {
    throw badRequest("Video extraction requires an input path.");
  }
  if (!Array.isArray(body.tracks) || !body.tracks.length) {
    throw badRequest("Video extraction requires selected subtitle tracks.");
  }

  const tracks = body.tracks.map((track) => {
    if (!track || typeof track !== "object") {
      throw badRequest("Each subtitle track must be an object.");
    }
    // trackId is interpolated into the `<id>:<path>` spec handed to
    // mkvextract, and languageCode into the output filename.
    if (!/^\d+$/u.test(String(track.trackId))) {
      throw badRequest("Track id must be a number.");
    }
    if (track.languageCode !== undefined && !isLanguageCode(track.languageCode)) {
      throw badRequest("Track language must be a 2-3 letter code.");
    }
    if (!extractableCodecs.has(track.codec)) {
      throw badRequest("Unsupported subtitle codec for extraction.");
    }
    // stemIndex flows straight into the output filename, and a duplicated or
    // non-integer value could collapse two tracks onto one file. The plan
    // builder re-checks uniqueness, but network input is validated here.
    if (
      track.stemIndex !== undefined &&
      (!Number.isInteger(track.stemIndex) || track.stemIndex < 0)
    ) {
      throw badRequest("Track stemIndex must be a non-negative integer.");
    }
    return {
      ...track,
      trackId: Number(track.trackId),
      languageCode: track.languageCode ?? "und",
      forcedTrack: Boolean(track.forcedTrack),
    };
  });

  if (typeof body.outDir === "string" && body.outDir.startsWith("-")) {
    // Same defence-in-depth as job inputs: a value that looks like a flag
    // must never reach a spawned tool as one.
    throw badRequest("Output directory must be a path, not an option.");
  }

  return {
    input: body.input,
    tracks,
    outDir: typeof body.outDir === "string" ? body.outDir : undefined,
  };
}

function isLanguageCode(value) {
  return typeof value === "string" && /^[a-z]{2,3}$/u.test(value);
}

export function writeSse(response, event, data) {
  // A client that closed mid-job leaves a destroyed socket. Writing to it
  // raises an error with no listener, which would take down the whole bridge
  // and every other job running on it.
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function safeUploadName(name) {
  const clean = basename(String(name || "subtitle-file"))
    .replace(/[^\w .()[\]-]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  // basename("..") is ".." and survives the character class above, which then
  // makes writeFile target a directory and throw EISDIR.
  if (!clean || /^\.+$/u.test(clean)) return "subtitle-file";
  return clean;
}

async function receiveUploadedFiles(request) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) {
    throw badRequest("Uploads must use multipart/form-data.");
  }

  // Reject an oversized body from the declared length before buffering it.
  // formData() below has no size limit, so without this a 4 GB drag-and-drop
  // is held entirely in memory and only rejected afterwards — if it does not
  // OOM first. The per-file/total checks after parsing stay as the backstop for
  // a chunked body that declares no length.
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxUploadTotalBytes) {
    throw badRequest("Upload is too large for the local bridge.");
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

  // Subtitle sidecars are small. Videos are never uploaded (they are processed
  // in place), so a large body here is a mistake or an attempt to fill the
  // disk rather than a real workload.
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (files.some((file) => file.size > maxUploadFileBytes)) {
    throw badRequest("Uploaded file is too large for the local bridge.");
  }
  if (total > maxUploadTotalBytes) {
    throw badRequest("Upload is too large for the local bridge.");
  }

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

export function uniqueUploadName(name, usedNames) {
  const count = usedNames.get(name) ?? 0;
  usedNames.set(name, count + 1);
  if (!count) return name;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem}-${count + 1}${extension}`;
}

async function readRequestBody(request) {
  // Decode across chunk boundaries: a multi-byte character split between two
  // chunks would otherwise be corrupted, which is reachable with any non-ASCII
  // file path.
  const decoder = new StringDecoder("utf8");
  let body = "";
  for await (const chunk of request) {
    body += decoder.write(chunk);
    if (Buffer.byteLength(body) > 1024 * 1024) {
      throw badRequest("Request body is too large.");
    }
  }
  body += decoder.end();
  return body || "{}";
}

async function readJsonBody(request) {
  // A JSON content-type is not a simple CORS request type, so requiring it
  // forces a preflight for anything cross-origin instead of letting a
  // text/plain POST through unannounced.
  const contentType = String(request.headers?.["content-type"] ?? "");
  if (contentType && !/^application\/json\b/iu.test(contentType)) {
    throw badRequest("JSON endpoints require content-type: application/json.");
  }
  try {
    return JSON.parse(await readRequestBody(request));
  } catch (error) {
    if (error.statusCode) throw error;
    throw badRequest("Request body must be valid JSON.");
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function tooManyRequests(message) {
  const error = new Error(message);
  error.statusCode = 429;
  return error;
}
