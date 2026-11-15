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

  async save(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.data);
    return path;
  }
}
