import { describe, it, expect } from "vitest";
import jpeg from "jpeg-js";
import { Screenshot } from "../../src/agent/shot.js";

const solidJpeg = (w: number, h: number) =>
  jpeg.encode({ data: Buffer.alloc(w * h * 4, 0x30), width: w, height: h }, 80).data;

describe("Screenshot", () => {
  it("reports both frame and display geometry", async () => {
    const shot = await Screenshot.from(solidJpeg(608, 1344), {
      display: { width: 1216, height: 2688 },
      rotation: 0,
    });
    expect(shot.width).toBe(608);
    expect(shot.height).toBe(1344);
    expect(shot.display).toEqual({ width: 1216, height: 2688 });
    expect(shot.factor).toBeCloseTo(0.5);
  });

  it("maps a display point onto the frame", async () => {
    const shot = await Screenshot.from(solidJpeg(608, 1344), {
      display: { width: 1216, height: 2688 },
      rotation: 0,
    });
    // The device ignores the requested scale, so a point must be derived from
    // the frame it actually got — not from the scale the caller asked for.
    expect(shot.toImagePoint({ x: 600, y: 1000 })).toEqual({ x: 300, y: 500 });
  });

  it("maps a frame point back onto the display", async () => {
    const shot = await Screenshot.from(solidJpeg(608, 1344), {
      display: { width: 1216, height: 2688 },
      rotation: 0,
    });
    expect(shot.toDisplayPoint({ x: 300, y: 500 })).toEqual({ x: 600, y: 1000 });
  });

  it("describes itself in one line", async () => {
    const shot = await Screenshot.from(solidJpeg(608, 1344), {
      display: { width: 1216, height: 2688 },
      rotation: 0,
    });
    expect(shot.describe()).toBe("608x1344 · display 1216x2688 · factor 0.5 · rotation 0°");
  });

  it("writes the jpeg bytes unchanged", async () => {
    const bytes = solidJpeg(10, 10);
    const shot = await Screenshot.from(bytes, {
      display: { width: 20, height: 20 },
      rotation: 0,
    });
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(`${os.tmpdir()}/shot-`);
    const file = `${dir}/a.jpg`;
    await shot.save(file);
    expect((await fs.readFile(file)).equals(Buffer.from(bytes))).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
