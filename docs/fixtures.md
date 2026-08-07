# Fixtures

Two tiers: small ones committed to the repo and run by CI, and a large local
set used for the OCR quality gate.

## Committed (`tests/fixtures/`)

Everything CI needs. Small enough to track, and no commercial content beyond a
few seconds of one subtitle track.

| File | What it is |
| --- | --- |
| `real-two-cues.sup` | A real PGS track truncated to its first three display sets, produced by `mkvextract`. Expected timings and text come from the matching reference SRT, so it validates decode *and* OCR against something we did not generate. |
| `two-cues.sup` | Synthetic, from `tools/make_pgs_fixture.mjs`. |
| `sample.vtt` | WebVTT parsing. |

`tools/make_pgs_fixture.mjs` builds synthetic PGS files, and exists only for
cases the real corpus does not contain — a composition object carrying
`object_cropped_flag`, and a partial palette update. Prefer a truncated real
file whenever one can express the case: the builder and the decoder share an
author, so a matching pair of bugs would cancel out. That is not theoretical,
it happened — the builder mis-encoded short transparent runs and silently
dropped a cue until the real fixture disagreed.

To cut a new one:

```bash
node -e '
const fs = require("fs");
const buf = fs.readFileSync(process.argv[1]);
let off = 0, ends = 0, cut = 0;
while (off + 13 <= buf.length) {
  if (buf[off] !== 0x50 || buf[off + 1] !== 0x47) { off++; continue; }
  const len = buf.readUInt16BE(off + 11);
  const end = off + 13 + len;
  if (buf[off + 10] === 0x80) { ends++; cut = end; if (ends >= 8) break; }
  off = end;
}
fs.writeFileSync("tests/fixtures/new.sup", buf.subarray(0, cut));
' "/path/to/track.sup"
```

## Local only (not tracked)

Large and disc-derived, so deliberately gitignored:

- `Subtitle Examples/` — SUP tracks plus reference SRTs. Drives `npm run ocr:gate`.
- `sub:idx examples/` — VobSub pairs plus references. Drives the SUB/IDX
  timing-first comparison.
- `.tmp/ocr-examples-accurate/` — previously generated SUP candidates the gate
  compares against. Regenerate with `sup-to-srt --out-dir`.

The gate fails rather than passing silently when these are absent, empty, or
below `--min-fixtures`. It only runs where the media exists; CI runs the
committed fixtures instead.

```bash
npm run ocr:gate

node tools/subtitle-workbench.mjs benchmark-ocr \
  --examples-dir 'sub:idx examples' \
  --candidate-dir .tmp/subidx-vision-full \
  --timing-first --fixture-metadata docs/fixture-metadata.json
```

`docs/fixture-metadata.json` annotates fixtures whose reference is known to be
wrong, so a bad baseline is not read as an engine failure — currently
`Spy Game (2001)1`, whose reference SRT is empty although the stream contains
23 real forced-overlay cues.
