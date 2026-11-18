import { describe, expect, it } from "vitest";
import { CONSOLE_SCRIPT } from "../../src/page.js";

/**
 * A locked phone is the one state where the mirror is legitimately black.
 *
 * The viewer already tells the page (`hello.locked` and `nodes.locked`), and the
 * page ignored it. On the 0.1.1 acceptance run the phone locked itself mid-run:
 * the console showed a black canvas and "reconnecting", and a person watching
 * would have no way to know the phone needed unlocking — they would try
 * Reconnect, then assume the console was broken.
 */
describe("console page: a locked phone", () => {
  it("says the phone is locked rather than showing an unexplained black frame", () => {
    expect(CONSOLE_SCRIPT).toMatch(/locked/);
  });

  it("reads the flag the viewer already sends", () => {
    // Both messages carry it; the page must handle the one it receives.
    expect(CONSOLE_SCRIPT).toMatch(/msg\.locked/);
  });

  it("takes the notice down again when the phone is unlocked", () => {
    // A banner that never clears is worse than none: the person unlocks the
    // phone and is still told it is locked. `setLocked(false)` is the only
    // thing that clears it, so it has to exist and be driven by the flag.
    expect(CONSOLE_SCRIPT).toMatch(/function setLocked\(on\)/);
    expect(CONSOLE_SCRIPT).toMatch(/lockedEl\.className = on \? 'on' : ''/);
  });

  it("reads the lock flag only from the message that carries it", () => {
    // `hello` is sent when a tab attaches and again on reconnects, and it has
    // no `locked` field — the flag lives on `nodes`, which follows each layout
    // poll. Driving the banner from `hello` therefore cleared it every time a
    // tab reconnected, on a phone that was still locked: the person saw the
    // notice disappear while the mirror stayed black.
    expect(CONSOLE_SCRIPT).not.toMatch(/viewer\.on\('hello', function \(msg\) \{ setLocked/);
    expect(CONSOLE_SCRIPT).toMatch(/viewer\.on\('nodes', function \(msg\) \{ setLocked/);
  });
});
