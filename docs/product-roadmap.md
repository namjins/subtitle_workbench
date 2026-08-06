# Product Roadmap

Goal: ship Subtitle Workbench as a self-contained desktop app for macOS, Windows,
and Linux, with equivalent CLI workflows for automation and batch use.

## Recommended Shape

Use a shared conversion engine with two front doors:

- Desktop app: Tauri shell around the existing React workbench.
- CLI: `subtitle-workbench` command that calls the same conversion engine.

Tauri is the preferred desktop target because it can reuse the web UI, produces
smaller native app bundles than Chromium-based desktop shells, and supports
bundled sidecar binaries for local tools such as `ffmpeg`, `ffprobe`,
`mkvextract`, and `tesseract`.

Electron remains a fallback if Tauri sidecar or packaging constraints get in
the way, especially if Node-native desktop integration becomes more important
than app size.

## Architecture

```text
React Workbench
      |
      v
Shared subtitle engine  <---->  CLI command
      |
      v
Local tool adapters
      |
      +-- ffmpeg / ffprobe
      +-- mkvinfo / mkvextract
      +-- OCR engine adapters
          +-- tesseract baseline
          +-- future ONNX recognizer experiment
```

## Milestones

1. Shared Engine
   - Keep text conversion logic in `lib/subtitle-core.mjs`.
   - Add tests with fixture subtitles for VTT, ASS, SMI, MicroDVD, MPL2, and SRT.
   - Move OCR timing cleanup into shared helpers once real samples are tested.
   - Add an OCR adapter boundary before testing alternate recognizers.

2. CLI
   - Expand `tools/subtitle-workbench.mjs` with stable subcommands.
   - Add fixture-based CLI tests.
   - Support JSON output for automation.
   - Add recursive batch options and overwrite/skip controls.

3. Desktop App
   - Add a Tauri shell that loads the current React UI.
   - Replace copied shell commands with native file pickers and progress logs.
   - Run conversion work through local command handlers.
   - Store preferences in the OS app-data directory.

4. Bundled Dependencies
   - Bundle platform-specific sidecars:
     - `ffmpeg`
     - `ffprobe`
     - `mkvinfo`
     - `mkvextract`
     - `tesseract`
     - OCR language data
     - optional OCR model/runtime files after benchmarking
   - Detect bundled binaries before falling back to system `PATH`.
   - Keep licenses for every bundled binary in the app.

5. Distribution
   - macOS: `.dmg` plus signed/notarized `.app`.
   - Windows: NSIS installer first; MSI later if needed.
   - Linux: AppImage first; `.deb`/`.rpm` later if useful.
   - Build each platform on its native CI runner unless cross-builds are proven
     reliable for this exact app.

## References

- Tauri overview: https://tauri.app/start/
- Tauri sidecars: https://tauri.vip/develop/sidecar/
- Tauri Windows installer: https://tauri.app/distribute/windows-installer/
- Electron packaging: https://www.electronjs.org/docs/latest/tutorial/application-distribution
- Node single executable apps: https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html
