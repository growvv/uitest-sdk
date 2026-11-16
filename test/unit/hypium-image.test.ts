import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { HypiumDriver } from "../../src/hypium/index.js";
import { UnsupportedError } from "../../src/errors.js";

function screenJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x >= 30 && x < 50 && y >= 40 && y < 60;
      data[i] = inside ? 220 : 24;
      data[i + 1] = inside ? 40 : 24;
      data[i + 2] = inside ? 40 : 24;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 95).data;
}

function world() {
  const calls: { api: string; args: unknown[]; thisRef: string }[] = [];
  const screen = screenJpeg(80, 120);
  const agent = {
    async hypium(api: string, thisRef: string, args: unknown[]) {
      calls.push({ api, args, thisRef });
      if (api === "PointerMatrix.create") return "PointerMatrix#0";
      return null;
    },
    async touchDown(x: number, y: number) {
      calls.push({ api: "touchDown", args: [x, y], thisRef: "Gestures" });
    },
    async touchMove() {},
    async touchUp() {},
    async click(x: number, y: number) {
      calls.push({ api: "agent.click", args: [x, y], thisRef: "Agent" });
    },
    async getDisplaySize() {
      return { width: 160, height: 240 };
    },
    async getDisplayRotation() {
      return 0;
    },
    async captureScreen() {
      return screen;
    },
  };
  const hdc = {
    async shell() {
      return "";
    },
    async command() {
      return "";
    },
    async push() {},
    async pull() {},
  };
  const driver = new HypiumDriver({ agent: agent as never, hdc, deviceTag: "deadbeef" });
  return { driver, calls };
}

function templateFile(): string {
  // Crop the same region from a freshly encoded screen so colour loss matches.
  const full = jpeg.decode(screenJpeg(80, 120), { useTArray: true });
  const x = 30;
  const y = 40;
  const w = 20;
  const h = 20;
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * full.width + x) * 4;
    data.set(full.data.subarray(src, src + w * 4), row * w * 4);
  }
  const encoded = jpeg.encode({ data, width: w, height: h }, 95).data;
  const dir = mkdtempSync(join(tmpdir(), "hypium-img-"));
  const path = join(dir, "template.jpeg");
  writeFileSync(path, encoded);
  return path;
}

describe("HypiumDriver · image recognition", () => {
  it("finds a JPEG template and maps the rect back to display coordinates", async () => {
    const w = world();
    const rect = await w.driver.findImage(templateFile(), { similarity: 0.9 });
    expect(rect).not.toBeNull();
    // Screen is 80×120 at scale 0.5; display is 160×240.
    expect(rect!.x).toBeGreaterThanOrEqual(54);
    expect(rect!.x).toBeLessThanOrEqual(66);
    expect(rect!.y).toBeGreaterThanOrEqual(74);
    expect(rect!.y).toBeLessThanOrEqual(86);
    expect(rect!.width).toBe(40);
    expect(rect!.height).toBe(40);
  });

  it("returns null when the template is not on screen", async () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), "hypium-img-"));
    const path = join(dir, "absent.jpeg");
    const data = Buffer.alloc(8 * 8 * 4, 0);
    for (let i = 0; i < 8 * 8; i++) data[i * 4 + 3] = 255;
    writeFileSync(path, jpeg.encode({ data, width: 8, height: 8 }, 95).data);
    expect(await w.driver.findImage(path, { similarity: 0.95 })).toBeNull();
  });

  it("touches the center of a found image", async () => {
    const w = world();
    await w.driver.touchImage(templateFile(), { similarity: 0.9 });
    const down = w.calls.find((c) => c.api === "agent.click")!;
    // Center of the template at (40, 50) on the 80×120 capture → (80, 100).
    expect(down.args[0]).toBeGreaterThanOrEqual(70);
    expect(down.args[0]).toBeLessThanOrEqual(90);
    expect(down.args[1]).toBeGreaterThanOrEqual(90);
    expect(down.args[1]).toBeLessThanOrEqual(110);
  });

  it("checks existence as a boolean", async () => {
    const w = world();
    expect(
      await w.driver.checkImageExist(templateFile(), { similarity: 0.9, timeoutMs: 100 }),
    ).toBe(true);
  });

  it("does not pretend to support SIFT", async () => {
    const w = world();
    await expect(w.driver.findImage(templateFile(), { mode: "sift" })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });
});
