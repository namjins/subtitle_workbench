# ITT to SRT Implementation Plan

Source session: `019fd920-e049-7d50-9b99-71eba65e705c`

## Summary

Add a fourth workbench tool, `ITT to SRT`, for single-file and batch conversion of
Apple/Final Cut Pro `.itt` subtitle files into `.srt`. This flow should stay
separate from OCR language selection. It uses FPS controls, defaults to `23.976`
(`24000/1001`), preserves subtitle line breaks, and writes clean same-basename
`.srt` outputs.

## Converged Product Decisions

- No OCR language selection for ITT.
- Default FPS is `23.976`, represented internally as `24000/1001` when useful.
- Supported FPS controls: `23.976`, `24`, `25`, `29.97`, `30`, `50`, `59.94`,
  `60`, and `Other`.
- `Other` accepts decimal or fractional FPS values.
- Invalid custom FPS should block conversion with a clear error.
- Output naming should be `Movie.itt` -> `Movie.srt`, not FPS-suffixed names.
- Preserve subtitle line breaks from source cues.

## Parser Scope

The first implementation should target Final Cut Pro / TTML-style `.itt` files:

- `<p begin end>` cues.
- `<p begin dur>` cues.
- Namespace-prefixed TTML tags.
- `HH:MM:SS:FF` frame timecodes.
- `HH:MM:SS.mmm` and `HH:MM:SS,mmm` clock timecodes.
- Nested text and XML entities.
- `<br/>` and `<br>` line breaks.

Avoid adding a new XML dependency for v1 unless tests show the narrow parser is
not reliable enough.

## Implementation Work

- Extend `lib/subtitle-core.mjs` with ITT/TTML conversion inside
  `convertToSrt`.
- Add FPS parsing for decimal and fractional values.
- Add CLI support:
  `subtitle-workbench itt-to-srt <files.itt...> [--fps 24000/1001] [--out file.srt] [--out-dir dir] [--skip-existing] [--json-events]`.
- Update `lib/local-runner.mjs` so `itt-to-srt` omits OCR-only args:
  language, jobs, OCR engine, and OCR command.
- Update `lib/local-bridge-server.mjs` validation to allow `itt-to-srt` with
  optional `fps`.
- Update `app/localBridgeClient.ts` bridge job types.
- Add a fourth workbench card and batch flow:
  - Accept and drop multiple `.itt` files.
  - Review queue with remove and clear actions.
  - Run stage with FPS preset selector and custom FPS input.
  - Button/status copy should say conversion, not OCR.
  - Results should show actual completed `.srt` paths from bridge events.

## Test Plan

- Core tests for namespace parsing, frame timecodes, fractional FPS, decimal
  timecodes, entity decoding, and preserved line breaks.
- CLI/runner tests confirming `itt-to-srt` args omit OCR-only settings and emit
  JSON events.
- Bridge validation tests for accepted `itt-to-srt`, rejected bad FPS, and
  unchanged OCR command behavior.
- Rendered workbench tests for `ITT to SRT`, `.itt` intake, FPS controls, and no
  language assignment in the ITT flow.
- Run focused tests first, then `npm test`.

## Notes

An earlier implementation attempt in the source session was intentionally
reverted. Treat this document as the plan to implement from, not as a record of
completed work.
