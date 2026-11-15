import { describe, it, expect } from "vitest";
import { DevicePool } from "../../src/pool.js";
import { LeaseHeldError } from "../../src/errors.js";

function fakeDevice(id: string) {
  const disposals: string[] = [];
  return {
    id,
    disposals,
    async dispose() {
      disposals.push(id);
    },
  };
}

describe("DevicePool", () => {
  it("connects once and reuses the device", async () => {
    let connects = 0;
    const pool = new DevicePool(async (id) => {
      connects++;
      return fakeDevice(id ?? "default");
    });
    const a = await pool.get();
    const b = await pool.get();
    expect(a).toBe(b);
    expect(connects).toBe(1);
    expect(pool.size).toBe(1);
  });

  it("keeps one device per id", async () => {
    const pool = new DevicePool(async (id) => fakeDevice(id ?? "default"));
    const a = await pool.get("A");
    const b = await pool.get("B");
    expect(a).not.toBe(b);
    expect(pool.size).toBe(2);
    expect(pool.ids()).toEqual(["A", "B"]);
  });

  it("shares one in-flight connection between concurrent callers", async () => {
    let connects = 0;
    const pool = new DevicePool(async (id) => {
      connects++;
      await new Promise((r) => setTimeout(r, 10));
      return fakeDevice(id ?? "default");
    });
    const [a, b] = await Promise.all([pool.get("A"), pool.get("A")]);
    expect(a).toBe(b);
    expect(connects).toBe(1);
  });

  it("releases every device on close", async () => {
    const pool = new DevicePool(async (id) => fakeDevice(id ?? "default"));
    const a = await pool.get("A");
    const b = await pool.get("B");
    await pool.close();
    expect((a as unknown as { disposals: string[] }).disposals).toEqual(["A"]);
    expect((b as unknown as { disposals: string[] }).disposals).toEqual(["B"]);
    expect(pool.size).toBe(0);
  });

  it("does not cache a failed connection", async () => {
    let attempts = 0;
    const pool = new DevicePool(async (id) => {
      attempts++;
      if (attempts === 1) throw new Error("boom");
      return fakeDevice(id ?? "default");
    });
    await expect(pool.get("A")).rejects.toThrow(/boom/);
    await pool.get("A");
    expect(attempts).toBe(2);
  });

  it("removes a device that was disposed elsewhere", async () => {
    const pool = new DevicePool(async (id) => fakeDevice(id ?? "default"));
    await pool.get("A");
    await pool.drop("A");
    expect(pool.size).toBe(0);
  });

  it("passes the id through to the connect function", async () => {
    const seen: (string | undefined)[] = [];
    const pool = new DevicePool(async (id) => {
      seen.push(id);
      return fakeDevice(id ?? "default");
    });
    await pool.get();
    await pool.get("B");
    expect(seen).toEqual([undefined, "B"]);
  });

  it("surfaces a lease conflict as LeaseHeldError from the caller", async () => {
    // The pool itself does not take leases; a session does. This test pins the
    // error type a caller should expect to propagate through the pool.
    const pool = new DevicePool(async () => {
      throw new LeaseHeldError('lease_held · task "x"', "ELEASE");
    });
    await expect(pool.get("A")).rejects.toBeInstanceOf(LeaseHeldError);
  });
});
