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
- Full SUP gate (as of 2026-08-07, 45 fixtures): 28,550 cues, 0 missing,
  0 extra, 0 end mismatches, 0.66% total CER — identical with
  `--ocr-engine tesseract-accurate` forced, so the portable path now equals
  the macOS one on SUP.

Cons:

- Accuracy still trails the reference text in some places.
- Small or stylized cues need fallback preprocessing.
- Confidence scores are useful but not complete enough on their own.
- Portable SUB/IDX trails Vision slightly on the hard VobSub set
  (as of 2026-08-07, after the histogram repairs): 10 missing cues and 2.47%
  CER vs Vision's 6 missing and 1.83% in the timing-first benchmark. (Before
  those repairs it was 91 missing / 16.68% the same morning.)

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
- Slightly worse than tuned Tesseract on clean outlined SUP fonts
  (The Matrix: 1.05% vs 0.64% CER). It used to be far better on shadowed ones,
  but the `shadow-strip` repair closed that gap (Stargate: 0.07% on Tesseract
  now; the regeneration log shows zero Vision switches). SUP `auto` on macOS
  keeps the probe as a safety net for the next rendering style Tesseract
  cannot read, not as a corrective it currently needs.

SUB/IDX Vision timing-first result (as of 2026-08-07, after the
frame-timestamp fix):

- 6 missing cues
- 3 true extra cues
- 23 unverified forced/overlay cues from an empty reference file
- 0 shifted-text diagnostics
- 2 end mismatches
- 1.83% CER

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

1. Keep the current `auto` policy:
   - SUP on macOS with Vision available: per-track probe of both engines
     (`lib/ocr-engine-probe.mjs`) — the track's rendering style decides
   - SUP elsewhere: `tesseract-accurate`
   - SUB/IDX on macOS with Vision available: `macos-vision`
   - SUB/IDX elsewhere: `tesseract-accurate`
2. Preserve benchmark metadata so known-bad references do not hide actual
   engine quality.
3. Experiment with RapidOCR or PaddleOCR recognition models through ONNX Runtime
   through the `external-command` sidecar adapter.
4. Add line segmentation and glyph/template matching after benchmarks show where
   neural OCR still loses.

Shipped since this list was written: debug output (`--keep-temp` retains the
preprocessed images), and per-image result dedup keyed by content hash
(`lib/image-dedupe.mjs`) so identical subtitle bitmaps are recognised once.

## What Not To Do Yet

- Do not replace Tesseract before an adapter and benchmark harness exist.
- Do not add full PaddleOCR Python runtime to production packaging yet.
- Do not run text detection by default for PGS or normal VobSub.
- Do not aggressively rewrite OCR text with dictionary guesses.
- Do not copy decoder or OCR code from other subtitle apps without a license
  review.

## Benchmark Anchor

The authoritative, current numbers live in the gate itself: run
`npm run ocr:gate` against the local corpus (see `docs/fixtures.md`). As of
2026-08-07 the full 45-fixture SUP gate reads 28,550 cues, 0 missing, 0 extra,
0 end mismatches, 0.66% CER.
