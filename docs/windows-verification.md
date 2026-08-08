# Windows manual verification checklist

What CI cannot prove on Windows, to be run once on a real Windows machine
(and again before each release once distribution exists). CI covers the
conversion pipeline end to end on committed fixtures; this list is the
GUI-and-hardware remainder. Record results (pass/fail, numbers, oddities)
in the maintainer's working notes (not published with this repo).

Results of the first run, on Windows 11, are in
`windows-verification-results.md`. Every item below was run; eight findings,
seven fixed. The one left open by decision is the Explorer reveal opening
behind the browser.

Worth reading before re-running this list: the file picker only opens behind
the browser when the browser holds focus, so driving it from a terminal shows
it working, and the OCR gate needs Tesseract 5.5 or newer — 5.4 recognises
some frames as empty and drops those cues.

## Setup (fresh machine, following only the README)

- [ ] Follow the README's Windows install section exactly as written.
      Note anything a novice would stumble on — that feedback is the point.
- [ ] `subtitle-workbench doctor` reports everything OK after a terminal
      restart.

## Web UI (`subtitle-workbench ui`)

- [ ] Page opens; no dependency warning banner (all tools installed).
- [ ] Browse on SUP to SRT opens a native PowerShell file dialog,
      multi-select works, cancel does nothing.
- [ ] Browse on Extract from Video picks an MKV and fills the real path.
- [ ] Drag-and-drop of a SUP file into the drop zone works.
- [ ] A real SUP conversion completes; output lands next to the source as
      `name-eng.srt`.
- [ ] Converting the same file again is instant (cache) and says which app
      version produced the cached result.
- [ ] "Show SRT files" opens an Explorer window with the file selected.

## Desktop shell (needs Rust: https://rustup.rs)

- [ ] `npm run app:desktop` builds and opens the window at a sensible size
      for the monitor; no scrollbars on any tool.
- [ ] Layout matches macOS (columns, About rail, stepper).
- [ ] Kill the shell from Task Manager: no `node` bridge process survives
      (Details tab, search "node").
- [ ] Dialogs (Browse, reveal) work from the desktop window.

## OCR quality (needs the local media corpus)

- [ ] Copy the `Subtitle Examples` and `sub:idx examples` corpora over and
      run `npm run ocr:gate`. Record the numbers in the working notes next to
      the macOS baselines — the Windows Tesseract build differs and small
      CER drift is expected; large drift is a finding.

## Known-sharp edges to watch

- PATH: tools installed while a terminal is open are not visible until it
  restarts — doctor's install help says so, confirm it actually does.
- Paths with spaces and non-ASCII characters in file names.
- A very long path (>260 chars) source file, if easy to arrange.
