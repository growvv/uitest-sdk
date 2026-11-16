import { describe, it, expect } from "vitest";
import { assertCapturable, pressPowerKey } from "../../scripts/acceptance.js";

/** A stand-in for `dev.hypium`: only the two calls the guard uses. */
function fakeDisplay(opts: { locked: boolean; unlockWorks: boolean }) {
  const calls: string[] = [];
  let locked = opts.locked;
  return {
    calls,
    display: {
      async isDisplayLocked() {
        calls.push("isDisplayLocked");
        return locked;
      },
      async unlock() {
        calls.push("unlock");
        if (opts.unlockWorks) locked = false;
      },
    },
  };
}

describe("acceptance capture guard", () => {
  it("unlocks a sleeping phone before anything is captured", async () => {
    const { display, calls } = fakeDisplay({ locked: true, unlockWorks: true });

    await assertCapturable(display);

    expect(calls).toEqual(["isDisplayLocked", "unlock", "isDisplayLocked"]);
  });

  it("leaves an already usable screen alone", async () => {
    const { display, calls } = fakeDisplay({ locked: false, unlockWorks: true });

    await assertCapturable(display);

    expect(calls).toEqual(["isDisplayLocked"]);
  });

  // The lock screen is where a real person's messages, bank alerts and
  // delivery notices are. Capturing it writes them into docs/acceptance, which
  // is committed and published. A swipe cannot clear a PIN, so the only safe
  // outcome is to stop and say so.
  it("refuses to capture a phone that is still locked", async () => {
    const { display } = fakeDisplay({ locked: true, unlockWorks: false });

    await expect(assertCapturable(display)).rejects.toThrow(/lock screen/i);
  });

  // The capability exists to prove the power key reaches the device. Taking a
  // picture of the lock screen it just caused proves nothing and publishes
  // whatever notifications were waiting there.
  it("presses the power key but leaves the screen usable", async () => {
    const { display, calls } = fakeDisplay({ locked: true, unlockWorks: true });
    const pressed: number[] = [];

    await pressPowerKey({
      pressKey: async (code: number) => void pressed.push(code),
      ...display,
    });

    expect(pressed).toEqual([26]);
    expect(calls).toContain("unlock");
    expect(await display.isDisplayLocked()).toBe(false);
  });
});
