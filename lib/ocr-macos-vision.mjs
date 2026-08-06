import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cleanOcrText } from "./ocr-tesseract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "tools", "macos_vision_ocr.swift");
const binaryPath = resolve(root, ".tmp", "macos_vision_ocr");

function swiftEnvironment() {
  return {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: resolve(root, ".tmp", "swift-module-cache"),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`${command} failed: ${error.message}`));
    });
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${
            signal ? `terminated by ${signal}` : `exited with ${status}`
          }\n${stderr}`.trim(),
        ),
      );
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

async function shouldBuildBinary() {
  if (!existsSync(binaryPath)) return true;
  const [source, binary] = await Promise.all([stat(sourcePath), stat(binaryPath)]);
  return source.mtimeMs > binary.mtimeMs;
}

async function ensureVisionBinary() {
  if (process.platform !== "darwin") {
    throw new Error("macos-vision OCR is only available on macOS.");
  }
  if (!(await shouldBuildBinary())) return;
  await mkdir(dirname(binaryPath), { recursive: true });
  await mkdir(resolve(root, ".tmp", "swift-module-cache"), { recursive: true });
  await run(
    "swiftc",
    [sourcePath, "-framework", "Vision", "-framework", "ImageIO", "-o", binaryPath],
    { env: swiftEnvironment() },
  );
}

export function createMacosVisionEngine() {
  function formatResult(parsed, durationMs) {
    const text = cleanOcrText(parsed.text ?? "");
    return {
      text,
      confidence: Number(parsed.confidence) * 100 || 0,
      engine: "macos-vision",
      model: "VNRecognizeTextRequest",
      variant: "vision-accurate",
      durationMs,
      warnings: text ? [] : ["blank-result"],
      candidates: [
        {
          text,
          confidence: Number(parsed.confidence) * 100 || 0,
          variant: "vision-accurate",
          lines: parsed.lines ?? [],
        },
      ],
    };
  }

  return {
    name: "macos-vision",
    requiredBinaries: ["swiftc"],
    async recognize(imagePath, { language = "eng" } = {}) {
      const started = performance.now();
      await ensureVisionBinary();
      const output = await run(binaryPath, [imagePath, language]);
      const parsed = JSON.parse(output);
      return formatResult(parsed, Math.round(performance.now() - started));
    },
    async recognizeBatch(imagePaths, { language = "eng" } = {}) {
      const started = performance.now();
      await ensureVisionBinary();
      const output = await run(binaryPath, ["--batch", language], {
        input: `${imagePaths.join("\n")}\n`,
      });
      const rows = output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const rowByPath = new Map(rows.map((row) => [row.path, row]));
      const totalDurationMs = Math.round(performance.now() - started);
      return imagePaths.map((imagePath) => {
        const row = rowByPath.get(imagePath);
        if (!row) {
          throw new Error(`macos-vision did not return a result for ${imagePath}`);
        }
        if (row.error) {
          throw new Error(`macos-vision failed for ${imagePath}: ${row.error}`);
        }
        return formatResult(row.result ?? {}, totalDurationMs);
      });
    },
  };
}
