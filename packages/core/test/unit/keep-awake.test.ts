import { describe, expect, it, vi } from "vitest";
import { keepAwake } from "../../src/keep-awake.js";

describe("keepAwake", () => {
  it("sets the timeout once and restores it once", async () => {
    const set = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const handle = await keepAwake({ setSleepTime: set, restoreSleepTime: restore }, 3600);
    expect(set).toHaveBeenCalledWith(3600);
    expect(restore).not.toHaveBeenCalled();
    await handle.restore();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  // The close path calls restore even when the person never asked to keep the
  // screen awake, and a second call must not reach the device again.
  it("restores only once", async () => {
    const restore = vi.fn(async () => undefined);
    const handle = await keepAwake({ setSleepTime: async () => undefined, restoreSleepTime: restore }, 60);
    await handle.restore();
    await handle.restore();
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
