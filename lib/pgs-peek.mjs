import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "./png.mjs";

const SEGMENT = {
  PDS: 0x14,
  ODS: 0x15,
  PCS: 0x16,
  END: 0x80,
};

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function yCrCbToRgb(y, cr, cb, alpha) {
  const r = y + 1.402 * (cr - 128);
  const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
  const b = y + 1.772 * (cb - 128);
  const opacity = alpha / 255;
  return {
    alpha,
    rgb: [
      clamp(r * opacity + 255 * (1 - opacity)),
      clamp(g * opacity + 255 * (1 - opacity)),
      clamp(b * opacity + 255 * (1 - opacity)),
    ],
  };
}

/**
 * A PDS may revise only the entries it carries. Replacing the whole map on
 * every PDS wiped every untouched entry, which rendered the cue almost fully
 * transparent and then dropped it.
 */
function parsePalette(payload, existing = null) {
  const entries = existing ? new Map(existing) : new Map();
  for (let offset = 2; offset + 4 < payload.length; offset += 5) {
    const index = payload[offset];
    const y = payload[offset + 1];
    const cr = payload[offset + 2];
    const cb = payload[offset + 3];
    const alpha = payload[offset + 4];
    entries.set(index, yCrCbToRgb(y, cr, cb, alpha));
  }
  return entries;
}

function parseComposition(payload) {
  if (payload.length < 11) return null;
  const width = payload.readUInt16BE(0);
  const height = payload.readUInt16BE(2);
  // paletteUpdateFlag says the following PDS only revises entries rather than
  // replacing the palette wholesale.
  const paletteUpdateFlag = Boolean(payload[8] & 0x80);
  const paletteId = payload[9];
  const objectCount = payload[10];
  const objects = [];
  let offset = 11;

  for (let index = 0; index < objectCount && offset + 7 < payload.length; index += 1) {
    const objectId = payload.readUInt16BE(offset);
    const croppedFlag = Boolean(payload[offset + 3] & 0x40);
    const x = payload.readUInt16BE(offset + 4);
    const y = payload.readUInt16BE(offset + 6);
    objects.push({ objectId, x, y });
    // A cropped composition object carries four extra 16-bit crop fields, so
    // its entry is 16 bytes rather than 8. Assuming 8 desynchronised every
    // later object in the same composition, producing garbage ids and
    // positions.
    offset += croppedFlag ? 16 : 8;
  }

  return { width, height, objects, paletteUpdateFlag, paletteId };
}

function parseObjectSegment(payload, objectParts) {
  if (payload.length < 4) return;
  const objectId = payload.readUInt16BE(0);
  const sequence = payload[3];
  const isFirst = Boolean(sequence & 0x80);
  const isLast = Boolean(sequence & 0x40);
  let offset = 4;
  let width = objectParts.get(objectId)?.width ?? 0;
  let height = objectParts.get(objectId)?.height ?? 0;

  if (isFirst) {
    if (payload.length < 11) return;
    width = payload.readUInt16BE(7);
    height = payload.readUInt16BE(9);
    offset = 11;
    objectParts.set(objectId, { width, height, chunks: [] });
  }

  const part = objectParts.get(objectId) ?? { width, height, chunks: [] };
  part.width = width;
  part.height = height;
  part.chunks.push(payload.subarray(offset));
  part.complete = isLast;
  objectParts.set(objectId, part);
}

function decodeRle(data, width, height) {
  const pixels = new Uint8Array(width * height);
  let source = 0;
  let x = 0;
  let y = 0;

  function drawRun(length, color) {
    for (let index = 0; index < length && y < height; index += 1) {
      if (x >= width) {
        x = 0;
        y += 1;
      }
      if (y < height) {
        pixels[y * width + x] = color;
        x += 1;
      }
    }
  }

  while (source < data.length && y < height) {
    const value = data[source++];
    if (value !== 0) {
      drawRun(1, value);
      continue;
    }

    const command = data[source++];
    if (command === undefined) break;
    if (command === 0) {
      x = 0;
      y += 1;
    } else if ((command & 0xc0) === 0x40) {
      const length = ((command & 0x3f) << 8) + data[source++];
      drawRun(length, 0);
    } else if ((command & 0xc0) === 0x80) {
      const length = command & 0x3f;
      const color = data[source++];
      drawRun(length, color);
    } else if ((command & 0xc0) === 0xc0) {
      const length = ((command & 0x3f) << 8) + data[source++];
      const color = data[source++];
      drawRun(length, color);
    } else {
      drawRun(command & 0x3f, 0);
    }
  }

  return pixels;
}

function objectBounds(object, pixels, palette) {
  let minX = object.width;
  let minY = object.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < object.height; y += 1) {
    for (let x = 0; x < object.width; x += 1) {
      const entry = palette.get(pixels[y * object.width + x]);
      if (entry && entry.alpha > 8) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function renderDisplay(display, palette, objectParts) {
  if (!display || !palette?.size) return null;
  const renderedObjects = [];

  for (const ref of display.objects) {
    const object = objectParts.get(ref.objectId);
    if (!object?.complete || !object.width || !object.height) continue;
    const rle = Buffer.concat(object.chunks);
    const pixels = decodeRle(rle, object.width, object.height);
    const bounds = objectBounds(object, pixels, palette);
    if (!bounds) continue;
    renderedObjects.push({ ref, object, pixels, bounds });
  }

  if (!renderedObjects.length) return null;

  const minX = Math.min(...renderedObjects.map((item) => item.ref.x + item.bounds.minX));
  const minY = Math.min(...renderedObjects.map((item) => item.ref.y + item.bounds.minY));
  const maxX = Math.max(...renderedObjects.map((item) => item.ref.x + item.bounds.maxX));
  const maxY = Math.max(...renderedObjects.map((item) => item.ref.y + item.bounds.maxY));
  const padding = 24;
  // Content size before padding. The caller's "is this big enough to be real?"
  // check compared the padded size, which is always at least 49x49, so it
  // could never reject anything.
  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const width = contentWidth + padding * 2;
  const height = contentHeight + padding * 2;
  const rgb = Buffer.alloc(width * height * 3, 255);

  for (const item of renderedObjects) {
    const { ref, object, pixels, bounds } = item;
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const colorIndex = pixels[y * object.width + x];
        if (colorIndex === 0) continue;
        const color = palette.get(colorIndex);
        if (!color) continue;
        const targetX = ref.x + x - minX + padding;
        const targetY = ref.y + y - minY + padding;
        const target = (targetY * width + targetX) * 3;
        rgb[target] = color.rgb[0];
        rgb[target + 1] = color.rgb[1];
        rgb[target + 2] = color.rgb[2];
      }
    }
  }

  return { width, height, rgb, contentWidth, contentHeight };
}

async function writePng(image, outputPath) {
  // Encoded in process. This used to write a PPM and spawn ImageMagick to
  // convert it, once per cue, synchronously — so decoding a 668-cue track meant
  // 668 blocking process spawns on a single core before OCR could start.
  await writeFile(outputPath, encodePng(image));
}

export async function extractPgsPreviewImages(inputPath, outputDirectory, count = 3) {
  const buffer = await readFile(inputPath);
  await mkdir(outputDirectory, { recursive: true });

  let offset = 0;
  let display = null;
  let palette = new Map();
  let objectParts = new Map();
  const outputs = [];

  while (offset + 13 <= buffer.length && outputs.length < count) {
    if (buffer[offset] !== 0x50 || buffer[offset + 1] !== 0x47) {
      offset += 1;
      continue;
    }

    const pts = buffer.readUInt32BE(offset + 2) / 90000;
    const type = buffer[offset + 10];
    const length = buffer.readUInt16BE(offset + 11);
    const payloadStart = offset + 13;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) break;
    const payload = buffer.subarray(payloadStart, payloadEnd);

    if (type === SEGMENT.PCS) {
      display = parseComposition(payload);
      // Only a composition that actually references objects starts a new
      // epoch. Clearing on every PCS discarded objects that a continuation
      // composition legitimately re-references.
      if (display?.objects.length) objectParts = new Map();
    } else if (type === SEGMENT.PDS) {
      palette = parsePalette(payload, display?.paletteUpdateFlag ? palette : null);
    } else if (type === SEGMENT.ODS) {
      parseObjectSegment(payload, objectParts);
    } else if (type === SEGMENT.END) {
      const image = renderDisplay(display, palette, objectParts);
      // Reject specks on the real content size, not the padded size.
      const usable = image && image.contentWidth > 8 && image.contentHeight > 6;
      if (usable) {
        // Every cue's end time is the next display set's timestamp, whether
        // that is a clear or the following cue. Only the last output used to
        // get an end time, and a content display set that failed to render was
        // misread as a clear marker.
        const previous = outputs[outputs.length - 1];
        if (previous && !previous.endPts && pts > previous.pts) previous.endPts = pts;

        const outputPath = join(
          outputDirectory,
          `preview-${String(outputs.length + 1).padStart(6, "0")}.png`,
        );
        await writePng(image, outputPath);
        outputs.push({ path: outputPath, pts, width: image.width, height: image.height });
      } else if (outputs.length) {
        const last = outputs[outputs.length - 1];
        if (!last.endPts && pts > last.pts) {
          last.endPts = pts;
        }
      }
    }

    offset = payloadEnd;
  }

  return outputs;
}

function secondsForFilename(seconds) {
  return String(Math.round(seconds * 1000)).padStart(10, "0");
}

function nearestUnmatchedTarget(targets, pts, toleranceSeconds) {
  let nearest = null;
  for (const target of targets) {
    if (target.matched) continue;
    const delta = Math.abs(target.start - pts);
    if (delta > toleranceSeconds) continue;
    if (!nearest || delta < nearest.delta) {
      nearest = { target, delta };
    }
  }
  return nearest;
}

export async function extractPgsImagesAtTimes(
  inputPath,
  outputDirectory,
  starts,
  options = {},
) {
  const toleranceSeconds = options.toleranceSeconds ?? 0.08;
  const targets = starts.map((start, index) => ({
    index,
    start,
    matched: null,
  }));

  const buffer = await readFile(inputPath);
  await mkdir(outputDirectory, { recursive: true });

  let offset = 0;
  let display = null;
  let palette = new Map();
  let objectParts = new Map();
  const outputs = [];

  while (offset + 13 <= buffer.length && targets.some((target) => !target.matched)) {
    if (buffer[offset] !== 0x50 || buffer[offset + 1] !== 0x47) {
      offset += 1;
      continue;
    }

    const pts = buffer.readUInt32BE(offset + 2) / 90000;
    const type = buffer[offset + 10];
    const length = buffer.readUInt16BE(offset + 11);
    const payloadStart = offset + 13;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) break;
    const payload = buffer.subarray(payloadStart, payloadEnd);

    if (type === SEGMENT.PCS) {
      display = parseComposition(payload);
      if (display?.objects.length) objectParts = new Map();
    } else if (type === SEGMENT.PDS) {
      palette = parsePalette(payload, display?.paletteUpdateFlag ? palette : null);
    } else if (type === SEGMENT.ODS) {
      parseObjectSegment(payload, objectParts);
    } else if (type === SEGMENT.END) {
      const image = renderDisplay(display, palette, objectParts);
      const match = nearestUnmatchedTarget(targets, pts, toleranceSeconds);
      if (image && match) {
        const outputPath = join(
          outputDirectory,
          `cue-${String(match.target.index + 1).padStart(4, "0")}-${secondsForFilename(match.target.start)}.png`,
        );
        await writePng(image, outputPath);
        match.target.matched = {
          path: outputPath,
          pts,
          delta: match.delta,
          width: image.width,
          height: image.height,
        };
        outputs.push({
          requestedStart: match.target.start,
          ...match.target.matched,
        });
      }
    }

    offset = payloadEnd;
  }

  return {
    images: outputs,
    unmatched: targets
      .filter((target) => !target.matched)
      .map((target) => ({ index: target.index, requestedStart: target.start })),
  };
}
