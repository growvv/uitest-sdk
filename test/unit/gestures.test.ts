import { describe, it, expect } from "vitest";
import { Gestures } from "../../src/agent/gestures.js";

interface Call {
  api: string;
  args: unknown[];
  thisRef: string;
}

function fakeDevice() {
  const calls: Call[] = [];
  let matrix = 0;
  return {
    calls,
    async touchDown(x: number, y: number) {
      calls.push({ api: "touchDown", args: [x, y], thisRef: "Gestures" });
    },
    async touchMove(x: number, y: number) {
      calls.push({ api: "touchMove", args: [x, y], thisRef: "Gestures" });
    },
    async touchUp(x: number, y: number) {
      calls.push({ api: "touchUp", args: [x, y], thisRef: "Gestures" });
    },
    async click(x: number, y: number) {
      calls.push({ api: "click", args: [x, y], thisRef: "Gestures" });
    },
    async hypium(api: string, thisRef: string, args: unknown[]) {
      calls.push({ api, args, thisRef });
      if (api === "PointerMatrix.create") return `PointerMatrix#${matrix++}`;
      return true;
    },
    /** Test hook: pretend the clock advanced, so durations do not slow the suite. */
    async tick() {
      await Promise.resolve();
    },
  };
}

describe("Gestures", () => {
  it("taps with a single click", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev);
    await g.tap({ x: 10, y: 20 });
    expect(dev.calls).toEqual([{ api: "click", args: [10, 20], thisRef: "Gestures" }]);
  });

  it("long-presses by holding the pointer down", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.longPress({ x: 10, y: 20 }, { holdMs: 700 });
    expect(dev.calls.map((c) => c.api)).toEqual(["touchDown", "touchUp"]);
    expect(dev.calls[0]!.args).toEqual([10, 20]);
    expect(dev.calls[1]!.args).toEqual([10, 20]);
  });

  it("double-clicks twice with a short gap", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.doubleClick({ x: 5, y: 6 });
    expect(dev.calls.map((c) => c.api)).toEqual(["click", "click"]);
  });

  it("swipes with interpolated moves and a final release at the destination", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.swipe({ x: 0, y: 0 }, { x: 100, y: 0 }, { steps: 4 });
    const apis = dev.calls.map((c) => c.api);
    expect(apis[0]).toBe("touchDown");
    expect(apis.at(-1)).toBe("touchUp");
    expect(dev.calls.at(-1)!.args).toEqual([100, 0]);
    expect(apis.filter((a) => a === "touchMove")).toHaveLength(4);
    expect(dev.calls[4]!.args).toEqual([100, 0]);
  });

  it("swipe always releases the pointer when a move fails", async () => {
    const dev = fakeDevice();
    dev.touchMove = async () => {
      throw new Error("device said no");
    };
    const g = new Gestures(dev, { sleep: async () => undefined });
    await expect(g.swipe({ x: 0, y: 0 }, { x: 100, y: 0 })).rejects.toThrow(/device said no/);
    expect(dev.calls.at(-1)!.api).toBe("touchUp");
  });

  it("drags with a hold before moving, then releases at the target", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.drag({ x: 0, y: 0 }, { x: 50, y: 50 }, { holdMs: 300, steps: 2 });
    expect(dev.calls.map((c) => c.api)).toEqual([
      "touchDown", "touchMove", "touchMove", "touchUp",
    ]);
    expect(dev.calls.at(-1)!.args).toEqual([50, 50]);
  });

  it("flings with a fast, short path", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.fling({ x: 600, y: 1800 }, { x: 600, y: 400 }, { steps: 3 });
    expect(dev.calls[0]!.api).toBe("touchDown");
    expect(dev.calls.at(-1)!.args).toEqual([600, 400]);
  });

  it("rejects a swipe whose duration leaves no time for a step", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await expect(g.swipe({ x: 0, y: 0 }, { x: 10, y: 0 }, { durationMs: 0 }))
      .rejects.toThrow(/durationMs/);
  });

  it("injects two-finger gestures through PointerMatrix", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.pinch({ center: { x: 500, y: 900 }, from: 200, to: 400, durationMs: 400, steps: 2 });
    const apis = dev.calls.map((c) => c.api);
    expect(apis[0]).toBe("PointerMatrix.create");
    expect(dev.calls[0]!.args).toEqual([2, 2]);
    expect(apis).toContain("PointerMatrix.setPoint");
    expect(apis.at(-1)).toBe("Driver.injectMultiPointerAction");
  });

  it("sends a multi-touch gesture as finger paths", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.multiTouch([
      { from: { x: 100, y: 100 }, to: { x: 100, y: 300 } },
      { from: { x: 300, y: 100 }, to: { x: 300, y: 300 } },
    ], { steps: 2 });
    const setPoints = dev.calls.filter((c) => c.api === "PointerMatrix.setPoint");
    // two fingers x two positions
    expect(setPoints).toHaveLength(4);
    expect(dev.calls.at(-1)!.api).toBe("Driver.injectMultiPointerAction");
  });

  it("reports how long a gesture took", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    const r = await g.swipe({ x: 0, y: 0 }, { x: 10, y: 10 }, { steps: 2 });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.points).toBe(2);
  });
});

describe("Gestures · multi-finger primitives", () => {
  it("injects several taps at once", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.multiTap(
      [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      { holdMs: 120 },
    );
    expect(dev.calls[0]).toMatchObject({ api: "PointerMatrix.create", args: [2, 2] });
    const inject = dev.calls.at(-1)!;
    expect(inject.api).toBe("Driver.injectMultiPointerAction");
    expect(inject.args[1]).toBe(120);
  });

  it("injects arbitrary sampled paths", async () => {
    const dev = fakeDevice();
    const g = new Gestures(dev, { sleep: async () => undefined });
    await g.injectPaths(
      [
        [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
          { x: 10, y: 10 },
        ],
      ],
      { durationMs: 240 },
    );
    expect(dev.calls[0]).toMatchObject({ api: "PointerMatrix.create", args: [1, 3] });
    expect(dev.calls.filter((c) => c.api === "PointerMatrix.setPoint")).toHaveLength(3);
    const inject = dev.calls.at(-1)!;
    expect(inject.args[1]).toBe(240);
  });
});
