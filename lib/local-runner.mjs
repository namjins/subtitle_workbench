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
  fps,
  outDir,
  jobs = "auto",
  ocrEngine = "auto",
  ocrCommand,
} = {}) {
  if (!command) throw new Error("No subtitle-workbench command provided.");
  const args = [cliPath, command, ...inputs];
  if (command === "itt-to-srt") {
    args.push("--fps", String(fps ?? "24000/1001"));
  } else {
    args.push(
      "--lang",
      language,
      "--jobs",
      String(normalizeJobs(jobs)),
      "--ocr-engine",
      ocrEngine,
    );
  }
  args.push("--json-events");
  if (outDir) args.push("--out-dir", outDir);
  if (command !== "itt-to-srt" && ocrCommand) args.push("--ocr-command", ocrCommand);
  return args;
}

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
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
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
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", reject);
    child.on("close", (status, signal) => {
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
