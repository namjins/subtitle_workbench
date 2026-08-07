# Subtitle Workbench

Convert image-based and timed-text subtitles to SRT, locally. Nothing is
uploaded anywhere — the OCR, the decoding and the file writing all happen on
your machine.

| Tool | Input | What it does |
| --- | --- | --- |
| **SUP to SRT** | `.sup` | OCR for Blu-ray PGS subtitle tracks |
| **SUB/IDX to SRT** | `.sub` + `.idx` | OCR for DVD VobSub subtitle pairs |
| **Extract from Video** | `.mkv` | Pull embedded subtitle tracks out of a video |

Use it as a desktop-style app in your browser, or as a CLI for batch and
automation work.

## Install

Subtitle Workbench runs on your own computer and is built on a few
well-known free tools. Installing means three steps: get Node.js, get the
media tools, then get Subtitle Workbench itself. Every command below is
typed into a terminal — **Terminal** on macOS (find it with Spotlight),
**PowerShell** on Windows (right-click Start → Terminal), or your usual
shell on Linux. Copy a line, paste it, press Enter, let it finish.

### Step 1 — Node.js (the runtime this app is written for)

Install Node.js **22.13 or newer**. Node is maintained by its own project
and updates through the same channel you install it from — Subtitle
Workbench deliberately does not bundle its own copy, so security updates
to Node reach you the normal way.

- **macOS**: `brew install node` (or the installer from
  [nodejs.org](https://nodejs.org) — choose "LTS")
- **Windows**: `winget install OpenJS.NodeJS.LTS` (or the nodejs.org
  installer)
- **Debian/Ubuntu**: `sudo apt install nodejs npm`

Check it worked — this should print a version number, v22 or higher:

```bash
node --version
```

### Step 2 — the media tools

These do the heavy lifting (video reading, image work, text recognition).

**Install Tesseract 5.5 or newer.** 5.4 recognises some low-contrast,
drop-shadowed subtitle frames as empty, and an empty result drops the cue
entirely — so the failure is a missing subtitle rather than a visibly wrong
one. `doctor` warns if it finds an older build.

- **macOS**:

  ```bash
  brew install ffmpeg tesseract imagemagick mkvtoolnix
  ```

- **Debian / Ubuntu** (`zenity` powers the file-picker dialog; most
  desktops already have it):

  ```bash
  sudo apt install ffmpeg tesseract-ocr imagemagick mkvtoolnix zenity
  ```

- **Windows**:

  ```powershell
  winget install Gyan.FFmpeg tesseract-ocr.tesseract ImageMagick.ImageMagick MoritzBunkus.MKVToolNix
  ```

  **Windows only:** close the terminal completely and open a new one
  afterwards — newly installed tools are not visible to a terminal that
  was already open.

  **Windows only:** Tesseract and MKVToolNix's installers do not add
  themselves to your `PATH`, even after a restart (FFmpeg and ImageMagick's
  installers do). If `doctor` still reports `tesseract` or `mkvmerge` as
  missing after a fresh terminal, add these two folders to your `PATH`
  yourself: open **Settings → System → About → Advanced system settings →
  Environment Variables**, edit your user `Path` variable, and add
  `C:\Program Files\Tesseract-OCR` and `C:\Program Files\MKVToolNix`. Then
  open a new terminal again.

  **Windows only:** the widely-recommended `UB-Mannheim.TesseractOCR`
  package is *not* what to install here — it stops at 5.4.0, which is below
  the version floor above. `tesseract-ocr.tesseract` is the upstream
  project's own package and tracks 5.5.

### Step 3 — Subtitle Workbench

Once this package is published (until then, use "From source" below):

```bash
npm install -g subtitle-workbench
```

### Step 4 — check everything

```bash
subtitle-workbench doctor
```

`doctor` inspects every tool, prints the version it found, and — if
anything is missing — the exact install command for your platform. When it
ends with "All required dependencies are available", you are done:

```bash
subtitle-workbench ui
```

opens the app in your browser. The app also runs this same check on
startup and shows a warning with instructions if something is missing —
when everything is in place you see nothing.

### From source (developers, or before the npm release)

```bash
git clone https://github.com/namjins/subtitle_workbench.git
cd subtitle_workbench
npm install
npm run doctor
npm run app
```

## Run the app

```bash
npm run app
```

That builds the interface and serves it at `http://127.0.0.1:8765`. Each tool
follows the same three steps: **Intake** (add files), **Review** (check them and
choose a language), **Run**.

The page is served by a small local server that does the actual work. It only
accepts requests from the page it served itself, so no other site you have open
can reach it.

## Use the CLI

```bash
npm run cli -- --help
```

**Blu-ray PGS subtitles**

```bash
npm run cli -- sup-to-srt movie.sup --lang eng
npm run cli -- sup-to-srt *.sup --lang eng --out-dir ./srt
```

**DVD VobSub subtitles** — pass the `.idx`; the matching `.sub` must sit beside it.

```bash
npm run cli -- subidx-to-srt movie.idx --lang eng
```

**Extract subtitles from video files**

```bash
npm run cli -- extract-english /path/to/videos
npm run cli -- extract-english /path/to/videos --languages eng,spa
npm run cli -- extract-english /path/to/videos --all-languages
```

Scans the top level of a folder for `.mkv` files, writing `.sub`+`.idx` for DVD
VobSub tracks and `.sup` for Blu-ray PGS. Existing outputs are skipped.

**Preview before a long run**

```bash
npm run cli -- peek-sup movie.sup --out-dir ./preview --count 3
```

Writes a few subtitle images so you can confirm the language before OCR'ing a
whole disc.

### Common options

| Option | Meaning |
| --- | --- |
| `--out FILE` / `--out-dir DIR` | Where to write. Defaults to beside the input, named `movie-eng.srt` (the language is part of the name so tracks in different languages do not overwrite each other). |
| `--jobs auto` \| `N` | Parallelism. `auto` reserves one core for the rest of your machine. |
| `--lang eng` | OCR language. Needs matching Tesseract language data installed. |
| `--ocr-engine auto` | See below. |
| `--skip-existing` | Leave already-converted files alone. |
| `--no-cache` | Reconvert even when a cached result exists (see below). |
| `--quiet` | Suppress per-cue progress. |

Finished OCR conversions are cached by the *content* of the source file, so
converting the same disc again — under any filename, to any destination — is
instant. Each reuse says which app version produced the cached result; if
that version is older than the one you are running, pass `--no-cache` to
reconvert, which replaces the cached copy. Only the latest result is kept.

## OCR engines

`auto` chooses per format and, for Blu-ray tracks, per disc — because no
single engine wins everywhere:

| Format | Engine |
| --- | --- |
| SUP (PGS), macOS | probes each track, picks Tesseract or Apple Vision |
| SUP (PGS), elsewhere | Tesseract |
| SUB/IDX (VobSub), macOS | Apple Vision |
| SUB/IDX (VobSub), elsewhere | Tesseract |

Preprocessing adapts to each disc's rendering style per image — drop
shadows, low-contrast fills, and hollow outline-drawn glyphs are detected
and repaired before recognition — so Tesseract results are close to Apple
Vision's on every tested disc style. On macOS the Blu-ray converter
additionally reads a couple dozen frames with both engines first and keeps
whichever handles that disc better, which makes Vision the safety net for
styles the repairs cannot fix; Windows and Linux have no such net, and rare
hollow-outline DVD fonts still convert worse there.

Override with `--ocr-engine tesseract-accurate`, `tesseract-hybrid` (faster,
less accurate) or `macos-vision`.

### Bringing your own recogniser

`--ocr-engine external-command` hands each subtitle image to a program you
supply:

```bash
npm run cli -- subidx-to-srt movie.idx \
  --ocr-engine external-command \
  --ocr-command /path/to/your-ocr
```

It is invoked as `your-ocr /path/to/image.png eng` and may print plain text, or
JSON for richer results:

```json
{ "text": "Hello", "confidence": 0.98, "model": "your-model" }
```

## Languages

English is what this has been validated against. Other languages work when the
matching Tesseract language data is installed — `npm run cli -- doctor --lang deu`
will tell you whether it is. Apple Vision supports its own set and warns when a
requested language is not among them.

## Checking output quality

With reference SRT files, `benchmark-ocr` compares by timestamp, cue count,
exact text and character error rate:

```bash
npm run cli -- benchmark-ocr --reference reference.srt --candidate generated.srt
npm run cli -- benchmark-ocr --examples-dir ./references --candidate-dir ./output
```

Add `--timing-first` when the reference text is imperfect but its timings are
trustworthy — it foregrounds missing, extra and shifted cues over text accuracy.

## Development

```bash
npm test          # unit and end-to-end; no build or network required
npm run lint
npm run typecheck
npm run build
npm run dev       # UI dev server; run `npm run cli -- ui --dev` alongside it
```

Tests run against small fixtures in `tests/fixtures/`.

### Desktop app (work in progress)

`src-tauri/` holds a Tauri shell around the same UI: it starts the local
bridge on a private port and opens a native window on it, so the bridge's
job queue, authorization and native file picking are shared with the web
version. It needs a [Rust toolchain](https://rustup.rs):

```bash
npm run app:desktop   # tauri dev: builds the UI, compiles the shell, opens the window
```

**Windows only:** Rust alone is not enough. The default toolchain is
`x86_64-pc-windows-msvc`, which links with Microsoft's linker, so you also
need the **C++ build tools**:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Installing rustup via `winget` skips the interactive check that would
otherwise warn you about this. Without the build tools the compile fails
partway through with a misleading error — in Git Bash, coreutils' `link`
gets picked up in place of the absent `link.exe` and reports
`link: extra operand`, which has nothing to do with the real cause.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE) — free to use, modify, and share for
any noncommercial purpose: personal use, hobby projects, research, education,
charities, public institutions. What it does not allow is commercial use —
selling this software, charging for it, or building a paid product or service
on it. If you want a commercial licence, open an issue.
