import { describe, expect, it } from "vitest";
import { PLAYER_HTML } from "../../src/viewer/player.js";
import { LiveInput } from "../../src/viewer/input.js";
import type { InputLane } from "../../src/input/lane.js";

describe("recents key", () => {
  // The acceptance run settled this: 187 is AOSP's APP_SWITCH, `oh_key_code.h`
  // has no APP_SWITCH, and a real phone ignored 187 along with every native
  // multitask code. A key code would have shipped a button that did nothing,
  // so the page's button sends the system's own bottom-edge hold instead —
  // pinned in `live-input.test.ts`.
  it("is offered by the page", () => {
    expect(PLAYER_HTML).toContain('id="key-recents"');
    expect(PLAYER_HTML).toContain("bindSystemKey('key-recents', 'recents')");
  });

  it("does not send a key code for it", async () => {
    const keys: number[] = [];
    const lane: InputLane = {
      click: async () => undefined,
      touchDown: async () => undefined,
      touchMove: async () => undefined,
      touchUp: async () => undefined,
      key: async (code) => {
        keys.push(code);
      },
      text: async () => undefined,
      pinch: async () => undefined,
      scroll: async () => undefined,
    };
    const input = new LiveInput({
      lane,
      bounds: () => ({ width: 400, height: 800 }),
      sleep: async () => undefined,
    });
    input.key("recents");
    await new Promise((r) => setTimeout(r, 20));
    expect(keys).toEqual([]);
  });
});
