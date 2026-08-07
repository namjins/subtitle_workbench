import { spawn } from "node:child_process";
import { cleanOcrText } from "./ocr-tesseract.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
        resolve(stdout);
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
  });
}

function parseCommandOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    return { text: "", confidence: 0, model: "external-command" };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      text: parsed.text ?? "",
      confidence: Number(parsed.confidence) || 0,
      model: parsed.model ?? "external-command",
      raw: parsed,
    };
  } catch {
    return {
      text: trimmed,
      confidence: 0,
      model: "external-command",
    };
  }
}

export function createExternalCommandEngine(command) {
  if (!command) {
    throw new Error(
      "external-command OCR requires --ocr-command or SUBTITLE_WORKBENCH_OCR_COMMAND.",
    );
  }

  return {
    name: "external-command",
    requiredBinaries: [],
    async recognize(imagePath, { language = "eng" } = {}) {
      const started = performance.now();
      const parsed = parseCommandOutput(await run(command, [imagePath, language]));
      const text = cleanOcrText(parsed.text);
      return {
        text,
        confidence: parsed.confidence,
        engine: "external-command",
        model: parsed.model,
        variant: command,
        durationMs: Math.round(performance.now() - started),
        warnings: text ? [] : ["blank-result"],
        candidates: [
          {
            text,
            confidence: parsed.confidence,
            variant: command,
            raw: parsed.raw,
          },
        ],
      };
    },
  };
}
