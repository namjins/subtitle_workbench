import { spawnSync } from "node:child_process";

export const dependencyChecks = [
  {
    name: "node",
    command: "node",
    args: ["--version"],
    purpose: "Runs the app and CLI",
    required: true,
  },
  {
    name: "ffmpeg",
    command: "ffmpeg",
    args: ["-version"],
    purpose: "Extracts subtitle images and media streams",
    required: true,
  },
  {
    name: "ffprobe",
    command: "ffprobe",
    args: ["-version"],
    purpose: "Reads media packet timing",
    required: true,
  },
  {
    name: "tesseract",
    command: "tesseract",
    args: ["--version"],
    purpose: "OCR engine for image subtitles",
    required: true,
  },
  {
    name: "magick",
    command: "magick",
    args: ["-version"],
    purpose: "Image preprocessing for OCR",
    required: true,
  },
  {
    name: "mkvinfo",
    command: "mkvinfo",
    args: ["--version"],
    purpose: "Inspects MKV subtitle tracks",
    required: true,
  },
  {
    name: "mkvextract",
    command: "mkvextract",
    args: ["--version"],
    purpose: "Extracts embedded MKV subtitle tracks",
    required: true,
  },
];

export function installInstructionsForPlatform(platform = process.platform) {
  if (platform === "darwin") {
    return [
      "macOS Homebrew:",
      "  brew install node ffmpeg tesseract imagemagick mkvtoolnix",
      "Apple Silicon note:",
      '  export PATH="/opt/homebrew/bin:$PATH"',
    ];
  }

  if (platform === "win32") {
    return [
      "Windows winget:",
      "  winget install OpenJS.NodeJS Gyan.FFmpeg UB-Mannheim.TesseractOCR ImageMagick.ImageMagick MoritzBunkus.MKVToolNix",
      "Restart your terminal after installing so PATH changes are visible.",
    ];
  }

  return [
    "Debian/Ubuntu:",
    "  sudo apt install nodejs npm ffmpeg tesseract-ocr imagemagick mkvtoolnix",
    "Fedora:",
    "  sudo dnf install nodejs ffmpeg tesseract ImageMagick mkvtoolnix",
    "Arch:",
    "  sudo pacman -S nodejs npm ffmpeg tesseract imagemagick mkvtoolnix-cli",
  ];
}

function commandPath(command) {
  const lookup =
    process.platform === "win32"
      ? spawnSync("where", [command], { encoding: "utf8" })
      : spawnSync("which", [command], { encoding: "utf8" });

  if (lookup.status !== 0) return null;
  return lookup.stdout.trim().split(/\r?\n/)[0] || null;
}

function firstUsefulLine(output) {
  return output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 180);
}

function runBinaryCheck(check) {
  const path = commandPath(check.command);
  if (!path) {
    return {
      ...check,
      ok: false,
      path: null,
      version: null,
      error: "Not found on PATH",
    };
  }

  const result = spawnSync(check.command, check.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      ...check,
      ok: false,
      path,
      version: null,
      error: result.error.message,
    };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    ...check,
    ok: result.status === 0,
    path,
    version: firstUsefulLine(output) ?? null,
    error:
      result.status === 0
        ? null
        : result.signal
          ? `Terminated by ${result.signal}`
          : `Exited with ${result.status}`,
  };
}

function checkTesseractLanguage(language) {
  const result = spawnSync("tesseract", ["--list-langs"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return {
      name: `tesseract language: ${language}`,
      language,
      ok: false,
      required: true,
      error: result.error?.message ?? `Exited with ${result.status}`,
    };
  }

  const languages = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^list of available languages/i.test(line));

  return {
    name: `tesseract language: ${language}`,
    language,
    ok: languages.includes(language),
    required: true,
    availableLanguages: languages,
    error: languages.includes(language)
      ? null
      : `Language data "${language}" is not installed.`,
  };
}

export function summarizeDoctorReport(report) {
  const binaryFailures = report.binaries.filter((item) => item.required && !item.ok);
  const languageFailures = report.languages.filter((item) => item.required && !item.ok);
  return {
    ready: binaryFailures.length === 0 && languageFailures.length === 0,
    binaryFailures,
    languageFailures,
  };
}

export function buildDoctorReport(options = {}) {
  const language = options.language ?? "eng";
  const binaries = dependencyChecks.map(runBinaryCheck);
  const hasTesseract = binaries.find((item) => item.name === "tesseract")?.ok;
  const languages = hasTesseract ? [checkTesseractLanguage(language)] : [];
  const report = {
    platform: process.platform,
    arch: process.arch,
    binaries,
    languages,
    install: installInstructionsForPlatform(process.platform),
  };
  return {
    ...report,
    summary: summarizeDoctorReport(report),
  };
}

function statusLabel(item) {
  if (item.ok) return "OK     ";
  return item.path ? "BROKEN " : "MISSING";
}

export function formatDoctorReport(report) {
  const lines = [
    "Subtitle Workbench doctor",
    `Platform: ${report.platform} ${report.arch}`,
    `Status: ${report.summary.ready ? "ready" : "missing requirements"}`,
    "",
    "Binaries:",
  ];

  for (const item of report.binaries) {
    lines.push(
      `  ${statusLabel(item)}  ${item.name.padEnd(10)} ${item.path ?? "-"}${
        item.version ? ` (${item.version})` : ""
      }`,
    );
    if (!item.ok && item.error) {
      lines.push(`           ${item.error}`);
    }
  }

  lines.push("", "Tesseract languages:");
  if (report.languages.length) {
    for (const item of report.languages) {
      lines.push(`  ${statusLabel(item)}  ${item.language}`);
      if (!item.ok && item.error) {
        lines.push(`           ${item.error}`);
      }
    }
  } else {
    lines.push("  SKIPPED  tesseract is unavailable");
  }

  if (!report.summary.ready) {
    lines.push("", "Install help:", ...report.install);
  } else {
    lines.push("", "All required dependencies are available.");
  }

  return `${lines.join("\n")}\n`;
}
