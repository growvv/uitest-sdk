import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jpeg from "jpeg-js";
import { getDevice, hasCastSupport, countNodes, startMotion } from "./helpers.js";
import type { Device } from "../../src/device.js";

let dev: Device;

beforeAll(async () => {
  dev = await getDevice();
}, 60_000);

afterAll(async () => {
  await dev?.dispose();
});

describe("connect", () => {
  it("returns the real display size", async () => {
    const s = await dev.agent.getDisplaySize();
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
  });
});

describe("actions", () => {
  it("clicks without error", async () => {
    const s = await dev.agent.getDisplaySize();
    const t0 = Date.now();
    await dev.agent.click(Math.floor(s.width / 2), Math.floor(s.height / 2));
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("swipes via Gestures in under 1500ms", async () => {
    const s = await dev.agent.getDisplaySize();
    const t0 = Date.now();
    await dev.agent.swipe(s.width / 2, s.height * 0.7, s.width / 2, s.height * 0.3, { durationMs: 300 });
    // Driver.swipe on the emulator takes 6.2–12.6 s; this assertion catches a
    // regression that reintroduces it.
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("performs atomic touch down/move/up", async () => {
    await dev.agent.touchDown(100, 100);
    await dev.agent.touchMove(120, 120);
    await dev.agent.touchUp(120, 120);
  });
});

describe("ui tree", () => {
  it("captures a non-empty tree", async () => {
    const tree = await dev.agent.captureLayout();
    expect(tree.attributes).toBeDefined();
    expect(Array.isArray(tree.children)).toBe(true);
    expect(countNodes(tree)).toBeGreaterThan(0);
  });
});

describe("screenshot", () => {
  it("returns a valid JPEG under 500ms", async () => {
    const t0 = Date.now();
    const jpeg = await dev.agent.captureScreen({ scale: 2 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(jpeg.subarray(-2).toString("hex")).toBe("ffd9");
  });

  it("ignores the scale option and always returns the fixed capture size", async () => {
    // Measured on 7.0.0.1 / agent 1.1.10: `scale` in startCaptureScreen's args
    // has no effect — 1, 2 and 5 all yield 608x1344. Documented as a limitation
    // rather than papered over, so this test pins the real behaviour.
    const dims = new Set<string>();
    for (const scale of [1, 2, 5] as const) {
      const frame = await dev.agent.captureScreen({ scale });
      const d = jpeg.decode(frame);
      dims.add(`${d.width}x${d.height}`);
    }
    expect([...dims]).toEqual(["608x1344"]);
  });
});

describe("streaming", () => {
  it("delivers 10 consecutive frames while the screen changes", async () => {
    const s = await dev.agent.getDisplaySize();
    const stopMotion = startMotion(dev, s);
    try {
      const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      for (let i = 0; i < 10; i++) {
        const f = await it.next();
        expect(f.value!.length).toBeGreaterThan(0);
      }
    } finally {
      stopMotion();
      await dev.agent.stopStream();
    }
  }, 60_000);

  it("serves RPCs while a stream is open", async () => {
    const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
    await it.next();
    const t0 = Date.now();
    await dev.agent.getDisplaySize();
    expect(Date.now() - t0).toBeLessThan(200);
    await dev.agent.stopStream();
  });

  it("idles without a hang when the screen stops changing", async () => {
    // Behaviour record, not a feature assertion: capture is dirty-region driven,
    // so a still screen produces the initial frame and then may go quiet for a
    // long time. What matters for callers is that the stream neither hangs the
    // process nor blocks stopStream(). Whether a second frame arrives depends on
    // residual UI animation, so its count is logged, not asserted.
    const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
    await it.next();
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    await dev.agent.stopStream();
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 30_000);
});

describe.skipIf(!hasCastSupport())("casting", () => {
  it("runs two independent casts", async () => {
    const a = await dev.createCast({ mode: "stream", socketName: "cast_a", frameRate: 15 });
    const b = await dev.createCast({ mode: "stream", socketName: "cast_b", frameRate: 15 });
    try {
      const [fa, fb] = await Promise.all([
        a.stream()[Symbol.asyncIterator]().next(),
        b.stream()[Symbol.asyncIterator]().next(),
      ]);
      expect(fa.value?.data.length ?? 0).toBeGreaterThan(0);
      expect(fb.value?.data.length ?? 0).toBeGreaterThan(0);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  }, 60_000);
});

describe.skipIf(hasCastSupport())("casting on a device without the extension", () => {
  it("selects the MJPEG path and still streams", async () => {
    const cast = await dev.createCast({ mode: "stream", frameRate: 15 });
    expect(cast.castKind).toBe("mjpeg");
    const s = await dev.agent.getDisplaySize();
    const stop = startMotion(dev, s);
    try {
      const it = cast.stream()[Symbol.asyncIterator]();
      for (let i = 0; i < 5; i++) {
        const f = await it.next();
        expect(f.value.data.length).toBeGreaterThan(0);
      }
    } finally {
      stop();
      await cast.dispose();
    }
  }, 60_000);
});

describe("cli", () => {
  it("dumps a layout", async () => {
    const tree = await dev.cli.dumpLayout({});
    expect(tree.attributes).toBeDefined();
  });
});
