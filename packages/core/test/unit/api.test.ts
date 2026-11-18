import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connect } from "../../src/api.js";
import { Device } from "../../src/driver/device.js";
import { Session as CoreSession } from "../../src/operations/session.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (type: string, attrs: Record<string, unknown>, children: UiNode[] = []): UiNode => ({
  attributes: { type, ...attrs } as UiNode["attributes"],
  children,
});

function fakeDevice() {
  const tree = node("Root", { bounds: "[0,0][1000,2000]", bundleName: "com.demo" }, [
    node("Button", { text: "OK", bounds: "[100,200][300,400]", clickable: "true" }),
  ]);
  return {
    deviceId: "SERIAL0123456789",
    agent: {
      async captureLayout() {
        return tree;
      },
      async getDisplaySize() {
        return { width: 1000, height: 2000 };
      },
      async getDisplayRotation() {
        return 0;
      },
    },
    async dispose() {},
  };
}

describe("connect", () => {
  it("returns a session whose observe namespace reads the screen", async () => {
    const device = fakeDevice();
    vi.spyOn(Device, "connect").mockResolvedValue(device as never);
    const session = await connect({
      stateDir: mkdtempSync(join(tmpdir(), "uitest-api-")),
      lease: false,
      noTrace: true,
    });

    const screen = await session.observe.layout();

    expect(screen.bundle).toBe("com.demo");
    expect(session.observe).toBeTypeOf("function");
    await session.close();
    vi.restoreAllMocks();
  });

  it("disposes the device when the session cannot open", async () => {
    const dispose = vi.fn(async () => undefined);
    vi.spyOn(Device, "connect").mockResolvedValue({ dispose } as never);
    vi.spyOn(CoreSession, "open").mockRejectedValueOnce(new Error("open failed"));

    await expect(connect({ lease: false })).rejects.toThrow("open failed");
    expect(dispose).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  /**
   * The changelog promised `close()` restores a keep-awake, and it did not:
   * a caller that asked for one and closed the session left a one-hour
   * override on the phone with nothing left to undo it.
   */
  it("restores a keep-awake it handed out when the session closes", async () => {
    const restoreSleepTime = vi.fn(async () => undefined);
    const device = {
      ...fakeDevice(),
      hypium: {
        async setSleepTime() {
          return undefined;
        },
        restoreSleepTime,
      },
    };
    vi.spyOn(Device, "connect").mockResolvedValue(device as never);
    const session = await connect({
      stateDir: mkdtempSync(join(tmpdir(), "uitest-api-")),
      lease: false,
      noTrace: true,
    });

    await session.keepAwake(3600);
    expect(restoreSleepTime).not.toHaveBeenCalled();
    await session.close();
    expect(restoreSleepTime).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("does not restore twice when the caller already did", async () => {
    const restoreSleepTime = vi.fn(async () => undefined);
    const device = {
      ...fakeDevice(),
      hypium: {
        async setSleepTime() {
          return undefined;
        },
        restoreSleepTime,
      },
    };
    vi.spyOn(Device, "connect").mockResolvedValue(device as never);
    const session = await connect({
      stateDir: mkdtempSync(join(tmpdir(), "uitest-api-")),
      lease: false,
      noTrace: true,
    });

    const handle = await session.keepAwake(3600);
    await handle.restore();
    await session.close();
    expect(restoreSleepTime).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
