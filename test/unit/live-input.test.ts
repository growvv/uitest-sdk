import { describe, it, expect } from "vitest";
import { LiveInput } from "../../src/live/input.js";
import type { InputLane } from "../../src/live/input-lane.js";

class FakeLane implements InputLane {
  calls: Array<[string, ...unknown[]]> = [];
  hold = false;
  failMove = false;
  private waiters: Array<() => void> = [];
  protected async run(name: string, ...args: unknown[]) {
    this.calls.push([name, ...args]);
    if (name === "touchMove" && this.failMove) throw new Error("lane gone");
    if (this.hold) await new Promise<void>((r) => this.waiters.push(r));
  }
  release() { this.hold = false; for (const w of this.waiters.splice(0)) w(); }
  click(...a: [number, number]) { return this.run("click", ...a); }
  touchDown(x: number, y: number) { return this.run("touchDown", x, y); }
  touchMove(x: number, y: number) { return this.run("touchMove", x, y); }
  touchUp(x: number, y: number) { return this.run("touchUp", x, y); }
  key(code: number) { return this.run("key", code); }
  text(x: number, y: number, text: string, mode: string) { return this.run("text", x, y, text, mode); }
  pinch(cx: number, cy: number, from: number, to: number, ms: number) { return this.run("pinch", cx, cy, from, to, ms); }
  scroll(x: number, y: number, down: boolean, steps: number) { return this.run("scroll", x, y, down, steps); }
  ops(name: string) { return this.calls.filter((c) => c[0] === name).map((c) => c.slice(1)); }
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const bounds = () => ({ width: 400, height: 800 });

describe("LiveInput pointer", () => {
  it("sends a tap as touchDown then touchUp", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    input.up(10, 20);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[10, 20]]);
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("coalesces moves while one is in flight, keeping the latest", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 20);
    input.move(12, 20);
    input.move(13, 21);
    lane.release();
    await settle();
    expect(lane.ops("touchMove")).toEqual([[13, 21]]);
  });

  it("does not let a move cross an ordered up", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 20);
    input.up(11, 20);
    lane.release();
    await settle();
    const names = lane.calls.map((c) => c[0]);
    expect(names).toEqual(["touchDown", "touchMove", "touchUp"]);
  });

  it("clamps points to the display", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(-10, 900);
    input.up(5000, -5);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[0, 799]]);
    expect(lane.ops("touchUp")).toEqual([[399, 0]]);
  });

  it("trusts the client when the display size is unknown", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane }); // --no-layout: no bounds
    input.down(-5, 900);
    input.up(5000, -5);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[-5, 900]]);
    expect(lane.ops("touchUp")).toEqual([[5000, -5]]);
  });

  it("lifts a pointer held ten seconds without movement", async () => {
    let now = 1000;
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds, now: () => now });
    input.down(10, 20);
    await settle();
    now += 10_001;
    input.tick();
    await settle();
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
    expect(input.state()).toBe("idle");
  });

  it("cancel clears the queue and lifts the pointer", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 20);
    const done = input.cancel();
    lane.release();
    await done;
    await settle();
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
    expect(lane.ops("touchMove")).toEqual([]);
    expect(input.state()).toBe("idle");
  });

  it("cancel gives up on a lane that never answers", async () => {
    class DeadLane extends FakeLane {
      override touchUp(x: number, y: number): Promise<void> {
        this.calls.push(["touchUp", x, y]);
        return new Promise<void>(() => {});
      }
    }
    const lane = new DeadLane();
    const input = new LiveInput({ lane, bounds });
    input.down(1, 2);
    await settle();
    const started = Date.now();
    await input.cancel();
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("reports a lane failure, lifts best-effort and goes idle", async () => {
    const lane = new FakeLane();
    const errors: Error[] = [];
    const input = new LiveInput({ lane, bounds, onError: (e) => errors.push(e) });
    input.down(10, 20);
    await settle();
    lane.failMove = true;
    input.move(12, 22);
    await settle();
    expect(errors).toHaveLength(1);
    expect(input.state()).toBe("idle");
    // The lift uses the last point the device actually accepted.
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("records injection timings for the stats broadcast", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    input.up(10, 20);
    await settle();
    const stats = input.stats();
    expect(stats?.n).toBe(2);
    expect(stats?.p50).toBeGreaterThanOrEqual(0);
    expect(stats?.p95).toBeGreaterThanOrEqual(stats!.p50);
  });
});

describe("LiveInput pinch, wheel and text", () => {
  it("records a pinch baseline, then sends one segment per update", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.pinch(200, 400, 100);
    await settle();
    expect(lane.ops("pinch")).toEqual([]);
    input.pinch(200, 400, 140);
    input.pinch(200, 400, 180);
    await settle();
    expect(lane.ops("pinch")).toEqual([
      [200, 400, 100, 140, 140],
      [200, 400, 140, 180, 140],
    ]);
  });

  it("lifts a drag before starting a pinch", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 10);
    await settle();
    input.pinch(200, 400, 100);
    await settle();
    expect(lane.calls.map((c) => c[0])).toEqual(["touchDown", "touchUp"]);
    expect(input.state()).toBe("idle");
  });

  it("coalesces wheel deltas while one scroll is in flight", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.wheel(100, 200, 100);
    await settle();
    input.wheel(100, 200, 200);
    input.wheel(100, 200, 100);
    lane.release();
    await settle();
    expect(lane.ops("scroll")).toEqual([
      [100, 200, true, 1],
      [100, 200, true, 3],
    ]);
  });

  it("chooses typing or paste from length and charset", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds, focusPoint: () => ({ x: 50, y: 60 }) });
    input.type("abc");
    await settle();
    input.type("你好");
    input.type("   ");
    input.type("a\nb");
    await settle();
    expect(lane.ops("text")).toEqual([
      [50, 60, "abc", "typing"],
      [50, 60, "你好", "paste"],
      [50, 60, "a b", "typing"],
    ]);
  });

  it("prefers an explicit point, then the last press", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(11, 22);
    input.up(11, 22);
    input.type("abc");
    input.type("xyz", { x: 7, y: 8 });
    await settle();
    expect(lane.ops("text")).toEqual([
      [11, 22, "abc", "typing"],
      [7, 8, "xyz", "typing"],
    ]);
  });
});
