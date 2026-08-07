# Portable OCR: decision document

Written 2026-08-07. Status: **proposed** — nothing here is implemented.

## The problem this must solve

Windows and Linux users get materially worse OCR than macOS users, because
the two failure modes Tesseract has are both currently answered by Apple
Vision, which does not exist there:

| Case | Tesseract (portable today) | Vision (macOS only) |
| --- | --- | --- |
| SUB/IDX, 8-title VobSub set | 91 missing cues, 16.68% CER | 6 missing, 1.83% CER |
| SUP with shadowed-extrusion font (Stargate) | 3 dropped cues, 15.72% CER | 0 dropped, 2.16% CER |

The per-track probe (`lib/ocr-engine-probe.mjs`) routes these tracks to
Vision on macOS. Off macOS there is nothing to route to.

## Success bar (set before starting, per the working agreements)

A portable engine ships as an `auto` candidate only if, on hardware without
Vision, it:

1. beats `tesseract-accurate` by **≥5 CER points** on the held-out sets —
   the VobSub 8-title set *and* the Stargate SUP tracks — while dropping no
   cues that Tesseract keeps;
2. does not regress the clean-font SUP corpus by more than **0.3 CER points**
   (Stranger Things + The Matrix, currently 0.68%);
3. runs the full 8-title VobSub set in **≤2×** the tesseract-accurate wall
   time on the same machine;
4. adds **zero weight and zero network activity** to `npm install` and
   `npm test` for users who never opt in.

Kill criterion: if the engine cannot beat Tesseract on the *shadowed* and
*outlined* sets simultaneously, it is not a portable Vision replacement and
should not become one by accumulating per-corpus tuning — that road was
already walked with `corpusFittedCleanup`.

## Options considered

### A. In-process ONNX engine: `onnxruntime-node` + PP-OCRv6 (recommended)

PaddleOCR released PP-OCRv6 in June 2026: Apache-2.0, one model family
covering 50 languages, in tiny (~6 MB) / small (~30 MB) / medium (~139 MB)
tiers. `onnxruntime-node` (MIT) ships prebuilt binaries for
macOS/Windows/Linux and is the same runtime every other portable-OCR path
(RapidOCR included) bottoms out in.

- New engine adapter `lib/ocr-onnx-ppocr.mjs` implementing the existing
  `recognize`/`recognizeBatch` interface — the probe then works off macOS
  unchanged, arbitrating Tesseract vs ONNX instead of Tesseract vs Vision.
- Ship it as an **optional add-on**, not a dependency: `onnxruntime-node` is
  ~270 MB unpacked, which would turn a 134 kB CLI into a monster install.
  Options, to be settled at implementation time: an
  `optionalDependencies` entry the CLI probes for, or a sibling package
  (`subtitle-workbench-onnx`) that `doctor` knows how to recommend.
- Models are **not** bundled: downloaded on first explicit use (or
  `doctor --fetch-models`), pinned by URL + SHA-256 in code, stored in
  `cacheDirectory("models")`. Never at install time, never during tests,
  and a checksum mismatch is a hard failure — the bridge threat model
  ("no network input selects what runs") extends to model weights.
- Start with the **small (~30 MB)** tier; measure tiny and medium against
  the success bar before deciding what the default is.

Wrapper libraries exist (`ppu-paddle-ocr`, MIT, actively maintained) and are
worth reading for preprocessing details, but they pull their own OpenCV
dependency and download models from their own URLs; hand-rolling
recognition-only inference against pinned models keeps the supply chain
auditable and the dependency tree flat.

Open question to answer first during the spike: whether detection is needed
at all. Subtitle frames are already cropped, bordered and line-structured by
our preprocessing; if line segmentation from the existing pipeline is enough,
recognition-only inference skips the detection model and roughly halves both
model weight and inference time.

### B. Python sidecar via `external-command` (rejected as default)

RapidOCR/`onnxocr-ppocrv5` are Python-first and work today through the
existing `external-command` seam — that seam stays, and power users can use
it now. As the *default* portable answer it fails on distribution: it asks
every Windows user for a Python environment (a worse ask than the tesseract
one), or asks us to build and sign PyInstaller binaries per platform — more
packaging surface than option A for the same underlying runtime and models.

### C. Shadow-strip preprocessing for Tesseract (complementary experiment)

Attack the Stargate failure directly: separate the extrusion shadow from the
glyph before Tesseract sees it (the fill and shadow are close in luminance
but separable — the palette has distinct entries, and the shadow is a
uniform offset copy of the glyph). Cheap to try, helps every platform, no new
dependencies — but it only addresses the shadowed-SUP case, not the VobSub
gap, and it risks becoming another pile of style-specific tuning. Worth one
bounded spike using the same success bar, measured with
`--ocr-engine tesseract-accurate` against the Stargate tracks. It does not
replace option A.

## Corpus prerequisite

Every SUP fixture except The Matrix and Stargate is one show, and the VobSub
reference SRTs carry known transcription errors. Before crowning any new
engine, the held-out set should grow by a few more titles from different
studios/eras (unusual fonts, colours, italics). The gate machinery and
`docs/fixture-metadata.json` already support this; it is purely a matter of
adding discs.

## Sequence

1. Bounded spike of option C (shadow-strip), because it is a day's work and
   its result changes how urgent A is on the SUP side.
2. Spike A as recognition-only PP-OCRv6-small behind the engine interface;
   benchmark against the success bar on macOS first (where references are
   plentiful), then on a Windows/Linux runner.
3. Decide packaging (optionalDependencies vs sibling package) only after A
   clears the bar.
4. Wire the probe off macOS: Tesseract vs ONNX, same two-signal calibration
   method, re-measured bands.
