# Changelog

## 0.2.0 — polish and hardening pass (unreleased)

The output of a full adversarial review of the codebase, UI, and docs.
Everything below changed behaviour; doc-only corrections are not listed.

### Fixed — data integrity

- **Extracting a subset of MKV subtitle tracks no longer overwrites a sibling
  track's file.** Output names were numbered by position in the extracted
  subset, so re-running with one track pending renamed it onto another track's
  file. Names now come from a stable per-suffix counter assigned over the full
  track list, the bridge validates it, and a plan that resolves two tracks to
  one path is refused outright. One consequence: extractions of two or more
  tracks with *different* suffixes (e.g. a forced English track beside the
  feature track) lose a stray numeral — `movie1-forced.sup` becomes
  `movie-forced.sup` — so the first re-run after upgrading re-extracts those.
- Extraction reports only files that actually exist on disk afterwards,
  instead of predicted paths.

### Fixed — honest output

- A VobSub conversion whose frames all render blank now fails loudly instead
  of writing an empty SRT and exiting 0; the frame count in its message is
  measured, not asserted.
- A whole-engine OCR failure (every image erroring) exits non-zero instead of
  reporting an empty conversion as success.
- The UI records an output file only when its conversion finishes — never on
  start — and a failed batch now keeps and reports the files that *did*
  convert ("N of M file(s) converted") instead of claiming nothing was
  produced while the SRTs sat on disk.
- Extraction progress is honestly indeterminate (the endpoint has no progress
  signal; the old percentage was an animation), and so is single-file OCR.

### Fixed — errors you can act on

- Bridge errors show their real reason (the server's error body, or the last
  meaningful line of the failed tool's stderr) instead of
  "node exited with 1" or a bare HTTP status.
- The captured stderr keeps its tail, not its head, so long batches still
  carry the failure text.
- Apple Vision's unsupported-language warning is forwarded instead of
  silently dropped.

### Fixed — security hardening

- The bridge's loopback Host check now runs before the static page is served,
  so a DNS-rebinding page can no longer read the session token out of the
  HTML. Non-loopback hostnames now receive 403 for the page as well as the
  API.
- `/videos/inspect` resolves its input path before invoking `mkvmerge`,
  closing an option-file (`@file`) injection.
- `outDir` values that look like options are rejected on both job and extract
  endpoints; upload bodies over the size cap are refused from their declared
  length before anything is buffered.

### Added

- **Stop button.** Stopping a run aborts the request, which makes the bridge
  kill the whole OCR process group — previously "Clear queue" detached the UI
  and left the workers running. Orphaned scratch directories from killed runs
  are reclaimed at bridge startup (never `--keep-temp` ones, never a live
  run's).
- `--version`; `--help` works on subcommands; invalid `--port` values are
  rejected instead of binding a random port.
- `doctor` reports optional tools: `swiftc` on macOS (Apple Vision) and
  `zenity` on Linux (the Browse button), with install lines.
- The dependency banner shows non-blocking warnings (e.g. Tesseract below the
  version floor), a Re-check button, and Copy diagnostics.
- The UI shows the version it is actually running (injected by the bridge —
  the desktop shell loads whatever UI the installed npm package serves).
- The desktop shell finds a `.cmd`-installed CLI on Windows and prepends the
  standard install roots (Homebrew, nvm, volta) to PATH for GUI launches; CI
  now compile-checks it on all three platforms.
- `npm run cli -- ui --dev` works from a fresh clone without a build.

### Changed

- **The conversion cache invalidates itself** when the output format is
  revised or a better engine becomes available (installing the Xcode Command
  Line Tools now reconverts with Apple Vision; uninstalling never invalidates,
  by design). Expect one reconversion per source after this upgrade.
- SRT timestamps are formatted by the shared `srtTime` (whole-value rounding).
  On current sources this is byte-identical output; it removes a latent
  four-digit-millisecond bug at second boundaries.
- PGS decoding holds compressed frames instead of raw RGB during conversion
  (~an order of magnitude less peak memory on a full feature).
- The published Node code is now type-checked (`checkJs`) alongside the app.
