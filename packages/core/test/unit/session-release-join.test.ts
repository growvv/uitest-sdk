import { describe, expect, it } from "vitest";
import { Session } from "../../src/operations/session.js";

/**
 * `Session.release()` marked itself released and returned before the device
 * was disposed. Two callers — `session.close()` racing a supervisor's own
 * shutdown, or a product's `close()` beside the CLI's — could both await
 * `release()`, and the second one resolved immediately: the process was then
 * free to exit while the device daemon and its port forward were still being
 * released.
 */
describe("Session.release", () => {
  it("makes a second release wait for the first", async () => {
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let disposes = 0;
    const device = {
      deviceId: "SERIAL0123456789",
      agent: {
        async captureLayout() {
          throw new Error("not used");
        },
        async getDisplaySize() {
          return { width: 1000, height: 2000 };
        },
        async getDisplayRotation() {
          return 0;
        },
      },
      async dispose() {
        disposes++;
        await gate;
      },
    };

    const s = await Session.open(device as never, { lease: false, noTrace: true });
    const first = s.release();
    await new Promise((r) => setTimeout(r, 20));
    let secondDone = false;
    const second = s.release().then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    // The first release is still inside `device.dispose()`.
    expect(secondDone).toBe(false);

    open();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    // One dispose, not two: the second caller joined the first.
    expect(disposes).toBe(1);
  });
});
