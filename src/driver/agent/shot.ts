import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import jpeg from "jpeg-js";
import type { Rect } from "../../transport/model.js";

export interface ShotContext {
  display: { width: number; height: number };
  rotation: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Rgb = [number, number, number];

/** One rectangle to draw on the frame, in display coordinates. */
export interface MarkBox {
  rect: Rect;
  color: Rgb;
  /** Fill the whole box instead of outlining it. */
  fill?: boolean;
  /** Positive index drawn in a chip at the box's top-left corner. */
  label?: number;
}

/** 3x5 digit patterns, the only glyphs an index chip needs. */
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

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

  /**
   * Draws boxes on the frame, in display coordinates.
   *
   * This is the layout inspector's rendering primitive: one rectangle per
   * screen element plus its index, so the numbers on the image can be looked
   * up in the node table. Redaction happens first (`redact`), because a box
   * must never be the only thing covering a secret.
   */
  mark(boxes: MarkBox[]): Screenshot {
    if (boxes.length === 0) return this;
    const decoded = jpeg.decode(this.data, { useTArray: true });
    const { data, width, height } = decoded;
    const set = (x: number, y: number, color: Rgb) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    };

    for (const box of boxes) {
      const r = this.toImageRect(box.rect);
      const x0 = Math.max(0, Math.min(width, r.x));
      const y0 = Math.max(0, Math.min(height, r.y));
      const x1 = Math.max(0, Math.min(width, r.x + r.width));
      const y1 = Math.max(0, Math.min(height, r.y + r.height));
      if (x1 <= x0 || y1 <= y0) continue;

      if (box.fill) {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, box.color);
      } else {
        const t = Math.min(2, Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 2)));
        for (let y = y0; y < Math.min(y1, y0 + t); y++) for (let x = x0; x < x1; x++) set(x, y, box.color);
        for (let y = Math.max(y0, y1 - t); y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, box.color);
        for (let y = y0; y < y1; y++) for (let x = x0; x < Math.min(x1, x0 + t); x++) set(x, y, box.color);
        for (let y = y0; y < y1; y++) for (let x = Math.max(x0, x1 - t); x < x1; x++) set(x, y, box.color);
      }
      if (box.label !== undefined) drawIndex(data, width, height, x0, y0, String(box.label), box.color, set);
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

/** Draws `text` (digits) on a chip at (x,y), flipping ink for light fills. */
function drawIndex(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  text: string,
  bg: Rgb,
  set: (x: number, y: number, color: Rgb) => void,
): void {
  const scale = 3;
  const pad = 1;
  const chipW = 3 * scale * text.length + 2 * pad;
  const chipH = 5 * scale + 2 * pad;
  const cx = Math.max(0, Math.min(x, width - chipW));
  const cy = Math.max(0, Math.min(y, height - chipH));
  const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  const ink: Rgb = lum > 140 ? [0, 0, 0] : [255, 255, 255];

  for (let yy = cy; yy < Math.min(height, cy + chipH); yy++) {
    for (let xx = cx; xx < Math.min(width, cx + chipW); xx++) set(xx, yy, bg);
  }
  let dx = cx + pad;
  for (const ch of text) {
    const pattern = DIGITS[ch];
    if (!pattern) continue;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (pattern[row]![col] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            set(dx + col * scale + sx, cy + pad + row * scale + sy, ink);
          }
        }
      }
    }
    dx += 3 * scale;
  }
}
