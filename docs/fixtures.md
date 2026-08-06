# Local Fixtures

These files are not stored in the repo, but they are useful for local testing and
OCR calibration.

## the reference discs SUP Batch

Source folder:

```text
/path/to/samples
```

Current SUP files:

- `the reference discs- Season 1 Disc 1_t00.sup`
- `the reference discs- Season 1 Disc 1_t01.sup`
- `the reference discs- Season 1 Disc 1_t02.sup`
- `the reference discs- Season 1 Disc 2_t00.sup`
- `the reference discs- Season 1 Disc 2_t01.sup`
- `the reference discs- Season 1 Disc 2_t02.sup`
- `the reference discs- Season 1 Disc 3_t00.sup`
- `the reference discs- Season 1 Disc 3_t01.sup`
- `the reference discs- Season 1 Disc 3_t02.sup`

Reference batch output:

```text
/path/to/subpicture-batch-208.zip
```

The reference zip contains 9 `-eng.srt` files, one for each SUP file above.

Useful checks:

```bash
npm run cli -- peek-sup "/path/to/samples/the reference discs- Season 1 Disc 1_t00.sup" --out-dir /tmp/subtitle-workbench-peek
npm run cli -- sup-to-srt "/path/to/samples/the reference discs- Season 1 Disc 1_t00.sup" --lang eng --out /tmp/disc1-t00.srt
```
