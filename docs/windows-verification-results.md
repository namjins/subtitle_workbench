# Windows manual verification — results

First run of `docs/windows-verification.md` on real Windows hardware.

| | |
| --- | --- |
| Date | 2026-08-07 |
| Machine | Windows 11 Education 26200, x64 |
| Node | v24.18.0 (npm 11.16.0) |
| Starting state | Fresh clone, no `node_modules`, none of the four media tools installed |
| Commits from this session | `c1be788`, `1abbf98` |

Tool versions as installed by the README's `winget` line:

| Tool | Version |
| --- | --- |
| FFmpeg | 9.0-full_build (Gyan) |
| Tesseract | 5.4.0.20240606 (UB-Mannheim) |
| ImageMagick | 7.1.2-29 Q16-HDRI |
| MKVToolNix | 100.0 |

Everything below was run, not inspected. GUI steps that cannot be driven from a
terminal were run by the user and are marked as such; the two z-order findings
were then reproduced mechanically with a Win32 probe so the fix could be
measured rather than guessed at.

## Setup

| Check | Result |
| --- | --- |
| README Windows install section followed exactly | **Fail** → fixed, see F3 |
| `doctor` reports everything OK after a terminal restart | **Fail** → fixed, see F1/F3 |

`doctor` passes cleanly once `PATH` is right: all 8 binaries OK, `eng` language
data present, "All required dependencies are available".

## Web UI (`subtitle-workbench ui`)

| Check | Result |
| --- | --- |
| Page opens; no dependency warning banner | **Pass** (user) |
| Browse on SUP to SRT opens a native dialog, multi-select, cancel is a no-op | **Fail** → fixed, see F4. Multi-select and cancel themselves behaved correctly |
| Browse on Extract from Video fills the real path | **Pass** (user) — real path, not `C:\fakepath\` |
| Drag-and-drop of a SUP file | **Pass** (user) |
| A real SUP conversion completes, output beside source as `name-eng.srt` | **Pass** |
| Repeat conversion is instant and names the producing version | **Pass** — 4.4s → 0.17s, "reused cached conversion from app version 0.1.0" |
| "Show SRT files" opens Explorer with the file selected | **Partial** — the correct file is selected, but the window opens behind the browser. See F5 |

## Desktop shell

| Check | Result |
| --- | --- |
| `npm run app:desktop` builds and opens at a sensible size | **Not run** — no Rust toolchain on this machine |
| Layout matches macOS | **Not run** |
| Kill from Task Manager leaves no `node` bridge process | **Not run** |
| Dialogs work from the desktop window | **Not run** |

This whole section is untested. It needs `rustup` installed; nothing here should
be assumed working.

## OCR quality

Full gate over the local corpus, 45 SUP tracks, 28550 reference cues:

```
npm run ocr:gate
TOTAL   ref 28550   got 28545   missing 6   extra 0   unverified 1
        shifted 0   end-mismatch 0   exact 25663/28550   CER 0.66%
```

**The gate fails**, on `missing cues 6 > 0`. Every other threshold passes, and
0.66% CER is inside the 1% budget. See F6 — this is a real limitation, not a
code defect, and it is not fixed.

Single-file sanity check against its reference (`Stargate1`, 70 cues): 0 missing,
0 extra, 66/70 exact, **0.28% CER**.

## Known sharp edges

| Check | Result |
| --- | --- |
| PATH: tools installed while a terminal is open are invisible until restart | **Confirmed**, and doctor does say so — but saying so is not sufficient, see F3 |
| Paths with spaces | **Pass** — `folder with spaces\Stargate1.sup`, 70 cues |
| Non-ASCII file names | **Pass** — `Amélie café — trailer (2001).sup`, 70 cues, accents preserved in the output name |
| Very long path (>260 chars) | **Pass** — 347-character source path converted normally |

## Findings

### F1 — Windows' own `convert.exe` reported as a broken ImageMagick — fixed

Windows ships `C:\Windows\System32\convert.exe` (FAT→NTFS conversion) on every
machine. The `convert` alternate exists for Debian's ImageMagick 6, but on
Windows it *always* resolves, so a machine with no ImageMagick installed got:

```
BROKEN  magick  C:\Windows\System32\convert.exe (Invalid drive specification.)
```

instead of `MISSING` plus the winget install line. `doctor` was actively
misleading about the one thing it exists to report. Fixed in `c1be788` by
skipping alternates on win32, with a regression test that injects platform and
lookup so it runs everywhere.

### F2 — `.gitignore` did not match the media corpus on Windows — fixed

NTFS forbids `:` in a filename, so copying the corpus over renames
`sub:idx examples` to use U+F022, the private-use character Windows substitutes.
The literal ignore rule stopped matching and a single `git add -A` staged ~1.3GB
of commercial disc material. Caught before it was committed.

`?` does not fix it either — git matches byte-wise and U+F022 is three UTF-8
bytes. Fixed in `c1be788` with `/sub*idx examples/`.

### F3 — Tesseract and MKVToolNix are not added to PATH — docs fixed

FFmpeg's and ImageMagick's winget packages put themselves on `PATH`. Tesseract's
and MKVToolNix's do not, and no amount of restarting the terminal helps. A
novice following the README lands on a `doctor` run reporting two tools missing
with install instructions for packages they *just installed* — a dead end.

The README now names the two folders to add and where to add them. Note the
machine `PATH` needs admin; the user `PATH` works and is what a normal user can
edit.

### F4 — File picker opened behind the browser — fixed

Clicking **Browse** appeared to do nothing. The native dialog opened *behind*
the browser window, and because it is modal the app looked frozen until you
found the dialog in the taskbar.

The bridge spawns PowerShell to show the dialog, and Windows does not let a
background process take focus, so an unowned `ShowDialog()` lands below whatever
was foreground — always the page the user just clicked in. Showing it owned by
an off-screen `TopMost` form fixes it: `WS_EX_TOPMOST` renders above every
non-topmost window regardless of focus, and an owned dialog joins that band. The
focus restriction still applies; topmost is what does the work.

Measured with a z-order probe, browser focused, driving the real `/files/pick`
endpoint:

| | dialog z | topmost | foreground | browser z | |
| --- | --- | --- | --- | --- | --- |
| before | 3 | False | False | 2 | behind |
| after | 1 | True | True | 4 | in front |

Fixed in `1abbf98`. The reproduction matters: driving the dialog from an
interactive shell shows it *in front*, because the browser is not foreground
then. Only the real endpoint with the browser focused reproduces it.

### F5 — Explorer reveal opens behind the browser — not fixed, needs a decision

Same root cause, non-modal. "Show SRT files" selects the right file, but the
window opens behind the browser (measured: Explorer z=3, browser z=2,
foreground=False).

A verified fix exists but was not applied, because it is a real trade-off rather
than an obvious win:

- `SetForegroundWindow` on the Explorer window **does not work** — measured,
  returns False. The foreground lock blocks it. The F4 trick does not transfer,
  because that worked by owning *our own* window, and Explorer's window is not
  ours.
- Flipping the window `HWND_TOPMOST` then straight back to `HWND_NOTOPMOST`
  **does work** — measured, Explorer z=3 vs browser z=4. A z-order change on
  another process's window is not subject to the foreground lock.

Against applying it: it needs ~40 lines of Win32 interop in the bridge, which
`CLAUDE.md` calls hostile-input territory; it has to locate the window by title,
which can raise the wrong Explorer window; and it adds PowerShell startup plus a
runtime C# compile (~300ms) to every reveal. It would also need the path passed
by environment variable rather than interpolated into the script, since a
filename may legitimately contain a quote.

There is also an argument that the current behaviour is closer to platform
convention: Windows deliberately flashes a background-opened window in the
taskbar instead of letting it steal focus.

### F6 — OCR gate cannot pass on Windows — real, not fixed

Six missing cues, and they are the *same three cues* twice: `_t02` and its
forced-subtitle subset `_t021` from `Stranger Things Season 4 Disc 2` both
contain them.

```
MISSING @ 00:34:58,805  "...hit."
MISSING @ 00:35:02,559  "...hit."
MISSING @ 00:35:19,576  "...hit."
```

The decoder produces these cues correctly — `inspect-missing-ocr` extracts the
bitmap for each. OCR then returns empty and the cue is dropped. Confirmed by
running Tesseract on the extracted image directly:

| mode | output |
| --- | --- |
| psm 6 (pipeline default) | *(empty)* |
| psm 7 | *(empty)* |
| psm 8 | `bit,` |
| psm 13 | `bit,` |

So this Tesseract build cannot read that image: short, low-contrast,
drop-shadowed, leading ellipsis. Hand-tuned preprocessing made it worse, not
better; the pipeline's own variants are better tuned than anything tried here.

The likely explanation is the documented design rather than a regression. The
README already says macOS probes each Blu-ray track and can fall back to Apple
Vision, and that "Windows and Linux have no such net". The macOS baseline for
this track was probably produced by Vision.

**This is unverified.** `RUNNING_NOTES.md` is gitignored and lives on the Mac, so
the macOS baseline numbers were not available here, and macOS cannot be run from
this machine. Before treating 6 missing cues as the expected Windows number,
compare against the macOS baseline and confirm which engine produced that track.

The consequence either way: `npm run ocr:gate` as currently configured
(`--max-missing 0`) is a macOS gate. It cannot pass on Windows unless the
threshold becomes platform-aware or the preprocessing learns this glyph style.
Nothing was loosened to make it go green.

## Still open

- Desktop shell section is entirely unrun — needs `rustup`.
- F5 needs a decision on whether the interop is worth it.
- F6 needs the macOS baseline to confirm the explanation, then a decision on
  what the gate should require on Windows.
