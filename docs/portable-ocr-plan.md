# Portable OCR: decision document

Written 2026-08-07. Status: **option C done and shipped; A re-scoped to the
VobSub gap only.**

## The problem this must solve

Windows and Linux users get materially worse OCR than macOS users where
Tesseract's failure modes are answered only by Apple Vision, which does not
exist there. Originally that was two cases; the shadowed-SUP one has since
been solved portably (see option C below), leaving one:

| Case | Tesseract (portable today) | Vision (macOS only) |
| --- | --- | --- |
| SUB/IDX, 8-title VobSub set | 91 missing cues, 16.68% CER | 6 missing, 1.83% CER |
| ~~SUP, shadowed-extrusion font~~ | ~~15.72% CER~~ → **0.07%** via shadow-strip | 2.16% (no longer chosen) |

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

### C. Shadow-strip preprocessing for Tesseract (done, shipped 2026-08-07)

Attacked the Stargate failure directly and won. The shadow is a full dark
offset copy of every glyph, so its ink outweighs the light fill and
binarisation reads the copy; the `shadow-strip` variant in
`tesseract-accurate` detects that structure per image (dark/light ink mass
ratio ≥ 0.85 — shadowed tracks measure 1.2–1.3, outlined fonts 0.5, plain
~0.1), erases everything below the tonal midpoint and binarises the fill.

Measured with `--ocr-engine tesseract-accurate`: Stargate 15.72% → **0.07%**
CER (680/694 exact, nothing dropped), Stargate1 9.74% → **0.28%** — both far
better than Vision's 2.16%/1.13%. Clean corpus unchanged-to-better; full
45-fixture gate on pure Tesseract: 0 missing, 0 extra, 0.66% CER, identical
to `auto`. This removes the shadowed-SUP case from this plan entirely and
demotes option A from "the one that matters" to "the VobSub gap".

## Corpus prerequisite

Every SUP fixture except The Matrix and Stargate is one show, and the VobSub
reference SRTs carry known transcription errors. Before crowning any new
engine, the held-out set should grow by a few more titles from different
studios/eras (unusual fonts, colours, italics). The gate machinery and
`docs/fixture-metadata.json` already support this; it is purely a matter of
adding discs.

## Sequence

1. ~~Bounded spike of option C (shadow-strip).~~ Done — see above. It
   removed the SUP half of the problem and proved the "understand the damage
   before adding a runtime" order right.
2. Diagnose the VobSub failure mode the same way before reaching for ONNX:
   inspect what portable Tesseract actually sees on the worst VobSub titles
   (Gosford Park, Spy Game). If it is another structural, preprocessing-
   fixable pattern, fix it there first.
3. If preprocessing cannot close the VobSub gap: spike A as recognition-only
   PP-OCRv6-small behind the engine interface, benchmarked against the same
   success bar (now VobSub-only).
4. Decide packaging (optionalDependencies vs sibling package) only after A
   clears the bar.
5. Wire the probe off macOS: Tesseract vs ONNX, same two-signal calibration
   method, re-measured bands.
