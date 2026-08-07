export type PgsPreview = {
  dataUrl: string;
  height: number;
  pts: number;
  width: number;
};

type PaletteEntry = {
  alpha: number;
  rgb: [number, number, number];
};

type Composition = {
  height: number;
  objects: Array<{ objectId: number; x: number; y: number }>;
  paletteUpdateFlag: boolean;
  width: number;
};

type ObjectPart = {
  chunks: Uint8Array[];
  complete?: boolean;
  height: number;
  width: number;
};

const segment = {
  pds: 0x14,
  ods: 0x15,
  pcs: 0x16,
  end: 0x80,
} as const;

function readUint16(data: Uint8Array, offset: number) {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data: Uint8Array, offset: number) {
  return (
    data[offset] * 0x1000000 +
    ((data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3])
  );
}

function clamp(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function yCrCbToRgb(y: number, cr: number, cb: number, alpha: number) {
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
    ] as [number, number, number],
  };
}

// Mirrors lib/pgs-peek.mjs: a PDS may revise only the entries it carries, so
// replacing the whole map wiped every untouched colour.
function parsePalette(
  payload: Uint8Array,
  existing: Map<number, PaletteEntry> | null = null,
) {
  const entries = new Map<number, PaletteEntry>(existing ?? []);
  for (let offset = 2; offset + 4 < payload.length; offset += 5) {
    entries.set(
      payload[offset],
      yCrCbToRgb(
        payload[offset + 1],
        payload[offset + 2],
        payload[offset + 3],
        payload[offset + 4],
      ),
    );
  }
  return entries;
}

function parseComposition(payload: Uint8Array): Composition | null {
  if (payload.length < 11) return null;
  const objects = [];
  let offset = 11;
  for (let index = 0; index < payload[10] && offset + 7 < payload.length; index += 1) {
    // A cropped composition object entry is 16 bytes, not 8.
    const croppedFlag = Boolean(payload[offset + 3] & 0x40);
    objects.push({
      objectId: readUint16(payload, offset),
      x: readUint16(payload, offset + 4),
      y: readUint16(payload, offset + 6),
    });
    offset += croppedFlag ? 16 : 8;
  }
  return {
    width: readUint16(payload, 0),
    height: readUint16(payload, 2),
    objects,
    paletteUpdateFlag: Boolean(payload[8] & 0x80),
  };
}

function parseObjectSegment(
  payload: Uint8Array,
  objectParts: Map<number, ObjectPart>,
) {
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
  part.chunks.push(payload.slice(offset));
  part.complete = isLast;
  objectParts.set(objectId, part);
}

function concatChunks(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function decodeRle(data: Uint8Array, width: number, height: number) {
  const pixels = new Uint8Array(width * height);
  let source = 0;
  let x = 0;
  let y = 0;

  function drawRun(length: number, color: number) {
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

function boundsFor(
  object: ObjectPart,
  pixels: Uint8Array,
  palette: Map<number, PaletteEntry>,
) {
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

function renderDisplay(
  display: Composition | null,
  palette: Map<number, PaletteEntry>,
  objectParts: Map<number, ObjectPart>,
  pts: number,
) {
  if (!display || !palette.size) return null;
  const rendered = [];
  for (const ref of display.objects) {
    const object = objectParts.get(ref.objectId);
    if (!object?.complete || !object.width || !object.height) continue;
    const pixels = decodeRle(concatChunks(object.chunks), object.width, object.height);
    const bounds = boundsFor(object, pixels, palette);
    if (bounds) rendered.push({ ref, object, pixels, bounds });
  }
  if (!rendered.length) return null;

  const minX = Math.min(...rendered.map((item) => item.ref.x + item.bounds.minX));
  const minY = Math.min(...rendered.map((item) => item.ref.y + item.bounds.minY));
  const maxX = Math.max(...rendered.map((item) => item.ref.x + item.bounds.maxX));
  const maxY = Math.max(...rendered.map((item) => item.ref.y + item.bounds.maxY));
  const padding = 24;
  const width = maxX - minX + 1 + padding * 2;
  const height = maxY - minY + 1 + padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  image.data.fill(255);
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;

  // Must match lib/pgs-peek.mjs exactly: skip palette index 0 and write the
  // real palette colour. This previously tested alpha and painted every
  // visible pixel pure black, so the operator reviewed a hard-edged silhouette
  // while OCR received an anti-aliased, coloured image — the preview could not
  // show why a cue read badly.
  for (const item of rendered) {
    const { ref, object, pixels, bounds } = item;
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const colorIndex = pixels[y * object.width + x];
        if (colorIndex === 0) continue;
        const color = palette.get(colorIndex);
        if (!color) continue;
        const targetX = ref.x + x - minX + padding;
        const targetY = ref.y + y - minY + padding;
        const target = (targetY * width + targetX) * 4;
        image.data[target] = color.rgb[0];
        image.data[target + 1] = color.rgb[1];
        image.data[target + 2] = color.rgb[2];
      }
    }
  }

  context.putImageData(image, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), width, height, pts };
}

export function extractPgsPreviewsFromBuffer(buffer: ArrayBuffer, count = 3) {
  const data = new Uint8Array(buffer);
  let offset = 0;
  let display: Composition | null = null;
  let palette = new Map<number, PaletteEntry>();
  let objectParts = new Map<number, ObjectPart>();
  const outputs: PgsPreview[] = [];

  while (offset + 13 <= data.length && outputs.length < count) {
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
    const payload = data.slice(payloadStart, payloadEnd);

    if (type === segment.pcs) {
      display = parseComposition(payload);
      if (display?.objects.length) objectParts = new Map();
    } else if (type === segment.pds) {
      palette = parsePalette(payload, display?.paletteUpdateFlag ? palette : null);
    } else if (type === segment.ods) {
      parseObjectSegment(payload, objectParts);
    } else if (type === segment.end) {
      const rendered = renderDisplay(display, palette, objectParts, pts);
      if (rendered && rendered.width > 20 && rendered.height > 12) {
        outputs.push(rendered);
      }
    }
    offset = payloadEnd;
  }

  return outputs;
}
