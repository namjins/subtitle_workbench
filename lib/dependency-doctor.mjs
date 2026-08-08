import { spawnSync } from "node:child_process";
import { commandPath } from "./platform-paths.mjs";

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
    features: ["ocr"],
  },
  {
    name: "ffprobe",
    command: "ffprobe",
    args: ["-version"],
    purpose: "Reads media packet timing",
    required: true,
    features: ["ocr"],
  },
  {
    name: "tesseract",
    command: "tesseract",
    args: ["--version"],
    purpose: "OCR engine for image subtitles",
    required: true,
    features: ["ocr"],
    // 5.4.0 silently returns *nothing* for some low-contrast drop-shadowed
    // frames that 5.5 reads correctly, and an empty recognition drops the cue
    // rather than corrupting it — so the damage is a missing subtitle, not a
    // visibly wrong one. Measured on Windows against the SUP corpus: 5.4.0 lost
    // 6 cues that 5.5.3 recovers, matching the macOS baseline exactly. A warning
    // rather than a failure: an older Tesseract still works, it is just lossier.
    minimumVersion: "5.5.0",
  },
  {
    name: "magick",
    command: "magick",
    // Debian/Ubuntu still package ImageMagick 6, whose binary is `convert`;
    // every invocation this codebase makes works with either.
    alternates: ["convert"],
    args: ["-version"],
    purpose: "Image preprocessing for OCR",
    required: true,
    features: ["ocr"],
  },
  {
    name: "mkvmerge",
    command: "mkvmerge",
    args: ["--version"],
    purpose: "Inspects MKV subtitle tracks for the app and bridge",
    required: true,
    features: ["extract"],
  },
  {
    name: "mkvinfo",
    command: "mkvinfo",
    args: ["--version"],
    purpose: "Inspects MKV subtitle tracks",
    required: true,
    features: ["extract"],
  },
  {
    name: "mkvextract",
    command: "mkvextract",
    args: ["--version"],
    purpose: "Extracts embedded MKV subtitle tracks",
    required: true,
    features: ["extract"],
  },
  {
    name: "swiftc",
    command: "swiftc",
    args: ["--version"],
    // Optional: without it macOS silently falls back to Tesseract, which is a
    // little lossier on shadowed VobSub. Reporting it (not failing on it) tells
    // a Mac user why Apple Vision never engaged.
    purpose: "Apple Vision OCR (macOS only; install with `xcode-select --install`)",
    required: false,
    features: ["ocr"],
    platforms: ["darwin"],
  },
  {
    name: "zenity",
    command: "zenity",
    args: ["--version"],
    // Optional: the Browse button shells out to zenity on Linux. Without it the
    // bridge returns a 501 the user cannot otherwise diagnose.
    purpose: "Native file picker for the Browse button (Linux only)",
    required: false,
    features: ["ui"],
    platforms: ["linux"],
  },
];

export function installInstructionsForPlatform(platform = process.platform) {
  if (platform === "darwin") {
    return [
      "macOS Homebrew:",
      "  brew install node ffmpeg tesseract imagemagick mkvtoolnix",
      "Apple Vision OCR (optional, sharper on shadowed subtitles):",
      "  xcode-select --install",
      "Apple Silicon note:",
      '  export PATH="/opt/homebrew/bin:$PATH"',
    ];
  }

  if (platform === "win32") {
    return [
      "Windows winget:",
      // Deliberately not UB-Mannheim.TesseractOCR, the package most guides
      // name: it stops at 5.4.0, below the version floor. `tesseract-ocr`
      // is the upstream project's own package and tracks 5.5.
      "  winget install OpenJS.NodeJS Gyan.FFmpeg tesseract-ocr.tesseract ImageMagick.ImageMagick MoritzBunkus.MKVToolNix",
      "Restart your terminal after installing so PATH changes are visible.",
      "Tesseract and MKVToolNix do not add themselves to PATH; add",
      "  C:\\Program Files\\Tesseract-OCR and C:\\Program Files\\MKVToolNix",
      "to your user Path if they are still reported missing.",
    ];
  }

  return [
    // zenity backs the Browse button's native file picker; without it the
    // bridge returns a 501 the user cannot otherwise diagnose.
    "Debian/Ubuntu:",
    "  sudo apt install nodejs npm ffmpeg tesseract-ocr imagemagick mkvtoolnix zenity",
    "Fedora:",
    "  sudo dnf install nodejs ffmpeg tesseract ImageMagick mkvtoolnix zenity",
    "Arch:",
    "  sudo pacman -S nodejs npm ffmpeg tesseract imagemagick mkvtoolnix-cli zenity",
  ];
}

export function firstUsefulLine(output) {
  return output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 180);
}

/** First x.y.z in a version banner, e.g. "tesseract v5.5.3.20260724" -> [5,5,3]. */
export function parseVersionTriple(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * False when either side is unparseable: a version banner this does not
 * recognise must never produce a warning telling the user to upgrade a tool
 * that may already be new enough.
 */
export function isBelowMinimumVersion(found, minimum) {
  const a = parseVersionTriple(found);
  const b = parseVersionTriple(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

export function runBinaryCheck(check, { platform = process.platform, lookup = commandPath } = {}) {
  // Windows ships its own `convert.exe` in System32 (FAT->NTFS conversion,
  // unrelated to ImageMagick) on every machine, so the `convert` alternate
  // must never be tried there — it shadowed a missing `magick` with a
  // "BROKEN" report and a baffling "Invalid drive specification" error
  // instead of the correct "MISSING" + install instructions.
  const alternates = platform === "win32" ? [] : (check.alternates ?? []);
  const command =
    [check.command, ...alternates].find((name) => lookup(name)) ?? check.command;
  const path = lookup(command);
  if (!path) {
    return {
      ...check,
      ok: false,
      path: null,
      version: null,
      error: "Not found on PATH",
    };
  }

  const result = spawnSync(command, check.args, {
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
  const version = firstUsefulLine(output) ?? null;
  return {
    ...check,
    ok: result.status === 0,
    path,
    version,
    warning:
      check.minimumVersion && isBelowMinimumVersion(version, check.minimumVersion)
        ? `Older than ${check.minimumVersion}; some subtitle frames are recognised as empty and their cues are dropped.`
        : null,
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
  // Warnings describe a tool that works but is lossier than it should be, so
  // they are reported without making the install "not ready".
  const warnings = report.binaries.filter((item) => item.warning);
  return {
    ready: binaryFailures.length === 0 && languageFailures.length === 0,
    binaryFailures,
    languageFailures,
    warnings,
  };
}

export function buildDoctorReport(options = {}) {
  const language = options.language ?? "eng";
  const platform = options.platform ?? process.platform;
  // `--feature ocr` or `--feature extract` narrows the report. Someone
  // converting only SUP files should not be told the install is broken because
  // MKVToolNix is absent.
  const feature = options.feature ?? null;
  const checks = dependencyChecks
    // Platform-specific optional tools (swiftc on macOS, zenity on Linux) are
    // only relevant, and only checkable, on their own platform.
    .filter((check) => !check.platforms || check.platforms.includes(platform))
    .filter((check) => !feature || !check.features || check.features.includes(feature));
  const binaries = checks.map((check) => runBinaryCheck(check, { platform }));
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
  if (item.ok) return item.warning ? "OLD    " : "OK     ";
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
    if (item.warning) {
      lines.push(`           ${item.warning}`);
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
  } else if (report.summary.warnings?.length) {
    lines.push("", "All required dependencies are available, with warnings above.");
  } else {
    lines.push("", "All required dependencies are available.");
  }

  return `${lines.join("\n")}\n`;
}
