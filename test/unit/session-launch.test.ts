import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../../src/operations/session.js";

describe("Session.launch", () => {
  it("refuses a bundle outside the app allow-list before launching", async () => {
    const device = {
      deviceId: "SERIAL",
      agent: {
        async captureLayout() {
          return { attributes: {}, children: [] };
        },
      },
    };
    const session = await Session.open(device as never, {
      lease: false,
      noTrace: true,
      policy: { apps: ["com.demo"] },
    });
    const launched = vi.fn();
    (session as unknown as { apps: unknown }).apps = {
      resolveBundle: async () => "com.bank.app",
      launch: launched,
    };

    const result = await session.launch("com.bank.app");

    expect(result.status).toBe("blocked");
    expect(launched).not.toHaveBeenCalled();
    await session.release();
  });

  it("reports the lease it holds and forgets it after release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-lease-"));
    const session = await Session.open(
      { deviceId: "SERIAL", agent: {} } as never,
      { stateDir: dir, task: "inspect", noTrace: true },
    );
    expect((await session.leaseInfo())?.task).toBe("inspect");
    await session.release();
    expect(await session.leaseInfo()).toBeNull();
  });
});
