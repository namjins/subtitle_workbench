# Subtitle Workbench

Local-first subtitle workbench: React UI + `subtitle-workbench` CLI + a localhost
bridge. Converts Blu-ray PGS (`.sup`) and DVD VobSub (`.sub`/`.idx`) to SRT via
OCR, converts Final Cut Pro `.itt`, and extracts subtitle tracks from MKV files.

Read `RUNNING_NOTES.md` first — it holds the decisions, baselines, and the list
of approaches already tried and rejected.

## Commands

```bash
npm run app         # build the UI and serve it from the bridge (this is "run the app")
npm run dev         # Vite dev server; needs `npm run cli -- ui --dev` alongside it
npm test            # unit + end-to-end, no build required
npm run lint
npm run typecheck
npm run build
npm run ocr:gate    # full SUP quality gate; needs local media, see docs/fixtures.md
npm run cli -- --help
```

`npm test` must pass with no network beyond the npm registry. If a change makes
tests need a build or a download, that is a regression.

## Layout

- `app/` — the UI. One `"use client"` component (`SubtitleWorkbench.tsx`) plus a
  bridge client and a browser PGS previewer. Plain Vite SPA, no framework server.
- `lib/` — everything reusable. `subtitle-core.mjs` owns *all* text-format
  conversion; `pgs-peek.mjs` is the PGS decoder; `local-bridge-server.mjs` is the
  HTTP surface; `srt-metrics.mjs` is the benchmark maths.
- `tools/` — CLI entry points. `subtitle-workbench.mjs` is the front door.
- `tests/` — `node --test`. Fixtures in `tests/fixtures/`.

## Conventions

- ESM everywhere, `.mjs` for Node, TypeScript for `app/`.
- Comments explain *why*, especially where the obvious implementation was wrong.
  Several fixes here look arbitrary without their reason.
- Match the surrounding style; the codebase is consistent, so follow it rather
  than importing new idioms.

## Things that bite

- **Never report success for work that did not happen.** Three paths did exactly
  that (a simulated UI progress fallback, DVB producing an empty SRT, and the
  quality gate passing against an empty directory) and all three were removed.
  A conversion that decodes nothing must exit non-zero.
- **The bridge is hostile-input territory.** It is reachable by any page the user
  visits. Anything new there needs the shared authorization guard, and no
  network input may ever select a binary to execute.
- **Argv order matters.** `subtitleWorkbenchArgs` emits flags, then `--`, then
  inputs. Putting `--` earlier hides `--json-events` and silently kills the
  progress stream. Parse argv through `lib/cli-args.mjs`, never
  `process.argv.indexOf/includes`.
- **`which` does not exist on Windows.** Use `hasCommand` from
  `lib/platform-paths.mjs`. Scratch files go in `cacheDirectory()`, never
  `process.cwd()` or the install directory.
- **Re-run `npm run ocr:gate` after touching OCR or the decoders**, and report
  the numbers whether or not they moved.

## Verification expectations

Prefer running the thing over reasoning about it. For OCR and decoder work that
means regenerating output and benchmarking it against a reference, not just
passing unit tests. Windows behaviour cannot be verified locally on a Mac — CI
is what proves it, so say so rather than implying it was tested.
