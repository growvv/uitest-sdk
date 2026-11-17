import { describe, it, expect } from "vitest";
import {
  assertCapturable,
  assertShadeClosed,
  pressPowerKey,
  stageNeutralSurface,
  NEUTRAL_APP,
} from "../../../../scripts/acceptance.js";

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
// The acceptance screenshots are committed and published, and the phone is
// whatever the person left open. A real run photographed a Zhihu feed with a
// named author on it, and the system Settings root carries the signed-in
// account and the device's own name. Neither is the SDK's business, so the run
// stages a neutral surface for its duration and puts the app back afterwards.
describe("acceptance capture guard · the surface under test", () => {
  function fakeApps(front: { bundle: string; ability?: string } | null) {
    const launched: string[] = [];
    return {
      launched,
      apps: {
        async current() {
          return front;
        },
        async launch(app: string) {
          launched.push(app);
          return { bundle: app, ability: "A", output: "" };
        },
      },
    };
  }

  it("opens a neutral app and brings the person's app back afterwards", async () => {
    const { apps, launched } = fakeApps({ bundle: "com.zhihu.hmos", ability: "PhoneAbility" });

    const staged = await stageNeutralSurface(apps);
    expect(launched).toEqual([NEUTRAL_APP]);

    await staged.restore();
    expect(launched).toEqual([NEUTRAL_APP, "com.zhihu.hmos"]);
  });

  it("still stages a surface when nothing was in front", async () => {
    const { apps, launched } = fakeApps(null);

    const staged = await stageNeutralSurface(apps);
    await staged.restore();

    // Restoring "nothing" must not launch anything.
    expect(launched).toEqual([NEUTRAL_APP]);
  });

  it("carries the ability through when the app is brought back", async () => {
    // The captured app is relaunched with the ability it was running: a
    // bundle alone starts its entry ability, which on a tablet is a different
    // window than the one the run started from.
    const calls: Array<{ app: string; opts?: { ability?: string } }> = [];
    const apps = {
      async current() {
        return { bundle: "com.zhihu.hmos", ability: "PhoneAbility" };
      },
      async launch(app: string, opts?: { ability?: string }) {
        calls.push({ app, opts });
        return { bundle: app, ability: "A", output: "" };
      },
    };

    const staged = await stageNeutralSurface(apps);
    await staged.restore();

    expect(calls[1]).toEqual({ app: "com.zhihu.hmos", opts: { ability: "PhoneAbility" } });
  });
});

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

  it("waits for a shade that is still animating closed", async () => {
    // The window manager reports the shade for a beat after BACK is pressed:
    // on a phone, `closeShade()` returned in 208 ms and the next read still
    // said open, so the guard failed a run whose shade had in fact closed.
    // A single re-read turns that into a race with the compositor.
    let reads = 0;
    let lingering = 0;
    const display = {
      async isShadeOpen() {
        reads++;
        // Open at the first read; after `closeShade()` the window lingers for
        // a few more reads, the way the real compositor reports it.
        if (reads === 1) return true;
        return lingering > 0 ? (lingering--, true) : false;
      },
      async closeShade() {
        lingering = 3;
      },
    };
    await assertShadeClosed(display, { pollMs: 1 });
    expect(reads).toBeGreaterThan(3);
  });

  it("still refuses when the shade never closes", async () => {
    // The wait must not become a retry-forever: a shade that stays open is
    // still a reason to stop.
    const display = {
      async isShadeOpen() {
        return true;
      },
      async closeShade() {},
    };
    await expect(assertShadeClosed(display)).rejects.toThrow(/notification shade/i);
  });
});
