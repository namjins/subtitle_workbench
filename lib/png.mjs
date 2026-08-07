import { deflateSync } from "node:zlib";

/**
 * Minimal truecolour PNG encoder.
 *
 * The PGS decoder used to write a PPM and then spawn ImageMagick once per cue
 * to convert it. That was a process spawn per subtitle image — hundreds per
 * file — run synchronously inside the decode loop, so the whole decode phase
 * was pinned to a single core no matter what --jobs was set to. Encoding in
 * process removes the spawn entirely and lets the decode run at full speed.
 */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * @param {{width: number, height: number, rgb: Buffer}} image
 *   `rgb` is tightly packed 8-bit RGB, `width * height * 3` bytes.
 */
export function encodePng({ width, height, rgb }) {
  if (rgb.length < width * height * 3) {
    throw new Error(
      `PNG encode expected ${width * height * 3} bytes of RGB, received ${rgb.length}`,
    );
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte per scanline. Filter 0 (None) keeps the encoder simple and
  // still compresses well here: subtitle bitmaps are mostly flat colour.
  //
  // `set` rather than `Buffer.copy`, because the shared decoder returns a plain
  // Uint8Array so the same code can run in a browser bundle.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
