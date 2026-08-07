/**
 * PGS (Blu-ray Presentation Graphic Stream) decoding, shared by the Node CLI
 * and the browser preview.
 *
 * This logic previously existed twice — once in lib/pgs-peek.mjs and once in
 * app/pgsPreview.ts — and the copies had already drifted apart: the browser
 * painted every visible pixel black while the CLI wrote the real palette
 * colour, so the operator reviewed a different image from the one OCR read.
 * Keeping one implementation is the only thing that stops that recurring.
 *
 * Everything here works on plain Uint8Array and returns raw RGB, so it runs
 * unchanged in Node and in a browser bundle. Sinks differ: Node encodes PNG,
 * the browser paints to a canvas.
 */

export const SEGMENT = {
  PDS: 0x14,
  ODS: 0x15,
  PCS: 0x16,
  WDS: 0x17,
  END: 0x80,
};

function readUint16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data, offset) {
  return (
    data[offset] * 0x1000000 +
    ((data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3])
  );
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Composites onto white, which is what the OCR preprocessing expects. */
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
 * A PDS may revise only the entries it carries, so an update must merge rather
 * than replace. Replacing wiped every untouched colour and left the cue almost
 * fully transparent, which then dropped it.
 */
export function parsePalette(payload, existing = null) {
  const entries = existing ? new Map(existing) : new Map();
  for (let offset = 2; offset + 4 < payload.length; offset += 5) {
    entries.set(
      payload[offset],
      yCrCbToRgb(payload[offset + 1], payload[offset + 2], payload[offset + 3], payload[offset + 4]),
    );
  }
  return entries;
}

export function parseComposition(payload) {
  if (payload.length < 11) return null;
  const objects = [];
  let offset = 11;

  for (let index = 0; index < payload[10] && offset + 7 < payload.length; index += 1) {
    // A cropped composition object entry is 16 bytes, not 8. Assuming 8
    // desynchronised every later object in the same composition.
    const cropped = Boolean(payload[offset + 3] & 0x40);
    objects.push({
      objectId: readUint16(payload, offset),
      x: readUint16(payload, offset + 4),
      y: readUint16(payload, offset + 6),
    });
    offset += cropped ? 16 : 8;
  }

  return {
    width: readUint16(payload, 0),
    height: readUint16(payload, 2),
    objects,
    paletteUpdateFlag: Boolean(payload[8] & 0x80),
    paletteId: payload[9],
  };
}

export function parseObjectSegment(payload, objectParts) {
  if (payload.length < 4) return;
  const objectId = readUint16(payload, 0);
  const sequence = payload[3];
  const isFirst = Boolean(sequence & 0x80);
  const isLast = Boolean(sequence & 0x40);
  let offset = 4;
  let width = objectParts.get(objectId)?.width ?? 0;
  let height = objectParts.get(objectId)?.height ?? 0;

  if (isFirst) {
    if (payload.length < 11) return;
    width = readUint16(payload, 7);
    height = readUint16(payload, 9);
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

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function decodeRle(data, width, height) {
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
      drawRun(((command & 0x3f) << 8) + data[source++], 0);
    } else if ((command & 0xc0) === 0x80) {
      drawRun(command & 0x3f, data[source++]);
    } else if ((command & 0xc0) === 0xc0) {
      drawRun(((command & 0x3f) << 8) + data[source++], data[source++]);
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

export const RENDER_PADDING = 24;

/**
 * Composites a display set into RGB. Returns null when nothing is visible.
 *
 * `contentWidth`/`contentHeight` are the size before padding, so callers can
 * reject specks meaningfully — testing the padded size never rejected anything,
 * because padding alone guarantees at least 49x49.
 */
export function renderDisplay(display, palette, objectParts) {
  if (!display || !palette?.size) return null;
  const rendered = [];

  for (const ref of display.objects) {
    const object = objectParts.get(ref.objectId);
    if (!object?.complete || !object.width || !object.height) continue;
    const pixels = decodeRle(concatChunks(object.chunks), object.width, object.height);
    const bounds = objectBounds(object, pixels, palette);
    if (bounds) rendered.push({ ref, object, pixels, bounds });
  }
  if (!rendered.length) return null;

  const minX = Math.min(...rendered.map((item) => item.ref.x + item.bounds.minX));
  const minY = Math.min(...rendered.map((item) => item.ref.y + item.bounds.minY));
  const maxX = Math.max(...rendered.map((item) => item.ref.x + item.bounds.maxX));
  const maxY = Math.max(...rendered.map((item) => item.ref.y + item.bounds.maxY));

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const width = contentWidth + RENDER_PADDING * 2;
  const height = contentHeight + RENDER_PADDING * 2;
  const rgb = new Uint8Array(width * height * 3).fill(255);

  for (const item of rendered) {
    const { ref, object, pixels, bounds } = item;
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        // Skip palette index 0 and write the real colour. The browser copy used
        // to test alpha and paint pure black, so previews were hard-edged
        // silhouettes while OCR received an anti-aliased coloured image.
        const colorIndex = pixels[y * object.width + x];
        if (colorIndex === 0) continue;
        const color = palette.get(colorIndex);
        if (!color) continue;
        const target =
          ((ref.y + y - minY + RENDER_PADDING) * width +
            (ref.x + x - minX + RENDER_PADDING)) *
          3;
        rgb[target] = color.rgb[0];
        rgb[target + 1] = color.rgb[1];
        rgb[target + 2] = color.rgb[2];
      }
    }
  }

  return { width, height, rgb, contentWidth, contentHeight };
}

/**
 * Walks display sets in order, invoking `onDisplaySet` for each END segment
 * with the rendered image (or null) and its presentation timestamp.
 */
export function scanDisplaySets(data, onDisplaySet) {
  let offset = 0;
  let display = null;
  let palette = new Map();
  let objectParts = new Map();

  while (offset + 13 <= data.length) {
    if (data[offset] !== 0x50 || data[offset + 1] !== 0x47) {
      offset += 1;
      continue;
    }

    const pts = readUint32(data, offset + 2) / 90000;
    const type = data[offset + 10];
    const length = readUint16(data, offset + 11);
    const payloadStart = offset + 13;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > data.length) break;
    const payload = data.subarray(payloadStart, payloadEnd);

    if (type === SEGMENT.PCS) {
      display = parseComposition(payload);
      // Only a composition that references objects starts a new epoch; clearing
      // on every PCS discarded objects a continuation composition re-uses.
      if (display?.objects.length) objectParts = new Map();
    } else if (type === SEGMENT.PDS) {
      palette = parsePalette(payload, display?.paletteUpdateFlag ? palette : null);
    } else if (type === SEGMENT.ODS) {
      parseObjectSegment(payload, objectParts);
    } else if (type === SEGMENT.END) {
      if (onDisplaySet(renderDisplay(display, palette, objectParts), pts) === false) {
        return;
      }
    }

    offset = payloadEnd;
  }
}

/** True when the image is large enough to be real content rather than a speck. */
export function isUsableImage(image) {
  return Boolean(image && image.contentWidth > 8 && image.contentHeight > 6);
}
