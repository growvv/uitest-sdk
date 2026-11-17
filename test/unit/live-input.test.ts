import { describe, it, expect } from "vitest";
import { LiveInput } from "../../src/live/input.js";
import type { InputLane } from "../../src/input/lane.js";

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

  it("lifts the pointer before it reports the failure", async () => {
    // The server's onError handler releases control and closes the lane at
    // once, so a lift issued after it lands on a dead socket and the phone
    // keeps its finger down. The lift has to be on the wire first.
    const lane = new FakeLane();
    const seen: number[] = [];
    const input = new LiveInput({
      lane,
      bounds,
      onError: () => seen.push(lane.ops("touchUp").length),
    });
    input.down(10, 20);
    await settle();
    lane.failMove = true;
    input.move(12, 22);
    await settle();
    expect(seen).toEqual([1]);
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("still reports the failure when the lift itself fails", async () => {
    // A dead lane is the common case; the person must still learn that input
    // stopped, and the error must not be swallowed by the lift's rejection.
    class NoLift extends FakeLane {
      override touchUp(x: number, y: number): Promise<void> {
        this.calls.push(["touchUp", x, y]);
        return Promise.reject(new Error("lift failed"));
      }
    }
    const lane = new NoLift();
    const errors: Error[] = [];
    const input = new LiveInput({ lane, bounds, onError: (e) => errors.push(e) });
    input.down(10, 20);
    await settle();
    lane.failMove = true;
    input.move(12, 22);
    await settle();
    expect(errors.map((e) => e.message)).toEqual(["lane gone"]);
    expect(input.state()).toBe("idle");
  });

  it("gives up on a lift that never answers, still reporting the failure", async () => {
    // onError closes the lane; a lift that hangs must not hold the report
    // hostage for longer than cancel()'s 500 ms cap.
    class HangingLift extends FakeLane {
      override touchUp(x: number, y: number): Promise<void> {
        this.calls.push(["touchUp", x, y]);
        return new Promise<void>(() => {});
      }
    }
    const lane = new HangingLift();
    const errors: Error[] = [];
    let reported = () => {};
    const onError = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const input = new LiveInput({
      lane,
      bounds,
      onError: (e) => {
        errors.push(e);
        reported();
      },
    });
    input.down(10, 20);
    await settle();
    lane.failMove = true;
    const started = Date.now();
    input.move(12, 22);
    await Promise.race([onError, new Promise<void>((r) => setTimeout(r, 900))]);
    expect(errors).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("ignores input that arrives after a failure", async () => {
    // The report waits for the lift, so the page can still send for up to
    // half a second after the lane died. None of it may be replayed onto the
    // next takeover's lane.
    const lane = new FakeLane();
    let reported = () => {};
    const failed = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const input = new LiveInput({ lane, bounds, onError: () => reported() });
    input.down(10, 20);
    await settle();
    lane.failMove = true;
    input.move(12, 22);
    await failed;
    input.down(30, 40);
    input.move(31, 41);
    input.up(31, 41);
    input.key("back");
    input.type("late");
    input.pinch(100, 200, 50);
    input.wheel(100, 200, 100);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[10, 20]]);
    // The rejected move was attempted; nothing after it reached the lane.
    expect(lane.ops("touchMove")).toEqual([[12, 22]]);
    expect(lane.ops("key")).toEqual([]);
    expect(lane.ops("text")).toEqual([]);
    expect(lane.ops("pinch")).toEqual([]);
    expect(lane.ops("scroll")).toEqual([]);
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
    expect(input.state()).toBe("idle");
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

  it("keeps both pinch fingers on the display when the centre is near an edge", async () => {
    // Ctrl+wheel zooms around the pointer, and the page lets the centre be
    // anywhere on the canvas. A pointer near the right edge with half=608 puts
    // one finger at x=1508 on a 1216-wide phone; the device rejects an
    // off-screen touch point and drops the lane, so the zoom kicks every tab
    // back to read-only.
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.pinch(350, 400, 100);
    await settle();
    input.pinch(350, 400, 180);
    await settle();
    const [, , , from, to] = lane.ops("pinch")[0] as [number, number, number, number, number];
    // 350 + 180 = 530 > 400, so the centre must move left (or the half shrink)
    // until both fingers are inside.
    const cx = (lane.ops("pinch")[0] as [number, number])[0];
    expect(cx + to).toBeLessThanOrEqual(399);
    expect(cx - from).toBeGreaterThanOrEqual(0);
  });

  it("keeps both pinch fingers on the display vertically too", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.pinch(200, 20, 100);
    await settle();
    input.pinch(200, 20, 180);
    await settle();
    // The pinch axis is horizontal, so only x moves; y stays at the centre and
    // the half must fit in the short side, which it does. What must not happen
    // is a centre outside the display.
    const [cx, cy] = lane.ops("pinch")[0] as [number, number];
    expect(cx).toBeGreaterThanOrEqual(0);
    expect(cx).toBeLessThanOrEqual(399);
    expect(cy).toBeGreaterThanOrEqual(0);
    expect(cy).toBeLessThanOrEqual(799);
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

describe("LiveInput text placement", () => {
  // Without a layout there is no focus point, no display size and no earlier
  // press: the old fallback was (0,0), which is the top-left corner of the
  // status bar — a text injection there goes nowhere near the field the person
  // is looking at, and on this ROM it can pull the shade down.
  it("does not send text to 0,0 when nothing is known", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane }); // --no-layout, no press yet
    input.type("hello");
    await settle();
    expect(lane.ops("text")).toEqual([]);
  });

  it("still sends text once a point is known", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane });
    input.down(120, 340);
    input.up(120, 340);
    await settle();
    input.type("hello");
    await settle();
    expect(lane.ops("text")).toEqual([[120, 340, "hello", "typing"]]);
  });

  // The half-distance is bounded by the display when there is one. Without a
  // layout the client is trusted, but a value the device cannot represent
  // (Infinity, NaN, or half a screen across) still has to be refused rather
  // than forwarded.
  it("refuses a pinch half that is not a finite positive number", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane });
    input.pinch(100, 200, Number.POSITIVE_INFINITY);
    input.pinch(100, 200, Number.NaN);
    input.pinch(100, 200, -5);
    await settle();
    expect(lane.ops("pinch")).toEqual([]);
  });
});

describe("LiveInput latency accounting", () => {
  // A scroll is ~456 ms of device-side work and a paste 1.3-1.9 s; a tap is
  // 3-4 ms. Averaging them into one p50 reports a number that describes no
  // gesture: the readout says "输入 275 ms" after a tap that took 4 ms.
  it("reports pointer latency separately from slow operations", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    input.up(10, 20);
    await settle();
    input.wheel(10, 20, 300);
    await settle();
    input.type("a long pasted string, over twelve characters");
    await settle();
    const stats = input.stats()!;
    expect(stats.n).toBe(2); // the tap's down and up only
    expect(stats.slow).toBe(2); // the scroll and the paste
  });

  it("still counts a slow operation in n when nothing else happened", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.wheel(10, 20, 300);
    await settle();
    const stats = input.stats()!;
    expect(stats.n).toBe(0);
    expect(stats.slow).toBe(1);
  });
});

describe("LiveInput release", () => {
  // Spec §6.4: leaving a takeover flushes the buffered text. The page does
  // that, and then sends `release` — at which point cancel() used to empty the
  // queue, dropping the text the page had just flushed and already removed
  // from its input box. The person saw their characters vanish with nothing
  // typed on the phone, and had no way to retype them.
  it("sends text that was queued just before the release", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.type("鸿蒙");
    const done = input.cancel();
    lane.release();
    await done;
    await settle();

    const names = lane.calls.map((c) => c[0]);
    // The lift comes first: the text must not land under a finger still down,
    // where the device would read it as part of the gesture.
    expect(names).toEqual(["touchDown", "touchUp", "text"]);
    expect(lane.ops("text").map((c) => c[2])).toEqual(["鸿蒙"]);
  });

  it("drops pointer moves but keeps pending text on cancel", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 21);
    input.move(12, 22);
    input.type("hello");
    const done = input.cancel();
    // The lane answers again, as a real one would; cancel must not have
    // thrown the queued text away while it waited.
    lane.release();
    await done;
    await settle();

    expect(lane.ops("touchMove")).toEqual([]);
    expect(lane.ops("text").map((c) => c[2])).toEqual(["hello"]);
  });
});

describe("LiveInput injection counter", () => {
  // `n` is the size of a 200-entry ring buffer, so it stops growing after 200
  // ops. The acceptance script waits for `n` to reach a target it computes
  // from the gestures it just made; once a session has run past 200 injections
  // that wait can never be satisfied, and a passing run times out instead.
  it("keeps counting past the timing buffer's 200 entries", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    for (let i = 0; i < 250; i++) {
      input.down(10, 20);
      input.up(10, 20);
    }
    await settle();

    const stats = input.stats()!;
    expect(stats.n).toBe(200);
    expect(stats.total).toBe(500);
  });

  it("counts a slow operation in total but not in n", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    input.up(10, 20);
    await settle();
    input.wheel(10, 20, 300);
    await settle();

    const stats = input.stats()!;
    expect(stats.n).toBe(2);
    expect(stats.total).toBe(3);
  });
});
