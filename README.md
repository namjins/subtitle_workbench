# Subtitle Workbench

A local-first subtitle workbench for the conversion flows I use most often.

Long-term target: a self-contained desktop app for macOS, Windows, and Linux,
plus CLI commands for automation and batch subtitle work. See
`docs/product-roadmap.md`.

## Current Features

- `SUP to SRT` — OCR for Blu-ray PGS subtitle tracks.
- `SUB/IDX to SRT` — OCR for DVD VobSub subtitle pairs.
- `ITT to SRT` — Final Cut Pro / TTML timed text, with frame-rate handling.
- `Extract from Video` — pull embedded subtitle tracks out of MKV files.

Run the app with:

```bash
npm run app
```

That builds the UI and serves it from the local bridge on
`http://127.0.0.1:8765`. The bridge is what does the work; the page is a
client for it, and both live on the same origin so no cross-origin access is
involved.

## Requirements

- Node.js `>=22.13.0`
- For MKV subtitle extraction:
  - `mkvinfo`
  - `mkvextract`
- For OCR:
  - `ffmpeg`
  - `ffprobe`
  - `tesseract`
  - `magick`

Check the current machine with:

```bash
npm run cli -- doctor
npm run doctor
```

On macOS, MKVToolNix and ffmpeg are typically available through Homebrew:

```bash
brew install node ffmpeg tesseract imagemagick mkvtoolnix
```

If an existing Homebrew binary is found but marked `BROKEN`, reinstall or
upgrade that package so it is linked against the current Homebrew libraries:

```bash
brew reinstall mkvtoolnix
```

On Apple Silicon Macs, put native Homebrew first so the CLI does not run Intel
Homebrew binaries under Rosetta:

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

Or prefix a single command with:

```bash
tools/run_native_macos.sh npm run cli -- --help
```

From this repo you can also use:

```bash
npm run cli:native -- --help
```

## Development

```bash
npm install
npm run dev
```

Open the local URL printed by the dev server.

## CLI

Run the unified CLI from the repo:

```bash
npm run cli -- --help
npm run cli -- doctor
npm run cli -- doctor --json
npm run cli -- extract-english "/path/to/videos"
npm run cli -- peek-sup movie.sup --out-dir ./preview --count 3
npm run cli -- sup-to-srt movie.sup --lang eng --out movie.srt
npm run cli -- sup-to-srt *.sup --lang eng --out-dir ./srt
npm run cli -- subidx-to-srt movie.idx --lang eng --out movie.srt
npm run cli -- subidx-to-srt *.idx --lang eng --out-dir ./srt
npm run cli -- benchmark-ocr --reference reference.srt --candidate generated.srt
npm run cli -- benchmark-ocr --examples-dir ./examples --candidate-dir ./ocr-output
npm run cli -- inspect-missing-ocr --details ./ocr-output/details.json --examples-dir ./examples --out-dir ./ocr-misses
```

The package also exposes a `subtitle-workbench` binary for future packaging.

CPU parallelism defaults to `--jobs auto`: the CLI detects available CPU
parallelism, keeps one core free, and caps automatic jobs at 8. Pass `--jobs N`
to override when you want a different concurrency level.

`peek-sup` extracts a few readable subtitle images from a PGS `.sup` file so the
operator can confirm the OCR language before running the full conversion.

## Extract Subtitle Tracks From MKV Files

From a folder containing `.mkv` files:

```bash
npm run cli -- extract-english /path/to/videos
npm run cli -- extract-english /path/to/videos --languages eng,spa
npm run cli -- extract-english /path/to/videos --all-languages --jobs auto
```

The command:

- scans only the top level of the given directory;
- writes `movie.sub` + `movie.idx` for DVD VobSub tracks and `movie.sup` for
  Blu-ray PGS tracks, with `movie1.*` and so on for additional tracks;
- suffixes non-English and forced tracks, e.g. `movie-spa.sup`,
  `movie1-forced.idx`;
- skips outputs that already exist;
- exits non-zero if any file failed.

DVB subtitles (`S_DVBSUB`) are not supported and are skipped rather than
written to a file the OCR path cannot read.

## Convert Image Subtitles With OCR

The OCR helper extracts subtitle bitmaps with `ffmpeg`, reads packet timing with
`ffprobe`, runs each image through `tesseract`, and writes an `.srt` file.

```bash
/path/to/repos/subtitle_workbench/tools/ocr_image_subs.mjs sup-to-srt /path/to/movie.sup --lang eng
/path/to/repos/subtitle_workbench/tools/ocr_image_subs.mjs subidx-to-srt /path/to/movie.idx --lang eng
```

For VobSub, pass the `.idx` file. The helper checks for the matching `.sub`
file next to it.

Useful options:

- `--out /path/to/output.srt`
- `--keep-temp`
- `--jobs auto` (default safe CPU count) or `--jobs N`
- `--ocr-engine auto` (default; uses Tesseract for SUP, and uses macOS Vision
  for SUB/IDX when available on macOS; otherwise uses the portable Tesseract
  accurate path)
- `--ocr-engine tesseract-hybrid` (faster, lower-accuracy baseline)
- `--ocr-engine tesseract-accurate` (portable Tesseract high-accuracy path)
- `--ocr-engine macos-vision` (optional macOS-only benchmark adapter; hidden
  on Windows/Linux and never used unless selected)
- `--ocr-engine external-command --ocr-command /path/to/ocr-sidecar`
  (experimental cross-platform adapter for benchmarking RapidOCR/PaddleOCR/ONNX
  sidecars)

The external OCR command is called as:

```bash
/path/to/ocr-sidecar /path/to/image.png eng
```

It may print plain recognized text or JSON:

```json
{"text":"Hello","confidence":0.98,"model":"rapidocr-onnx"}
```

For a minimal contract smoke test, see:

```bash
node tools/subtitle-workbench.mjs subidx-to-srt "sub:idx examples/Spy Game (2001)1.idx" \
  --ocr-engine external-command \
  --ocr-command tools/ocr_external_echo_example.mjs \
  --out .tmp/external-command-smoke/spy-game-forced-echo.srt
```

VobSub `.sub/.idx` files are paired by the `.idx` path. The helper renders
subtitle event frames, filters clear frames, normalizes dark and light subtitle
palettes for OCR, and preserves forced-style sibling tracks such as
`Movie1.idx`.

## Benchmark OCR Output

Use `benchmark-ocr` to compare generated SRT files against reference SRT files
by timestamp, cue count, exact text matches, and character error rate.

```bash
npm run cli -- benchmark-ocr --reference reference.srt --candidate generated.srt
npm run cli -- benchmark-ocr --examples-dir "/path/to/samples/Subtitle Examples" --candidate-dir .tmp/ocr-round --csv .tmp/ocr-round/benchmark.csv --details .tmp/ocr-round/details.json
npm run cli -- benchmark-ocr --examples-dir "/path/to/samples/Subtitle Examples" --candidate-dir .tmp/ocr-round --max-missing 0 --max-extra 0 --max-end-mismatches 0 --max-cer 0.01
npm run cli -- benchmark-ocr --examples-dir "sub:idx examples" --candidate-dir .tmp/subidx-round --max-missing 0 --max-extra 0 --max-end-mismatches 0 --max-cer 0.01
npm run cli -- benchmark-ocr --examples-dir "sub:idx examples" --candidate-dir .tmp/subidx-round --timing-first
npm run cli -- benchmark-ocr --examples-dir "sub:idx examples" --candidate-dir .tmp/subidx-round --timing-first --fixture-metadata docs/fixture-metadata.json
npm run cli -- inspect-missing-ocr --details .tmp/ocr-round/details.json --examples-dir "/path/to/samples/Subtitle Examples" --out-dir .tmp/ocr-round/missing-images
npm run cli -- inspect-missing-ocr --details .tmp/ocr-round/details.json --examples-dir "/path/to/samples/Subtitle Examples" --out-dir .tmp/ocr-round/text-mismatch-images --kind text --limit 100
```

The detailed report includes every missing cue, extra cue, and end-time
mismatch, plus the highest-impact text mismatches. `inspect-missing-ocr` uses
that report to extract the source SUP images for missed cues or text mismatches
so we can tune OCR preprocessing against the actual failures.
For SUB/IDX references where text is known to be imperfect, `--timing-first`
prints a structure-led table that prioritizes missing cues, extra cues, and
end-time mismatches before text accuracy. If a reference SRT is empty but the
candidate has cues, those cues are reported as `unverified` instead of normal
extras; this keeps forced/overlay subtitle streams visible without treating an
empty baseline as proof of failure.
The `shifted` column is diagnostic: it counts missing reference cues whose text
appears nearby in the candidate at a different timestamp, which usually points
to timing extraction rather than OCR text loss.

Use the threshold flags as the reliability gate for OCR changes. The current
fixture target is:

- `0` missing cues
- `0` extra cues
- `0` end-time mismatches
- character error rate at or below `1%`

`npm run ocr:gate` runs the full SUP comparison. It needs the local fixture
media in `Subtitle Examples/` and previously generated candidates in
`.tmp/ocr-examples-accurate/`; neither is tracked, because they are large and
disc-derived. The gate fails rather than passing silently when those are
missing, empty, or fewer than `--min-fixtures`.

The committed fixtures in `tests/fixtures/` are what CI runs against.

## Local Bridge

`npm run app` builds the UI and serves it from the bridge. To run the bridge
alone:

```bash
npm run bridge
npm run cli -- ui --port 8765        # serve the built UI and open a browser
npm run cli -- ui --dev              # also accept the Vite dev server origin
```

It listens on `127.0.0.1:8765` and exposes `GET /health`, `POST /jobs` (a
Server-Sent Events stream), `POST /uploads`, `POST /files/pick`,
`POST /videos/inspect` and `POST /videos/extract`.

Every endpoint requires a loopback `Host`, a same-origin `Origin` when one is
sent, and a per-session token that the bridge injects into the page it serves.
A page it did not serve cannot read that token, which is what stops an
unrelated website from driving your local install. `--dev` relaxes this for the
Vite dev origin and is off by default.

`--ocr-command` is deliberately not accepted over HTTP, since it names a binary
to execute. Use the CLI flag or `SUBTITLE_WORKBENCH_OCR_COMMAND`.
