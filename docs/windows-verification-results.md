# Windows manual verification — results

First run of `docs/windows-verification.md` on real Windows hardware.

| | |
| --- | --- |
| Date | 2026-08-07 |
| Machine | Windows 11 Education 26200, x64 |
| Node | v24.18.0 (npm 11.16.0) |
| Starting state | Fresh clone, no `node_modules`, none of the four media tools installed |
| Commits from this session | `c1be788`, `1abbf98`, `f574e6e`, `e81162f`, `19bc3e5`, `06528ac` |

Tool versions as installed by the README's `winget` line:

| Tool | Version |
| --- | --- |
| FFmpeg | 9.0-full_build (Gyan) |
| Tesseract | 5.4.0.20240606 (UB-Mannheim), later 5.5.3.20260724 (upstream) — see F6 |
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
| `npm run app:desktop` builds and opens at a sensible size | **Pass**, after F7 |
| Layout matches macOS | **Not run** — needs a side-by-side eye |
| Kill from Task Manager leaves no `node` bridge process | **Pass** |
| Dialogs work from the desktop window | **Not run** |

Rust 1.97.1 and the MSVC C++ build tools were installed for this run; the build
needed both (F7). The window then opened at **1396×969** on a 1920×1080 monitor
(working area 1920×1032) — comfortably inside it, neither cramped nor oversized.
It spawns the bridge as a child `node.exe` alongside `msedgewebview2.exe`.

The orphan check was run twice, because the two shutdowns are not the same test:

- **Graceful close** (window closed, shell exits 0): bridge `node.exe` gone.
- **Hard kill** — `Stop-Process -Force`, which is the same `TerminateProcess`
  that Task Manager's "End task" issues, so no exit handler runs: shell PID 4128
  killed, bridge PID 20088 **also gone**. Nothing left listening, no orphaned
  WebView2, no stray `node`.

The hard kill is the one worth having: a bridge that survives it keeps an
authorized HTTP server on a known port with no window to close.

Layout and the desktop-window dialogs are unrun, not passing.

## OCR quality

Full gate over the local corpus, 45 SUP tracks, 28550 reference cues.

**Under Tesseract 5.4.0 the gate fails** on `missing cues 6 > 0`. Every other
threshold passes, and 0.66% CER is inside the 1% budget:

```
npm run ocr:gate
TOTAL   ref 28550   got 28545   missing 6   extra 0   unverified 1
        shifted 0   end-mismatch 0   exact 25663/28550   CER 0.66%
```

macOS on the same corpus and day: `28550 cues · 0 missing · 0 extra ·
1 unverified · 0 end mismatches · 0.66% CER`. Identical CER, and the whole
difference is the 6 dropped cues.

F6 traces that to the Tesseract version. **Under 5.5.3 the gate passes**, on a
clean regeneration of all 45 tracks with `--no-cache` (19m45s):

```
npm run ocr:gate
TOTAL   ref 28550   got 28551   missing 0   extra 0   unverified 1
        shifted 0   end-mismatch 0   exact 25717/28550   CER 0.66%
OCR quality gate passed.
```

That is the macOS baseline on every axis — same cue count, same 0 missing, same
single unverified cue (`The Matrix`, a known reference gap), same 0.66% CER. The
two failing tracks come out at 1107/1107 and 28/28.

So there is **no Windows-specific OCR drift**. The entire gap was the Tesseract
version, and no threshold was changed to reach this.

Single-file sanity check against its reference (`Stargate1`, 70 cues, Tesseract
5.4.0): 0 missing, 0 extra, 66/70 exact, **0.28% CER**.

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

### F6 — OCR gate failed on Windows: Tesseract 5.4.0 drops cues — fixed

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

**Cause: the Tesseract version, not the platform.** macOS had 5.5.1, this
machine had 5.4.0 — the newest the widely-recommended `UB-Mannheim.TesseractOCR`
winget package ships.

The first hypothesis here was wrong and is worth recording as such. Because the
README says macOS probes each Blu-ray track and can fall back to Apple Vision
while "Windows and Linux have no such net", the missing cues looked like the
absent Vision safety net. The macOS baseline disproves it: that track ran
`tesseract-accurate`, with zero Vision switches logged across all 43 non-Stargate
tracks. macOS read the cues as `...hit,` — a one-character mismatch against the
reference's `...hit.`, counted in CER rather than as missing.

Installing 5.5.3 (`winget install tesseract-ocr.tesseract`) and rerunning the
same track: **1107 cues instead of 1104**, all three reading `...hit,` —
character for character what macOS produced.

Also worth recording: the diagnosis nearly went the other way. Running
`tesseract` by hand on the extracted bitmap returns empty under *both* 5.4.0 and
5.5.3. Only through the pipeline's preprocessing does the difference appear, so
the raw-image check argues for platform drift and is simply wrong. The extracted
bitmap is not what the pipeline feeds the OCR engine.

Fixed in `19bc3e5`: a 5.5.0 version floor, `doctor` warning (not failing — an
older Tesseract still converts, it is just lossier) when it finds an older
build, and the install line switched to the upstream `tesseract-ocr.tesseract`
package, since UB-Mannheim's stops below the floor.

Confirmed corpus-wide: the gate passes under 5.5.3 with numbers identical to
macOS. See "OCR quality" above. No gate threshold was loosened at any point.

### F8 — a Tesseract upgrade did not invalidate the cache — fixed

Found while confirming F6, and it undermined the F6 fix completely. After
upgrading to 5.5.3 the whole 45-track regeneration "finished" in **3.3 seconds**
and reproduced the exact missing cues the upgrade was supposed to fix.

The cache key covers the source bytes and the requested options. `engine` is the
*requested* engine, so `auto` hashes the same before and after an upgrade — but
it does not produce the same text. Every already-converted file kept returning
its 5.4.0 result forever. Anyone following the new "install Tesseract 5.5"
advice would have seen no improvement and had nothing to explain why.

Fixed in `06528ac`: the recogniser version is recorded on the entry and a
mismatch reads as a miss.

The first attempt put it *in the key*, and the test suite caught that this
breaks "serves a cached conversion even when the tools are gone" — with no
Tesseract on `PATH` the version reads as `absent`, which changes the key, so
uninstalling ffmpeg or Tesseract would discard conversions that were already
finished. The key has to stay computable without the tools, because the cache is
consulted before preflight for exactly that reason. So an absent or unreadable
version never invalidates, and neither does an entry written before the field
existed.

### F7 — the desktop shell needs more than Rust on Windows — docs fixed

The README says the Tauri shell "needs a Rust toolchain". On Windows that is not
sufficient. rustup's default host is `x86_64-pc-windows-msvc`, which links with
Microsoft's linker, and installing rustup through `winget` skips the interactive
check that would otherwise warn about it.

With Rust installed and no C++ build tools, `npm run app:desktop` downloads 256
crates, compiles for a while, and then fails repeatedly with:

```
error: linking with `link.exe` failed: exit code: 1
  = note: link: extra operand '...rcgu.o'
          Try 'link --help' for more information.
```

That message is a red herring twice over. There is no `link.exe` on the machine
at all, so in Git Bash the GNU coreutils `link` on `PATH` is picked up instead —
and *its* usage error is what gets reported. Nothing in the output names the
actual cause. Confirmed absent: no `vswhere.exe`, no Visual Studio or Build
Tools installation.

The README now gives the `winget` line for the VCTools workload and explains the
misleading error. The build was still running when this was written; the desktop
checklist remains unrun either way.

## Still open

- Two desktop shell checks: layout against macOS (including scrollbars on each
  tool) and the dialogs from the desktop window. Both need eyes on the running
  app. The shell builds, opens, and survives the orphan test.
- F5 is settled as documented-only: no code change, the reveal still opens
  behind the browser by design.

## Noted, not acted on

Two performance observations from this run, deliberately left alone — neither is
Windows-specific, and both touch code whose change would oblige a full `ocr:gate`
re-run:

- `--jobs auto` is capped at `maxAutomaticJobs = 16`, so it uses half of a
  32-core machine. The ceiling's stated reason is memory, but each Tesseract
  worker measures ~23MB, so the cap is far more conservative than it needs to be.
- The SUP path's image extraction is single-threaded: `extractPgsPreviewImages`
  takes no `jobs` argument (the SUB/IDX path does) and writes every PNG in a
  sequential loop through `deflateSync`. Sampled over a minute of the gate run,
  the machine still averaged 79% CPU with Tesseract live in 90% of samples, so
  this is roughly 8% of wall time — visible as brief idle windows between
  tracks, not a dominant cost.
