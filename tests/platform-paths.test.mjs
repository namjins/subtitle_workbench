import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { commandPath, hasCommand, resolveCacheRoot } from "../lib/platform-paths.mjs";

test("cache root follows each OS convention", () => {
  // Expected values built with join() so these stay green on Windows CI.
  assert.equal(
    resolveCacheRoot({ platform: "darwin", env: {}, home: "/Users/a" }),
    join("/Users/a", "Library", "Caches", "subtitle-workbench"),
  );
  assert.equal(
    resolveCacheRoot({
      platform: "win32",
      env: { LOCALAPPDATA: join("C:", "Users", "a", "AppData", "Local") },
      home: join("C:", "Users", "a"),
    }),
    join("C:", "Users", "a", "AppData", "Local", "subtitle-workbench", "Cache"),
  );
  // win32 without LOCALAPPDATA falls back to the conventional location.
  assert.equal(
    resolveCacheRoot({ platform: "win32", env: {}, home: join("C:", "Users", "a") }),
    join("C:", "Users", "a", "AppData", "Local", "subtitle-workbench", "Cache"),
  );
  assert.equal(
    resolveCacheRoot({ platform: "linux", env: {}, home: "/home/a" }),
    join("/home/a", ".cache", "subtitle-workbench"),
  );
  assert.equal(
    resolveCacheRoot({ platform: "linux", env: { XDG_CACHE_HOME: "/xdg" }, home: "/home/a" }),
    join("/xdg", "subtitle-workbench"),
  );
  // The env override wins on every platform.
  assert.equal(
    resolveCacheRoot({ platform: "darwin", env: { SUBTITLE_WORKBENCH_CACHE_DIR: "/x" }, home: "/Users/a" }),
    "/x",
  );
});

test("hasCommand asks `where` on Windows and `which` elsewhere", () => {
  // `which` does not exist on Windows — the exact drift CLAUDE.md warns about,
  // previously unverifiable off Windows because the branch had no seam.
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: `/usr/bin/${args[0]}\n` };
  };

  assert.equal(hasCommand("tesseract", { platform: "win32", spawn }), true);
  assert.deepEqual(calls[0], ["where", "tesseract"]);

  assert.equal(hasCommand("tesseract", { platform: "darwin", spawn }), true);
  assert.deepEqual(calls[1], ["which", "tesseract"]);

  assert.equal(commandPath("ffmpeg", { platform: "linux", spawn }), "/usr/bin/ffmpeg");
  assert.deepEqual(calls[2], ["which", "ffmpeg"]);

  const missing = () => ({ status: 1, stdout: "" });
  assert.equal(hasCommand("nope", { platform: "win32", spawn: missing }), false);
  assert.equal(commandPath("nope", { platform: "win32", spawn: missing }), null);
});
