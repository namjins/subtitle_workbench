import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `which` does not exist on Windows. Several call sites already branched on
 * platform for this; one did not, and it was the OCR pipeline's preflight, so
 * `doctor` reported every dependency present while every conversion failed
 * with "Missing required binary: ffmpeg".
 */
// The second parameter is a test seam: the `where` vs `which` branch is
// unverifiable off Windows without it. Zero-argument calls behave exactly as
// before.
export function hasCommand(command, { platform = process.platform, spawn = spawnSync } = {}) {
  const lookup =
    platform === "win32"
      ? spawn("where", [command], { encoding: "utf8" })
      : spawn("which", [command], { encoding: "utf8" });
  return lookup.status === 0;
}

export function commandPath(command, { platform = process.platform, spawn = spawnSync } = {}) {
  const lookup =
    platform === "win32"
      ? spawn("where", [command], { encoding: "utf8" })
      : spawn("which", [command], { encoding: "utf8" });
  if (lookup.status !== 0) return null;
  return lookup.stdout.trim().split(/\r?\n/u)[0] || null;
}

let cachedImageMagick;

/**
 * ImageMagick 7 installs a `magick` binary; the ImageMagick 6 that
 * Debian/Ubuntu still package installs `convert` instead. Every invocation
 * this codebase makes is compatible with both, so resolve whichever exists
 * once and use it everywhere. Returns null when neither exists, so preflight
 * can report ImageMagick as missing.
 *
 * Never `convert` on Windows: System32 ships its own convert.exe (FAT to
 * NTFS conversion, unrelated to ImageMagick) on every machine, so the
 * fallback there would pass preflight and then fail mid-conversion with
 * "Invalid drive specification". The doctor's alternate check carries the
 * same guard; this is the pipeline's copy of it.
 */
export function resolveImageMagickCommand({
  platform = process.platform,
  lookup = hasCommand,
} = {}) {
  if (lookup("magick")) return "magick";
  if (platform !== "win32" && lookup("convert")) return "convert";
  return null;
}

export function imageMagickCommand() {
  if (cachedImageMagick === undefined) {
    cachedImageMagick = resolveImageMagickCommand();
  }
  return cachedImageMagick;
}

/**
 * Scratch and build artefacts belong in the OS cache directory, not in the
 * install directory or the current working directory. Writing under cwd broke
 * runs started from a read-only or network volume and scattered hundreds of
 * megabytes of PNGs next to the user's media; writing under the install
 * directory broke global and packaged installs.
 */
export function cacheDirectory(...segments) {
  return join(resolveCacheRoot(), ...segments);
}

// Exported with an injectable environment so all three platform branches are
// testable from any OS. cacheDirectory itself stays variadic and untouched —
// its call sites pass path segments, not options.
export function resolveCacheRoot({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  const override = env.SUBTITLE_WORKBENCH_CACHE_DIR;
  if (override) return override;

  if (!home) return join(tmpdir(), "subtitle-workbench");

  if (platform === "darwin") {
    return join(home, "Library", "Caches", "subtitle-workbench");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "subtitle-workbench", "Cache");
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "subtitle-workbench");
}
