# Product Roadmap

Goal: ship Subtitle Workbench as a desktop app for macOS, Windows, and Linux,
with equivalent CLI workflows for automation and batch use.

Updated 2026-08-07. The engine, CLI, bridge, web UI, and a working Tauri
desktop shell exist; what remains is distribution.

## Shape (settled)

A shared conversion engine behind two front doors:

- **Desktop app** — `src-tauri/`, a thin Tauri 2 shell that starts the local
  bridge on a private port and opens a native window on it. The bridge owns
  the job queue, token auth, and native file picking on all three platforms.
- **CLI** — `subtitle-workbench`, the same engine for batch and automation.

**Tools are user-installed, not bundled** (decided 2026-08-07): ffmpeg,
tesseract, ImageMagick, MKVToolNix come from the user's package manager, with
`doctor` and the UI's startup check as the guide. The price of that choice is
that setup instructions must work for non-experts. Bundled sidecars remain a
possible later upgrade, not a v1 requirement.

## Done

1. **Shared engine** — `lib/subtitle-core.mjs` (text formats),
   `lib/pgs-decoder.mjs` (shared CLI/browser PGS decode), OCR engine adapters
   with per-track probing and per-image preprocessing repairs. Gate: 0.66%
   CER over 28,550 SUP cues; VobSub 2.47% portable / 1.83% Vision.
2. **CLI** — stable subcommands, JSON events, content-keyed conversion cache,
   fixture-based tests, three-OS CI.
3. **Desktop shell** — window sized to the layout, bridge lifetime tied to
   the window (no orphan survives even SIGKILL), native pickers and
   reveal-in-file-manager through the bridge.

Removed along the way: ITT to SRT (2026-08-07, no longer needed) and the
planned ONNX recognizer (preprocessing closed the portable OCR gap to 0.64
CER points — see `portable-ocr-plan.md` for the bar to revive it).

## Remaining

4. **Distribution**
   - macOS: signed/notarized `.app` + `.dmg`.
   - Windows: NSIS installer first; MSI later if needed.
   - Linux: AppImage first; `.deb`/`.rpm` later if useful.
   - Build each platform on its native CI runner.
   - PATH resolution for GUI-launched apps (a double-clicked app does not
     inherit the shell PATH; node and Homebrew paths must be found).
   - First-run experience: walk a non-expert through installing Node and
     the tools, driven by `doctor`, without assuming a terminal. Node is
     deliberately not bundled (security updates stay the Node project's
     release channel, not ours), so the walkthrough carries it.
   - Auto-update and uninstall story.

5. **Smaller known items** — see RUNNING_NOTES "Outstanding": preferences in
   OS app-data, `--skip-existing` TOCTOU and job events, DOM tests replacing
   the source-grep tests, per-job log path in the UI.

6. **Ship** — `npm publish` + `git tag` when the user calls it complete
   (decided: ship once complete, not incrementally).

## References

- Tauri: https://tauri.app/
- Tauri Windows installer: https://tauri.app/distribute/windows-installer/
