# OCR Engine Evaluation

This note distills the outside OCR suggestions in
`docs/ocr-improvement-brief.md` into choices
that fit this project: local-first, cross-platform desktop packaging, and a CLI
that can run unattended.

## Useful Ideas

- Keep OCR recognition tied to decoded subtitle bitmap events, not video-frame
  scene text detection. PGS and VobSub already provide timing and image events.
- Preserve the current Tesseract path as the baseline and fallback while testing
  other engines.
- Add an OCR adapter boundary before introducing a second engine, so CLI, future
  Tauri commands, diagnostics, and benchmarks can all call the same interface.
- Use recognition-only OCR by default. Text detection is unnecessary for normal
  subtitle bitmaps and should only be a fallback for failed line segmentation.
- Compare OCR variants with a scoring function, not just raw engine confidence.
  Our current Tesseract hybrid already follows this pattern.
- Add reusable diagnostics: selected engine, preprocessing variant, confidence,
  raw text, postprocessing changes, timing, and image references when debugging.
- Add benchmark tooling against reference SRTs before changing default behavior.

## Engine Candidates

### Tesseract

Keep as the portable baseline and SUP default for now.

Pros:

- Easy to install and bundle as a sidecar binary.
- Works offline and supports many languages.
- Already integrated in the CLI.
- Good enough on the reference PGS sample after targeted preprocessing:
  668 generated cues matched 668 provided reference cue timestamps.
- Current full SUP gate passes with 26,415 / 26,415 cues, 0 missing, 0 extra,
  0 end mismatches, and 0.68% total CER.

Cons:

- Accuracy still trails the reference text in some places.
- Small or stylized cues need fallback preprocessing.
- Confidence scores are useful but not complete enough on their own.
- Portable SUB/IDX quality is not yet good enough on the hard VobSub set:
  91 missing cues and 16.68% CER in the current timing-first benchmark, driven
  mainly by Gosford Park and Spy Game.

### macOS Vision

Use as the macOS SUB/IDX default when available.

Pros:

- Built into macOS, so it does not add a third-party runtime for Mac users.
- Much better than Tesseract on hard outlined VobSub subtitles.
- After batch-mode OCR and parallel VobSub preprocessing, the full 8-title
  SUB/IDX sample completes in about 4m 41s on the current M2 Ultra system.

Cons:

- macOS only.
- Requires `swiftc` for the local helper build in the current implementation.
- Not suitable as the cross-platform answer.
- Worse than tuned Tesseract on the tested SUP sample, so `auto` remains
  Tesseract for SUP.

Current SUB/IDX Vision timing-first result:

- 25 missing cues
- 3 true extra cues
- 23 unverified forced/overlay cues from an empty reference file
- 15 shifted-text diagnostics
- 0 end mismatches
- 2.05% CER

### RapidOCR / PaddleOCR via ONNX Runtime

Best next portable neural OCR experiment for Windows/Linux parity.

Pros:

- Better fit than the full PaddleOCR Python stack for a packaged desktop app.
- ONNX Runtime has a clearer cross-platform packaging story than bundling a
  complete Python OCR runtime.
- Recognition-only mode can fit our decoded subtitle image workflow.

Cons:

- Adds model files, runtime binaries, and license/attribution work.
- Language model selection and storage need design before shipping.
- Node integration may require a native package or a sidecar process.
- Needs benchmarking before becoming a default engine.
- This is the likely route to close the SUB/IDX gap on Windows and Linux,
  where Apple Vision is unavailable.

Integration path:

- Implement a small sidecar command first, not an in-process dependency.
- Call it through:

```bash
node tools/subtitle-workbench.mjs subidx-to-srt movie.idx \
  --ocr-engine external-command \
  --ocr-command /path/to/ocr-sidecar \
  --jobs 8
```

- Sidecar contract:
  - argv 1: PNG image path
  - argv 2: OCR language, e.g. `eng`
  - stdout: plain text or JSON like
    `{"text":"Hello","confidence":0.98,"model":"rapidocr-onnx"}`
- Once a sidecar proves useful, decide whether to keep it as a sidecar binary
  or replace it with an in-process ONNX Runtime adapter.

### Full PaddleOCR Python Runtime

Avoid as a production dependency unless we intentionally add a Python backend.

Pros:

- Strong OCR ecosystem and tooling.
- Useful for experiments and offline comparison.

Cons:

- Heavy dependency footprint.
- More complicated packaging for macOS, Windows, and Linux.
- More startup and environment failure modes than sidecar binaries or ONNX.

### Cloud OCR

Only consider as an optional plugin later.

Pros:

- Potentially strong accuracy.
- No local model packaging.

Cons:

- Conflicts with the local-first/offline goal.
- Adds privacy, cost, API key, and rate-limit concerns.
- Not appropriate as the default conversion path.

## Recommended Implementation Order

1. Keep the current flow-specific `auto` policy:
   - SUP: `tesseract-accurate`
   - SUB/IDX on macOS with Vision available: `macos-vision`
   - SUB/IDX elsewhere: `tesseract-accurate`
2. Preserve benchmark metadata so known-bad references do not hide actual
   engine quality.
3. Add debug-output support that keeps representative preprocessed images and
   raw OCR outputs when requested.
4. Add bitmap/result caching keyed by normalized image hash so repeated subtitle
   images do not get OCR'd repeatedly.
5. Experiment with RapidOCR or PaddleOCR recognition models through ONNX Runtime
   through the `external-command` sidecar adapter.
6. Add line segmentation and glyph/template matching after benchmarks show where
   neural OCR still loses.

## What Not To Do Yet

- Do not replace Tesseract before an adapter and benchmark harness exist.
- Do not add full PaddleOCR Python runtime to production packaging yet.
- Do not run text detection by default for PGS or normal VobSub.
- Do not aggressively rewrite OCR text with dictionary guesses.
- Do not copy decoder or OCR code from other subtitle apps without a license
  review.

## Current Benchmark Anchor

Using:

- Source: `/path/to/samples/sample-track.sup`
- Reference: `/path/to/sample-track-eng.srt`

Current Tesseract hybrid result:

- Reference cues: 668
- Generated cues: 668
- Missing timestamp matches: 0
- Extra timestamp matches: 0
- End-time mismatches: 0
- Exact text matches: 462 / 668
- Text edit distance: 734 / 18,374 reference characters
