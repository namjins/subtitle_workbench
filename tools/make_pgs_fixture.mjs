#!/usr/bin/env node
/**
 * Writes a tiny synthetic PGS (.sup) file.
 *
 * ffmpeg has no PGS encoder — only a demuxer — so a .sup fixture cannot be
 * generated from text with the usual tooling, and the real ones are derived
 * from commercial discs and far too large to commit. This builds one directly.
 *
 * Caveat worth keeping in mind: this encoder and lib/pgs-peek.mjs were written
 * by the same author, so a matching pair of bugs would cancel out and the test
 * would still pass. Fixtures produced by an independent tool are the check for
 * that; this one covers structure and regressions.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SEGMENT = { PDS: 0x14, ODS: 0x15, PCS: 0x16, WDS: 0x17, END: 0x80 };

function segment(type, payload, pts) {
  const header = Buffer.alloc(13);
  header.write("PG", 0, "ascii");
  header.writeUInt32BE(Math.round(pts * 90000), 2); // PTS at 90kHz
  header.writeUInt32BE(0, 6); // DTS
  header[10] = type;
  header.writeUInt16BE(payload.length, 11);
  return Buffer.concat([header, payload]);
}

function compositionSegment({ width, height, objects, paletteUpdate = false, cropped = false }) {
  // A cropped composition object entry is 16 bytes, not 8.
  const entrySize = cropped ? 16 : 8;
  const payload = Buffer.alloc(11 + objects.length * entrySize);
  payload.writeUInt16BE(width, 0);
  payload.writeUInt16BE(height, 2);
  payload[4] = 0x10; // frame rate marker, ignored by decoders
  payload.writeUInt16BE(0, 5); // composition number
  payload[7] = 0x80; // epoch start
  payload[8] = paletteUpdate ? 0x80 : 0x00;
  payload[9] = 0; // palette id
  payload[10] = objects.length;

  let offset = 11;
  for (const object of objects) {
    payload.writeUInt16BE(object.id, offset);
    payload[offset + 2] = 0; // window id
    payload[offset + 3] = cropped ? 0x40 : 0x00; // object_cropped_flag
    payload.writeUInt16BE(object.x, offset + 4);
    payload.writeUInt16BE(object.y, offset + 6);
    if (cropped) {
      // Crop rectangle covering the whole object.
      payload.writeUInt16BE(0, offset + 8);
      payload.writeUInt16BE(0, offset + 10);
      payload.writeUInt16BE(object.cropWidth ?? 240, offset + 12);
      payload.writeUInt16BE(object.cropHeight ?? 48, offset + 14);
    }
    offset += entrySize;
  }
  return payload;
}

function paletteSegment(entries) {
  const payload = Buffer.alloc(2 + entries.length * 5);
  payload[0] = 0; // palette id
  payload[1] = 0; // version
  let offset = 2;
  for (const entry of entries) {
    payload[offset] = entry.index;
    payload[offset + 1] = entry.y;
    payload[offset + 2] = entry.cr;
    payload[offset + 3] = entry.cb;
    payload[offset + 4] = entry.alpha;
    offset += 5;
  }
  return payload;
}

/** Run-length encodes one row at a time in the PGS scheme. */
function encodeRle(rows, width) {
  const bytes = [];
  for (const row of rows) {
    let x = 0;
    while (x < width) {
      const color = row[x];
      let run = 1;
      while (x + run < width && row[x + run] === color) run += 1;

      if (color === 0) {
        // Short transparent run is `00 L` with the top two bits of L clear.
        // Setting 0x40 selects the 14-bit form, which makes the decoder read a
        // second length byte and desynchronise the rest of the line.
        if (run <= 63) bytes.push(0x00, run);
        else bytes.push(0x00, 0x40 | ((run >> 8) & 0x3f), run & 0xff);
      } else if (run === 1) {
        bytes.push(color);
      } else if (run <= 63) {
        bytes.push(0x00, 0x80 | run, color);
      } else {
        bytes.push(0x00, 0xc0 | ((run >> 8) & 0x3f), run & 0xff, color);
      }
      x += run;
    }
    bytes.push(0x00, 0x00); // end of row
  }
  return Buffer.from(bytes);
}

function objectSegment(id, width, height, rle) {
  const payload = Buffer.alloc(11 + rle.length);
  payload.writeUInt16BE(id, 0);
  payload[2] = 0; // version
  payload[3] = 0xc0; // first and last in sequence
  payload.writeUIntBE(rle.length + 4, 4, 3); // data length including size fields
  payload.writeUInt16BE(width, 7);
  payload.writeUInt16BE(height, 9);
  rle.copy(payload, 11);
  return payload;
}

/** Draws blocky glyphs so the bitmap has recognisable structure. */
function drawBars(width, height, barCount) {
  const rows = Array.from({ length: height }, () => new Uint8Array(width));
  const barWidth = Math.max(2, Math.floor(width / (barCount * 2)));
  for (let bar = 0; bar < barCount; bar += 1) {
    const startX = bar * barWidth * 2 + 1;
    for (let y = 2; y < height - 2; y += 1) {
      for (let x = startX; x < Math.min(width - 1, startX + barWidth); x += 1) {
        rows[y][x] = 1;
      }
    }
  }
  return rows;
}

export function buildPgsFixture(
  cues,
  { canvasWidth = 1920, canvasHeight = 1080, cropped = false, paletteUpdate = false } = {},
) {
  const parts = [];
  const fullPalette = paletteSegment([
    { index: 0, y: 16, cr: 128, cb: 128, alpha: 0 }, // transparent background
    { index: 1, y: 235, cr: 128, cb: 128, alpha: 255 }, // opaque white text
  ]);
  // A partial update touching only index 0. Replacing the whole palette on
  // such a segment wiped index 1 and blanked the cue entirely.
  const partialPalette = paletteSegment([{ index: 0, y: 16, cr: 128, cb: 128, alpha: 0 }]);

  for (const cue of cues) {
    const width = cue.width ?? 240;
    const height = cue.height ?? 48;
    const rle = encodeRle(drawBars(width, height, cue.bars ?? 3), width);

    parts.push(
      segment(SEGMENT.PCS, compositionSegment({
        width: canvasWidth,
        height: canvasHeight,
        objects: [{ id: 0, x: cue.x ?? 100, y: cue.y ?? 900, cropWidth: width, cropHeight: height }],
        cropped,
        paletteUpdate,
      }), cue.start),
      segment(SEGMENT.WDS, Buffer.from([0]), cue.start),
      segment(SEGMENT.PDS, fullPalette, cue.start),
      segment(SEGMENT.ODS, objectSegment(0, width, height, rle), cue.start),
      ...(paletteUpdate
        ? [segment(SEGMENT.PDS, partialPalette, cue.start)]
        : []),
      segment(SEGMENT.END, Buffer.alloc(0), cue.start),
      // Clear display set: this is what gives the cue its end time.
      segment(SEGMENT.PCS, compositionSegment({
        width: canvasWidth,
        height: canvasHeight,
        objects: [],
      }), cue.end),
      segment(SEGMENT.END, Buffer.alloc(0), cue.end),
    );
  }

  return Buffer.concat(parts);
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("make_pgs_fixture.mjs");
if (isMain) {
  const output = process.argv[2];
  if (!output) {
    process.stderr.write("Usage: tools/make_pgs_fixture.mjs <out.sup>\n");
    process.exit(1);
  }
  const buffer = buildPgsFixture([
    { start: 1, end: 3, bars: 3 },
    { start: 4, end: 6.5, bars: 4 },
  ]);
  await writeFile(resolve(output), buffer);
  process.stderr.write(`Wrote ${buffer.length} bytes to ${output}\n`);
}
