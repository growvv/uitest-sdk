import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import jpeg from "jpeg-js";
import type { Rect } from "../model.js";

export interface ShotContext {
  display: { width: number; height: number };
  rotation: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A captured frame plus the geometry needed to relate it to the screen.
 *
 * The device ignores the requested capture scale and returns a frame of its own
 * size (measured: 608x1344 for a 1216x2688 display), so every coordinate
 * conversion has to be derived from the frame actually received. Callers that
 * assume `scale` was honoured crop and aim at the wrong place.
 */
export class Screenshot {
  readonly width: number;
  readonly height: number;
  readonly display: { width: number; height: number };
  readonly rotation: number;
  /** Frame pixels per display pixel. */
  readonly factor: number;

  private constructor(
    readonly data: Buffer,
    ctx: ShotContext,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    this.display = { ...ctx.display };
    this.rotation = ctx.rotation;
    this.factor = ctx.display.width > 0 ? width / ctx.display.width : 1;
  }

  /** Decodes the frame header to learn its size. Bytes are kept as received. */
  static async from(data: Buffer, ctx: ShotContext): Promise<Screenshot> {
    const decoded = jpeg.decode(data, { useTArray: true });
    return new Screenshot(Buffer.from(data), ctx, decoded.width, decoded.height);
  }

  /** Display coordinates (what a layout tree and a tap use) → frame pixels. */
  toImagePoint(p: Point): Point {
    return { x: Math.round(p.x * this.factor), y: Math.round(p.y * this.factor) };
  }

  /** Frame pixels → display coordinates. */
  toDisplayPoint(p: Point): Point {
    return this.factor === 0
      ? { x: 0, y: 0 }
      : { x: Math.round(p.x / this.factor), y: Math.round(p.y / this.factor) };
  }

  toImageRect(rect: Rect): Rect {
    return {
      x: Math.round(rect.x * this.factor),
      y: Math.round(rect.y * this.factor),
      width: Math.round(rect.width * this.factor),
      height: Math.round(rect.height * this.factor),
    };
  }

  describe(): string {
    return (
      `${this.width}x${this.height} · display ${this.display.width}x${this.display.height}` +
      ` · factor ${Number(this.factor.toFixed(3))} · rotation ${this.rotation * 90}°`
    );
  }

  /**
   * Covers display rectangles with opaque gray and re-encodes the frame.
   *
   * Used for credential elements: the text render already replaces a code or a
   * password value with bullets, and the screenshot must not say it back. The
   * rectangles are in display coordinates; the scale comes from the frame that
   * was actually received, not from the requested `scale`.
   */
  redact(rects: Rect[]): Screenshot {
    if (rects.length === 0) return this;
    const decoded = jpeg.decode(this.data, { useTArray: true });
    const { data, width, height } = decoded;
    for (const rect of rects) {
      const box = this.toImageRect(rect);
      const x0 = Math.max(0, box.x);
      const y0 = Math.max(0, box.y);
      const x1 = Math.min(width, box.x + box.width);
      const y1 = Math.min(height, box.y + box.height);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          data[i] = 128;
          data[i + 1] = 128;
          data[i + 2] = 128;
          data[i + 3] = 255;
        }
      }
    }
    const encoded = jpeg.encode({ data, width, height }, 90).data;
    return new Screenshot(
      Buffer.from(encoded),
      { display: this.display, rotation: this.rotation },
      width,
      height,
    );
  }

  async save(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.data);
    return path;
  }
}
