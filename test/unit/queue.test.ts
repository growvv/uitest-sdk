import { describe, it, expect } from "vitest";
import { SerialQueue } from "../../src/driver/agent/queue.js";

describe("SerialQueue", () => {
  it("runs tasks one at a time in FIFO order", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    let active = 0, maxActive = 0;
    const mk = (i: number) => q.run(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      order.push(i); active--;
      return i;
    });
    const results = await Promise.all([mk(1), mk(2), mk(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it("propagates a rejection without blocking the queue", async () => {
    const q = new SerialQueue();
    await expect(q.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(q.run(async () => 42)).resolves.toBe(42);
  });

  it("times out a task that never resolves", async () => {
    const q = new SerialQueue();
    await expect(q.run(() => new Promise(() => {}), 30)).rejects.toThrow(/timeout/i);
    await expect(q.run(async () => "next")).resolves.toBe("next");
  });

  it("reports queue depth", async () => {
    const q = new SerialQueue();
    const p1 = q.run(() => new Promise((r) => setTimeout(() => r(1), 20)));
    const p2 = q.run(async () => 2);
    expect(q.depth).toBeGreaterThanOrEqual(2);
    await Promise.all([p1, p2]);
    expect(q.depth).toBe(0);
  });
});
