# OCR Engine Evaluation

This note distills the outside OCR suggestions from `Context.md` into choices
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

Keep as the default baseline for now.

Pros:

- Easy to install and bundle as a sidecar binary.
- Works offline and supports many languages.
- Already integrated in the CLI.
- Good enough on the the reference discs PGS sample after targeted preprocessing:
  668 generated cues matched 668 SubtitleWorkbench reference cue timestamps.

Cons:

- Accuracy still trails the reference text in some places.
- Small or stylized cues need fallback preprocessing.
- Confidence scores are useful but not complete enough on their own.

### RapidOCR / PaddleOCR via ONNX Runtime

Best next neural OCR experiment.

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

1. Add a small OCR engine abstraction:
   - `recognize(imagePath, language, options) -> OcrResult`
   - Include text, confidence, engine name, mode/model, variant, duration, and
     warnings.
2. Move the current Tesseract hybrid into that abstraction without changing
   default behavior.
3. Add a benchmark command that compares generated SRT output against a
   reference SRT by timestamp, cue count, exact text matches, and edit distance.
4. Add debug-output support that keeps representative preprocessed images and
   raw OCR outputs when requested.
5. Add bitmap/result caching keyed by normalized image hash so repeated subtitle
   images do not get OCR'd repeatedly.
6. Experiment with RapidOCR or PaddleOCR recognition models through ONNX Runtime
   behind the same abstraction.
7. Add line segmentation and glyph/template matching after benchmarks show where
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

- Source: `/path/to/samples/the reference discs- Season 1 Disc 1_t00.sup`
- Reference: `/path/to/the reference discs- Season 1 Disc 1_t00-eng.srt`

Current Tesseract hybrid result:

- Reference cues: 668
- Generated cues: 668
- Missing timestamp matches: 0
- Extra timestamp matches: 0
- End-time mismatches: 0
- Exact text matches: 462 / 668
- Text edit distance: 734 / 18,374 reference characters

