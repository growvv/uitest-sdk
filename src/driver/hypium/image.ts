import jpeg from "jpeg-js";
import type { Rect } from "../../transport/model.js";

export interface Raster {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

export function decodeJpeg(data: Buffer): Raster {
  const decoded = jpeg.decode(data, { useTArray: true });
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

export function encodeJpeg(image: Raster, quality = 90): Buffer {
  return jpeg.encode({ data: Buffer.from(image.data), width: image.width, height: image.height }, quality).data;
}

/** Crops in raster pixels; out-of-range rectangles are clamped. */
export function cropRaster(image: Raster, rect: Rect): Raster {
  const x = Math.max(0, Math.min(image.width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(image.height, Math.round(rect.y)));
  const width = Math.max(1, Math.min(image.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.round(rect.height)));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const src = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(src, src + width * 4), row * width * 4);
  }
  return { width, height, data };
}

export function cropJpeg(buffer: Buffer, rect: Rect): Buffer {
  return encodeJpeg(cropRaster(decodeJpeg(buffer), rect));
}

function pixelDiff(screen: Raster, template: Raster, sx: number, sy: number, tx: number, ty: number): number {
  const si = (sy * screen.width + sx) * 4;
  const ti = (ty * template.width + tx) * 4;
  return (
    Math.abs(screen.data[si]! - template.data[ti]!) +
    Math.abs(screen.data[si + 1]! - template.data[ti + 1]!) +
    Math.abs(screen.data[si + 2]! - template.data[ti + 2]!)
  );
}

interface Candidate {
  x: number;
  y: number;
  score: number;
}

function scoreAt(
  screen: Raster,
  template: Raster,
  x: number,
  y: number,
  step: number,
): number {
  let total = 0;
  let samples = 0;
  for (let ty = 0; ty < template.height; ty += step) {
    for (let tx = 0; tx < template.width; tx += step) {
      total += pixelDiff(screen, template, x + tx, y + ty, tx, ty);
      samples++;
    }
  }
  if (samples === 0) return 0;
  return 1 - total / samples / (255 * 3);
}

/**
 * Finds `template` inside `screen` with a coarse-to-fine mean-absolute-error
 * search. This is the OpenCV `template` mode, not SIFT: it is exact-size and
 * cannot see rotation or rescaling, which is also how hypium documents it.
 */
export function findTemplate(
  screen: Raster,
  template: Raster,
  similarity = 0.95,
): { rect: Rect; similarity: number } | null {
  if (template.width > screen.width || template.height > screen.height) return null;
  const coarse = Math.max(1, Math.floor(Math.min(template.width, template.height) / 12));
  const sampleStep = Math.max(1, Math.ceil(Math.sqrt((template.width * template.height) / 600)));
  const maxX = screen.width - template.width;
  const maxY = screen.height - template.height;

  let best: Candidate = { x: 0, y: 0, score: -1 };
  for (let y = 0; y <= maxY; y += coarse) {
    for (let x = 0; x <= maxX; x += coarse) {
      const score = scoreAt(screen, template, x, y, sampleStep);
      if (score > best.score) best = { x, y, score };
    }
  }

  const fromX = Math.max(0, best.x - coarse);
  const toX = Math.min(maxX, best.x + coarse);
  const fromY = Math.max(0, best.y - coarse);
  const toY = Math.min(maxY, best.y + coarse);
  for (let y = fromY; y <= toY; y++) {
    for (let x = fromX; x <= toX; x++) {
      const score = scoreAt(screen, template, x, y, sampleStep);
      if (score > best.score) best = { x, y, score };
    }
  }

  const exact = scoreAt(screen, template, best.x, best.y, 1);
  if (exact < similarity) return null;
  return { rect: { x: best.x, y: best.y, width: template.width, height: template.height }, similarity: exact };
}
