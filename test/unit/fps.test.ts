import { describe, it, expect } from "vitest";
import { FpsMeter } from "../../src/fps.js";

describe("FpsMeter", () => {
  it("reports zero until it has two frames", () => {
    const meter = new FpsMeter({ windowMs: 1000 });
    expect(meter.stats(0).fps).toBe(0);
    meter.add(0);
    expect(meter.stats(0).fps).toBe(0);
  });

  it("computes fps from the time between frames", () => {
    const meter = new FpsMeter({ windowMs: 1000 });
    for (let t = 0; t <= 50; t += 10) meter.add(t);
    // 6 frames spanning 50 ms → 5 intervals → 100 fps.
    expect(meter.stats(50).fps).toBeCloseTo(100, 5);
    expect(meter.stats(50).frames).toBe(6);
    expect(meter.stats(50).spanMs).toBe(50);
  });

  it("drops frames older than the window", () => {
    const meter = new FpsMeter({ windowMs: 100 });
    for (let t = 0; t <= 100; t += 10) meter.add(t);
    meter.add(200);
    // At 200 ms only the 200 frame and the 100 frame are inside 100..200.
    const stats = meter.stats(200);
    expect(stats.frames).toBe(2);
    expect(stats.fps).toBeCloseTo(10, 5);
  });

  it("counts a stall from the last frame", () => {
    const meter = new FpsMeter({ windowMs: 1000 });
    meter.add(1000);
    expect(meter.stats(1500).stalledMs).toBe(500);
    meter.add(1600);
    expect(meter.stats(1600).stalledMs).toBe(0);
  });

  it("resets", () => {
    const meter = new FpsMeter();
    meter.add(0);
    meter.add(16);
    meter.reset();
    expect(meter.stats(16).frames).toBe(0);
    expect(meter.stats(16).fps).toBe(0);
    expect(meter.stats(16).lastAt).toBeNull();
  });

  it("defaults the timestamp to now", () => {
    const meter = new FpsMeter();
    const before = Date.now();
    meter.add();
    expect(meter.stats().lastAt).toBeGreaterThanOrEqual(before);
  });

  it("rejects a nonsensical window", () => {
    expect(() => new FpsMeter({ windowMs: 0 })).toThrow();
    expect(() => new FpsMeter({ windowMs: -1 })).toThrow();
  });
});
