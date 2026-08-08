import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeJobs } from "./cpu-jobs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(root, "tools", "subtitle-workbench.mjs");

export function subtitleWorkbenchArgs({
  command,
  inputs = [],
  language = "eng",
  outDir,
  jobs = "auto",
  ocrEngine = "auto",
  ocrCommand,
  noCache = false,
} = {}) {
  if (!command) throw new Error("No subtitle-workbench command provided.");
  // Flags first, then `--`, then the inputs. Inputs can be attacker-influenced
  // (the bridge accepts a list of paths), and the CLI resolves options by
  // scanning argv, so an input such as "--ocr-command" would otherwise be
  // honoured as a flag. Note the order matters: putting `--` before the flags
  // would hide `--json-events` and silently kill the progress stream.
  const args = [cliPath, command];
  args.push(
    "--lang",
    language,
    "--jobs",
    String(normalizeJobs(jobs)),
    "--ocr-engine",
    ocrEngine,
  );
  args.push("--json-events");
  if (outDir) args.push("--out-dir", outDir);
  if (ocrCommand) args.push("--ocr-command", ocrCommand);
  if (noCache) args.push("--no-cache");
  args.push("--", ...inputs);
  return args;
}

const maxCapturedOutput = 1024 * 1024;

export function runLocalCommand(command, args, options = {}) {
  const events = [];
  let stdout = "";
  let stderr = "";
  let pendingLine = "";

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so cancelling kills the OCR workers this spawns
      // (tesseract/magick/ffmpeg), not just the CLI wrapper.
      detached: process.platform !== "win32",
    });

    let cancelled = false;
    const killTree = () => {
      if (child.exitCode !== null || child.signalCode) return;
      cancelled = true;
      try {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Already gone.
      }
    };

    const timeout = options.timeoutMs
      ? setTimeout(killTree, options.timeoutMs)
      : null;
    options.signal?.addEventListener("abort", killTree, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      // Bounded: events are streamed out as they arrive, so the full transcript
      // is only kept for diagnostics and must not grow without limit on a
      // large batch.
      if (stdout.length < maxCapturedOutput) stdout += chunk;
      pendingLine += chunk;
      const lines = pendingLine.split(/\r?\n/u);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseJobEventLine(line);
        if (!event) continue;
        events.push(event);
        options.onEvent?.(event);
      }
    });

    child.stderr.on("data", (chunk) => {
      // Keep the *tail*, not the head: the failure text arrives last, and a
      // long batch fills 1 MB with per-image OCR progress before anything
      // fails. Stopping appends at the cap (the old behaviour) meant the
      // captured stderr contained no failure text at all.
      stderr += chunk;
      if (stderr.length > maxCapturedOutput) {
        stderr = stderr.slice(stderr.length - maxCapturedOutput);
      }
    });

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      if (timeout) clearTimeout(timeout);
      if (cancelled) {
        const error = new Error("Job cancelled.");
        error.cancelled = true;
        error.result = { status, signal, events, stdout, stderr };
        reject(error);
        return;
      }
      if (pendingLine) {
        const event = parseJobEventLine(pendingLine);
        if (event) {
          events.push(event);
          options.onEvent?.(event);
        }
      }
      const result = { status, signal, events, stdout, stderr };
      if (status === 0) {
        resolvePromise(result);
      } else {
        const error = new Error(`${command} exited with ${status}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

export function runSubtitleWorkbenchJob(job, options = {}) {
  return runLocalCommand(process.execPath, subtitleWorkbenchArgs(job), options);
}

function parseJobEventLine(line) {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    if (event && typeof event.type === "string") return event;
  } catch {
    return null;
  }
  return null;
}
