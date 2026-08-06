# Subtitle Workbench

A local-first subtitle workbench for the conversion flows I use most often.

Long-term target: a self-contained desktop app for macOS, Windows, and Linux,
plus CLI commands for automation and batch subtitle work. See
`docs/product-roadmap.md`.

## Current Features

- `Extract from Video` workspace for the included MKV batch extractor.
- Local OCR helper for `SUP to SRT` and `SUB/IDX to SRT`.

## Requirements

- Node.js `>=22.13.0`
- For MKV subtitle extraction:
  - `mkvinfo`
  - `mkvextract`
- For the planned OCR backend:
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
npm run cli -- extract-english "/path/to/videos" --jobs 4
npm run cli -- peek-sup movie.sup --out-dir ./preview --count 3
npm run cli -- sup-to-srt movie.sup --lang eng --out movie.srt
npm run cli -- sup-to-srt *.sup --lang eng --out-dir ./srt --jobs 8
npm run cli -- subidx-to-srt movie.idx --lang eng --out movie.srt
npm run cli -- subidx-to-srt *.idx --lang eng --out-dir ./srt --jobs 8
npm run cli -- benchmark-ocr --reference reference.srt --candidate generated.srt
npm run cli -- benchmark-ocr --examples-dir ./examples --candidate-dir ./ocr-output
npm run cli -- inspect-missing-ocr --details ./ocr-output/details.json --examples-dir ./examples --out-dir ./ocr-misses
```

The package also exposes a `subtitle-workbench` binary for future packaging.

`peek-sup` extracts a few readable subtitle images from a PGS `.sup` file so the
operator can confirm the OCR language before running the full conversion.

## Extract English SUP Tracks From MKV Files

The extraction script is based on the existing workflow in
`/Volumes/Misc. Storage/Tools/extract_english_subs.sh`.

From a folder containing `.mkv` files:

```bash
JOBS=4 /path/to/repos/subtitle_workbench/tools/extract_english_subs.sh
```

Or from the project root:

```bash
cd /path/to/videos
JOBS=4 /path/to/repos/subtitle_workbench/tools/extract_english_subs.sh
```

The script:

- scans only the current directory;
- extracts English subtitle tracks;
- writes `movie.sup`, `movie1.sup`, `movie2.sup`, and so on;
- skips outputs that already exist;
- runs files in parallel with `JOBS=N`.

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
- `--jobs 8`
- `--ocr-engine auto` (default; uses Tesseract for SUP, and uses macOS Vision
  for SUB/IDX when available on macOS; otherwise uses the portable Tesseract
  accurate path)
- `--ocr-engine tesseract-hybrid` (faster, lower-accuracy baseline)
- `--ocr-engine tesseract-accurate` (portable Tesseract high-accuracy path)
- `--ocr-engine macos-vision` (optional macOS-only benchmark adapter; hidden
  on Windows/Linux and never used unless selected)

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

Use the threshold flags as the reliability gate for OCR changes. The current
fixture target is:

- `0` missing cues
- `0` extra cues
- `0` end-time mismatches
- character error rate at or below `1%`

For the checked benchmark output in `.tmp/ocr-examples-accurate`, run:

```bash
npm run ocr:gate
```

## Next Backend Step

The browser workbench now generates local commands for the OCR helper. The next
implementation pass should add local server routes that run those commands from
the UI and return downloadable `.srt` files directly.
