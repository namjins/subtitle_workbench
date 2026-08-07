# OCR Improvement Brief

External brief on improving OCR for bitmap subtitle formats, kept as the
starting point for closing the gap in VobSub quality on Windows and Linux,
where Apple Vision is unavailable. It is a proposal, not a description of this
codebase: parts are
already done (the engine adapter boundary, benchmark tooling, preprocessing
variants), and parts are deliberately not planned yet.

`docs/ocr-engine-evaluation.md` is the distilled version with decisions applied.

---

We need to improve OCR for bitmap subtitle formats used by this application.

## Context

The app processes:

- Blu-ray PGS subtitles from `.sup`
- DVD VobSub subtitles from `.sub/.idx`

These formats already contain timed bitmap subtitle events. Do not render subtitles over video frames and perform scene-text detection. Decode each subtitle event directly into an image and preserve its original timing and metadata.

## Goal

Implement a reliable, offline-capable OCR pipeline that performs better than Tesseract on PGS and VobSub subtitles.

Preferred architecture:

1. Decode subtitle packets into bitmap images.
2. Apply palette, alpha, positioning, and composition information correctly.
3. Normalize and crop the bitmap for OCR.
4. Segment multi-line subtitles into individual text lines.
5. Run a glyph/template matcher where possible.
6. Use a neural OCR recognizer for unknown or low-confidence text.
7. Apply conservative subtitle-specific postprocessing.
8. Preserve timestamps, coordinates, forced flags, and other stream metadata.
9. Produce structured OCR results suitable for SRT, WebVTT, ASS, or the app’s internal subtitle model.

## OCR engine

Use a PaddleOCR PP-OCRv5 recognition model as the preferred neural recognizer.

Deployment preference:

- Run the recognition model locally.
- Prefer ONNX Runtime for cross-platform inference.
- RapidOCR may be used if it integrates more cleanly with the existing application stack.
- Avoid requiring the complete PaddleOCR Python runtime in production unless the app is already Python-based.
- Do not run a text detector by default because the subtitle bitmap has already been isolated.
- Text detection should only be used as a fallback when line segmentation cannot reliably identify the text regions.

Inspect the current project language, target platforms, packaging system, and architecture before selecting the runtime and bindings.

## Pipeline

Implement or refactor the processing flow toward this structure:

```text
PGS/VobSub parser
    ├── timestamps
    ├── screen coordinates
    ├── forced flag
    ├── palette and alpha data
    └── decoded bitmap
             ↓
Palette-aware foreground extraction
             ↓
Transparent-margin cropping
             ↓
Line and connected-component segmentation
             ↓
Glyph/template matching
             ↓
PP-OCRv5 recognition for unknown or low-confidence text
             ↓
Subtitle-specific validation and correction
             ↓
Structured subtitle output
```

## PGS handling

For PGS `.sup` subtitles:

- Reconstruct all objects referenced by the presentation composition.
- Apply palette definitions and transparency values correctly.
- Respect object placement and screen coordinates.
- Compose multiple objects when one subtitle event contains more than one bitmap.
- Crop using visible alpha bounds while retaining original screen position separately.
- Preserve forced-display information.
- Avoid flattening the fill, outline, and shadow into an uncontrolled grayscale image.
- Generate a clean foreground mask using palette and alpha information where possible.
- Preserve anti-aliased interior pixels when they improve recognition.
- Keep outline suppression configurable because some tracks require outline information to retain character shapes.

Create OCR input variants when useful:

1. Text-fill mask.
2. Text fill plus inner anti-aliasing.
3. Grayscale or luminance image with most of the outline suppressed.

Run the recognizer against the most suitable variant or compare results using confidence and validation rules.

## VobSub handling

For `.sub/.idx` subtitles:

- Read the color palette from the `.idx` file.
- Respect packet-level alpha and contrast information.
- Decode the bitmap without lossy image intermediates.
- Crop transparent margins.
- Identify likely text-fill colors separately from outlines and shadows.
- Upscale low-resolution images before neural OCR.
- Make the scale configurable; start with approximately 3× or 4×.
- Use nearest-neighbor scaling for template matching.
- Use bicubic or Lanczos scaling for neural recognition.
- Add optional connected-component cleanup after scaling.
- Avoid JPEG output at every stage.

VobSub images are low resolution, so preprocessing and template matching are especially important.

## Glyph/template matching

Add a subtitle-specific glyph recognition layer.

Rationale:

- A subtitle track normally reuses the same rasterized font.
- Repeated characters can be nearly pixel-identical after palette and alpha normalization.
- Once a glyph has been identified, matching it again can be faster and more reliable than neural OCR.

Suggested behavior:

- Extract connected components or character candidates.
- Normalize each glyph while preserving aspect ratio and meaningful pixel structure.
- Generate a stable visual hash or feature representation.
- Match against known glyph templates using exact or similarity-based comparison.
- Store templates by track, font style, size, italic state, and preprocessing variant where practical.
- Allow neural OCR to propose a character for unknown glyphs.
- If the application is interactive, allow the user to confirm ambiguous glyphs.
- Save confirmed glyph mappings so accuracy improves during the track and, optionally, across future tracks.
- Keep glyph dictionaries versioned and scoped so mappings from unrelated fonts do not introduce false matches.

Do not require manual training for basic operation. Template recognition should improve the automatic result rather than block it.

## Line segmentation

Because the neural recognizer should operate in recognition-only mode, implement reliable line extraction:

- Use alpha bounds, connected components, and vertical overlap to group components into text lines.
- Support one-line, two-line, and occasional multi-line subtitles.
- Preserve reading order.
- Account for italics and characters with descenders.
- Avoid splitting punctuation, accents, dots, or quotation marks into separate lines.
- Add configurable padding around each line before OCR.
- Detect when segmentation is uncertain and fall back to whole-image recognition or an OCR detector.

## OCR interface

Create an abstraction so OCR engines can be replaced or compared.

Example conceptual interface:

```text
SubtitleOcrEngine
    recognize(image, language, options) -> OcrResult
```

`OcrResult` should include at least:

- Recognized text
- Overall confidence
- Per-line confidence
- Per-token or per-character confidence when available
- Bounding information when available
- Engine name and model version
- Preprocessing variant used
- Warnings or uncertainty flags
- Processing duration

Implement the PP-OCRv5 engine behind this interface. Keep the existing Tesseract implementation available temporarily as a fallback or benchmark unless removing it is already part of the project scope.

## Language handling

- Use an explicitly selected subtitle language when available.
- Select the appropriate PP-OCR recognition model for the language or script.
- Do not assume English.
- Support language configuration at the subtitle-track level.
- Record the active model and language in diagnostics.
- If automatic language detection already exists, treat it as a hint rather than an unquestioned result.
- Keep model downloads and storage compatible with the app’s packaging and offline requirements.

## Confidence and result selection

Do not rely only on the OCR model’s confidence score.

Combine signals such as:

- Neural recognizer confidence
- Glyph-template match confidence
- Dictionary or language-model plausibility
- Character consistency across the subtitle track
- Repeated-line consistency
- Agreement between preprocessing variants
- Agreement between OCR engines when fallback comparison is enabled
- Expected punctuation and subtitle formatting patterns

When multiple variants are recognized, select the result using a scored decision function and retain diagnostics explaining the choice.

## Deduplication and reuse

Add track-level reuse:

- Hash normalized subtitle bitmaps.
- Detect identical or near-identical subtitle images.
- Reuse an existing OCR result when the same image appears again.
- Reuse recognized glyphs across events.
- Consider clustering near-identical lines before OCR.
- Preserve separate timestamps even when text recognition is reused.

## Postprocessing

Postprocessing must be conservative.

Implement configurable corrections for common bitmap OCR errors such as:

- `I`, `l`, and `1`
- `O` and `0`
- `rn` and `m`
- Straight and curly quotes
- Hyphens, em dashes, and dialogue markers
- Ellipses
- Accents and combining marks
- Italic markup
- Music-note characters
- Spaces around punctuation

Requirements:

- Do not aggressively rewrite proper names.
- Do not silently replace text solely because a dictionary prefers another word.
- Keep raw OCR text available for debugging.
- Record applied corrections.
- Prefer warnings or low-confidence flags over destructive guessing.

## Metadata preservation

OCR must not discard subtitle-stream metadata.

Retain:

- Start timestamp
- End timestamp
- Original screen coordinates
- Bitmap dimensions
- Canvas dimensions
- Forced-subtitle flag
- Original packet or event identifier
- Track language
- Source format
- OCR confidence
- Original decoded bitmap or a reference to it when debugging is enabled

OCR should modify or add text content, not replace the original subtitle event representation prematurely.

## Performance

The app may process thousands of subtitle events per movie.

Optimize for:

- Reusing the OCR model instance
- Batched recognition where supported
- Avoiding repeated model initialization
- Avoiding unnecessary image conversions
- Bitmap and OCR-result caching
- Parallel preprocessing
- Controlled parallel inference based on runtime and hardware
- Cancellation and progress reporting
- Bounded memory use
- CPU-only operation as a supported baseline
- Optional GPU or hardware acceleration

Do not introduce uncontrolled concurrency around ONNX Runtime sessions. Follow the runtime’s threading recommendations and benchmark the implementation.

## Diagnostics

Add detailed optional logging for:

- Subtitle decode failures
- Palette and alpha interpretation
- Crop bounds
- Segmented line bounds
- Generated preprocessing variants
- Selected OCR model
- Raw recognizer output
- Confidence values
- Template matches
- Applied corrections
- Final result-selection reasoning
- Processing time per event

Provide an optional debug-output mode that saves representative intermediate PNG files. Do not enable large debug output by default.

## Testing

Add tests using representative samples or fixtures for:

- Clean HD PGS
- PGS with outlines and shadows
- PGS with two lines
- PGS with multiple composition objects
- Forced PGS subtitles
- Low-resolution VobSub
- VobSub with unusual palettes
- Italic subtitles
- Accented characters
- Music notes and symbols
- Repeated glyphs
- Identical subtitle image reuse
- Transparent or empty events
- Malformed or incomplete packets
- Multiple languages or scripts

Where licensing permits, maintain a small set of anonymized or synthetic bitmap fixtures in the repository.

Add benchmark output that compares:

- Existing Tesseract result
- PP-OCRv5 result
- Hybrid glyph plus PP-OCR result

Measure:

- Character error rate
- Word error rate
- Event-level exact-match rate
- Processing time
- Memory use

## Licensing and distribution

Before adding dependencies:

- Verify the license of the model, runtime, wrapper, and decoder.
- PaddleOCR and RapidOCR are generally suitable candidates under Apache 2.0.
- ONNX Runtime is generally suitable under the MIT license.
- Review the project’s FFmpeg build and linking configuration.
- FFmpeg licensing depends on enabled components and build options.
- Do not copy code from Subtitle Edit or another application without verifying license compatibility.
- Behavioral inspiration is acceptable; direct code reuse requires a license review.

Include required license notices and model attribution in the app’s distribution package.

## Implementation approach

First inspect the current codebase and identify:

1. Existing PGS and VobSub decoding paths.
2. Existing Tesseract integration.
3. Subtitle event and metadata models.
4. Image representation used internally.
5. Supported operating systems and CPU architectures.
6. Current dependency-management and packaging approach.
7. Whether ONNX Runtime or Paddle-related dependencies already exist.
8. Existing test fixtures and OCR evaluation tools.

Then implement the change incrementally:

1. Introduce the OCR abstraction without breaking existing behavior.
2. Add preprocessing and line segmentation.
3. Add the PP-OCRv5 recognition backend.
4. Add configuration and model loading.
5. Add diagnostics and confidence reporting.
6. Add caching and deduplication.
7. Add glyph/template matching.
8. Add conservative postprocessing.
9. Add tests and benchmarks.
10. Retain Tesseract as a configurable fallback until the new path is validated.

Prefer small, reviewable changes over a large rewrite.

## Deliverables

Produce:

- The implementation integrated into the existing app.
- Any required model-loading and model-management code.
- Configuration options for language, engine, preprocessing, and confidence thresholds.
- Unit and integration tests.
- Benchmark or comparison tooling.
- Documentation explaining installation, model requirements, supported languages, and fallback behavior.
- A concise summary of architectural changes.
- A list of files changed.
- Known limitations and recommended next steps.

Do not redesign unrelated parts of the application. Follow the existing project conventions and reuse current abstractions where reasonable.