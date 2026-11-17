import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";

const ROOT = join(import.meta.dirname, "..", "..");
const SHOT = join(ROOT, "docs/acceptance/live/screenshots");

/**
 * Where the search page's history begins on this device (1216×2688), in
 * screenshot pixels. Measured from the run's own capture: the assistant bar
 * ends at 192, the first history row starts at 232.
 */
const HISTORY_START_PX = 232;

function meanAt(data: Uint8Array, width: number, x: number, y: number): number {
  const i = (y * width + x) * 4;
  return (data[i]! + data[i + 1]! + data[i + 2]!)/3;
}

describe("committed acceptance evidence", () => {
  it("long-press evidence ends at the assistant bar, before the search history", () => {
    // The shot keeps only the top strip because what follows is the person's
    // own search history. Cropping to a fixed 280 px still caught the first
    // history row, so this pins the outcome in pixels: the strip must stop
    // before the history begins, and its tail must be blank rather than a
    // cut through a line of text.
    const file = join(SHOT, "03-long-press.jpg");
    const image = jpeg.decode(readFileSync(file), { useTArray: true });
    expect(image.height).toBeLessThanOrEqual(HISTORY_START_PX);

    for (let y = image.height - 8; y < image.height; y++) {
      let darkest = 255;
      for (let x = 0; x < image.width; x++) {
        darkest = Math.min(darkest, meanAt(image.data, image.width, x, y));
      }
      expect(darkest, `row ${y} of ${image.height}`).toBeGreaterThan(170);
    }
  });
});
