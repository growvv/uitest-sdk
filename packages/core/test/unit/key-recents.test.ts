import { describe, expect, it } from "vitest";
import { parseKeyName } from "../../src/driver/agent/selector.js";
import { PLAYER_HTML } from "../../src/viewer/player.js";

describe("recents key", () => {
  // KEYCODE_APP_SWITCH from oh_key_code.h. It is the one key in this change
  // with no measurement behind it yet, which is why the acceptance run tests it
  // on a device before 0.1.0 ships.
  it("names 187", () => {
    expect(parseKeyName("recents")).toBe(187);
  });

  it("is offered by the page", () => {
    expect(PLAYER_HTML).toContain('id="key-recents"');
    expect(PLAYER_HTML).toContain("bindSystemKey('key-recents', 'recents')");
  });
});
