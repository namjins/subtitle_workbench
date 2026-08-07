import { isUsableImage, scanDisplaySets } from "../lib/pgs-decoder.mjs";

export type PgsPreview = {
  dataUrl: string;
  height: number;
  pts: number;
  width: number;
};

type DecodedImage = {
  width: number;
  height: number;
  rgb: Uint8Array;
  contentWidth: number;
  contentHeight: number;
};

/**
 * Browser-side PGS preview.
 *
 * All decoding comes from lib/pgs-decoder.mjs, the same module the CLI uses.
 * This file previously carried its own copy, which had drifted: it painted
 * every visible pixel black while the CLI wrote real palette colours, so the
 * preview showed a hard-edged silhouette rather than the anti-aliased image OCR
 * actually reads. Only the sink differs now — canvas here, PNG there.
 */
function toDataUrl(image: DecodedImage): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const output = context.createImageData(image.width, image.height);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    output.data[pixel * 4] = image.rgb[pixel * 3];
    output.data[pixel * 4 + 1] = image.rgb[pixel * 3 + 1];
    output.data[pixel * 4 + 2] = image.rgb[pixel * 3 + 2];
    output.data[pixel * 4 + 3] = 255;
  }

  context.putImageData(output, 0, 0);
  return canvas.toDataURL("image/png");
}

export function extractPgsPreviewsFromBuffer(buffer: ArrayBuffer, count = 3) {
  const previews: PgsPreview[] = [];

  scanDisplaySets(new Uint8Array(buffer), (image: DecodedImage | null, pts: number) => {
    if (previews.length >= count) return false;
    if (!isUsableImage(image) || !image) return true;

    const dataUrl = toDataUrl(image);
    if (dataUrl) {
      previews.push({ dataUrl, width: image.width, height: image.height, pts });
    }
    return true;
  });

  return previews;
}
