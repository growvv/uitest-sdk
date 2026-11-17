/**
 * The runner's small pure decisions: how many cold restarts the pinch walk may
 * spend, which scenarios `--only` selects, where a device point sits in the
 * browser, and how much of a long-press capture to keep.
 *
 * They live in their own module so the acceptance script can import them
 * without importing the runner (which connects to a device on load), and so
 * each can be tested without one.
 */
export class RestartBudget {
  private remaining: number;

  constructor(restarts: number) {
    this.remaining = Math.max(0, restarts);
  }

  /** Consumes one restart; false once the budget is spent. */
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  left(): number {
    return this.remaining;
  }
}

/**
 * Whether a scenario should run under `--only <a,b>`.
 *
 * The full run is eleven minutes, most of it the ten-minute stability window.
 * Iterating on one scenario with `--only` keeps that cost off the loop, and a
 * partial run is marked as such rather than written over the committed report.
 *
 * `takeover` always runs when a filter is active: every later scenario assumes
 * a tab already holds control, and without it the page correctly ignores the
 * injected input — which reads as a device failure when it is a harness one.
 */
export function shouldRun(name: string, only: string[] | null): boolean {
  if (only === null) return true;
  if (only.length === 0) return true;
  if (name === "takeover") return true;
  const lower = name.toLowerCase();
  return only.some((needle) => lower.includes(needle.toLowerCase()));
}

/** Parses `--only "browser keyboard,pinch"`; null when the flag is absent. */
export function parseOnly(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Size {
  width: number;
  height: number;
}

/** A node's rectangle in display pixels, as the layout reports it. */
interface Rect {
  y: number;
  h: number;
}

/**
 * How many screenshot pixels of a long-press capture to keep.
 *
 * The evidence is the input assistant bar; below it sits the person's search
 * history. The bar's position depends on the search text (a long query wraps
 * and pushes everything down), so a fixed height either cuts the bar or keeps
 * a history row — both happened. This follows the bar: the lowest assistant
 * node's bottom plus a small margin, converted to screenshot pixels.
 *
 * The scale comes from the width: the capture is the display at half size
 * (608 for a 1216-wide phone) with a strip already cut from the bottom, so
 * `shot.height / display.height` is not the frame's scale.
 */
export function assistantCropHeight(bar: Rect[], display: Size, shot: Size, marginPx = 24): number {
  const bottom = bar.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  const scale = shot.width / display.width;
  return Math.max(1, Math.min(shot.height, Math.round((bottom + marginPx) * scale)));
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The client pixel a device pixel appears at.
 *
 * The inverse of the page's `devicePoint`: the picture is drawn at `rect`, but
 * its pixels are *display* pixels, and the decoded frame may be half that size
 * (`--scale 2`, every MJPEG device). Dividing by the frame's size instead
 * lands the press in the top-left quadrant — the harness did that, and it only
 * looked right while the page had the same error.
 */
export function clientPointFor(device: { x: number; y: number }, display: Size, rect: Box): { x: number; y: number } {
  return {
    x: rect.left + (device.x / display.width) * rect.width,
    y: rect.top + (device.y / display.height) * rect.height,
  };
}

