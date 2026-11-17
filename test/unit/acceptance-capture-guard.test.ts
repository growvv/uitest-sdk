import { describe, it, expect } from "vitest";
import { assertCapturable, assertShadeClosed, pressPowerKey } from "../../scripts/acceptance.js";

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

// The `touch` capability starts at (100,100), which is inside the status bar,
// and drags to (120,120): on this ROM that gesture pulls the notification
// shade down. Every later screenshot is then the person's notifications — the
// same leak the lock-screen guard exists to prevent, from a different door.
describe("acceptance capture guard · notification shade", () => {
  function fakeShade(opts: { open: boolean; closes: boolean }) {
    const calls: string[] = [];
    let open = opts.open;
    return {
      calls,
      display: {
        async isShadeOpen() {
          calls.push("isShadeOpen");
          return open;
        },
        async closeShade() {
          calls.push("closeShade");
          if (opts.closes) open = false;
        },
      },
    };
  }

  it("closes an open shade before evidence is captured", async () => {
    const { display, calls } = fakeShade({ open: true, closes: true });

    await assertShadeClosed(display);

    expect(calls).toEqual(["isShadeOpen", "closeShade", "isShadeOpen"]);
  });

  it("leaves a closed shade alone", async () => {
    const { display, calls } = fakeShade({ open: false, closes: true });

    await assertShadeClosed(display);

    expect(calls).toEqual(["isShadeOpen"]);
  });

  // A shade that will not close means the next capture publishes whatever was
  // waiting in it, so the run stops instead.
  it("refuses to capture while the shade is still open", async () => {
    const { display } = fakeShade({ open: true, closes: false });

    await expect(assertShadeClosed(display)).rejects.toThrow(/notification shade/i);
  });
});
