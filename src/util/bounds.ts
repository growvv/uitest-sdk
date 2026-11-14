import type { Rect } from "../model.js";

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

export function parseBounds(s: string): Rect | null {
  const m = BOUNDS_RE.exec(s.trim());
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < 0 || height < 0) return null;
  return { x: x1, y: y1, width, height };
}

export function cropRect(inner: Rect, outer: Rect): Rect {
  const x1 = Math.max(inner.x, outer.x);
  const y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y2 = Math.min(inner.y + inner.height, outer.y + outer.height);
  if (x2 <= x1 || y2 <= y1) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
