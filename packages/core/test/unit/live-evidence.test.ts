import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SHOT = join(ROOT, "docs/acceptance/live/screenshots");

function meanAt(data: Uint8Array, width: number, x: number, y: number): number {
  const i = (y * width + x) * 4;
  return (data[i]! + data[i + 1]! + data[i + 2]!)/3;
}

describe("committed acceptance evidence", () => {
  it("long-press evidence does not cut through the assistant bar", () => {
    // The long-press shot is cropped to the input assistant, because what
    // follows is the person's own search history. A fixed height cannot do
    // that: the bar moves with the search text, and a constant either cut the
    // bar's own labels (row 220 of 228 on this device) or kept a history row.
    // The crop now follows the bar's geometry — `assistantCropHeight` is
    // tested in live-walk.test.ts — and this pins the visible result: the
    // strip ends on blank space, not through a line of text.
    const file = join(SHOT, "03-long-press.jpg");
    const image = jpeg.decode(readFileSync(file), { useTArray: true });
    for (let y = image.height - 8; y < image.height; y++) {
      let darkest = 255;
      for (let x = 0; x < image.width; x++) {
        darkest = Math.min(darkest, meanAt(image.data, image.width, x, y));
      }
      expect(darkest, `row ${y} of ${image.height}`).toBeGreaterThan(170);
    }
  });
});
