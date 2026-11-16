import { describe, it, expect } from "vitest";
import { On, selectorText, parseKeyName, parseOn } from "../../src/agent/selector.js";

describe("On", () => {
  it("builds the device-side On predicate arguments", () => {
    expect(On.text("WLAN").toArgs()).toEqual(["On.text", ["WLAN", 0], "On#seed"]);
    expect(On.text("WLAN", "contains").toArgs()).toEqual(["On.text", ["WLAN", 1], "On#seed"]);
  });

  it("matches a type name case-sensitively, as the device does", () => {
    expect(On.type("Button").toArgs()).toEqual(["On.type", ["Button"], "On#seed"]);
    // The device's type names are case-sensitive; a lowercase name finds nothing.
    expect(On.type("button").toArgs()).toEqual(["On.type", ["button"], "On#seed"]);
  });

  it("supports the predicates an agent actually needs", () => {
    expect(On.id("id_content").toArgs()).toEqual(["On.id", ["id_content", 0], "On#seed"]);
    expect(On.clickable().toArgs()).toEqual(["On.clickable", [true], "On#seed"]);
    expect(On.scrollable().toArgs()).toEqual(["On.scrollable", [true], "On#seed"]);
    expect(On.enabled().toArgs()).toEqual(["On.enabled", [true], "On#seed"]);
    expect(On.checked().toArgs()).toEqual(["On.checked", [true], "On#seed"]);
    expect(On.focused().toArgs()).toEqual(["On.focused", [true], "On#seed"]);
  });

  it("chains a second predicate onto the previous On reference", () => {
    const first = On.type("Button");
    const chained = On.text("Save", "exact", first);
    expect(chained.toArgs()).toEqual(["On.text", ["Save", 0], first]);
    expect(selectorText(chained)).toBe('type=Button & text="Save"');
  });

  it("describes itself for error messages and approvals", () => {
    expect(selectorText(On.text("删除"))).toBe('text="删除"');
    expect(selectorText(On.type("Button").and(On.clickable()))).toBe("type=Button & clickable=true");
  });

  it("accepts a raw device reference for callers that build On themselves", () => {
    const on = On.raw("On#7", "custom");
    expect(on.toArgs()).toEqual([null, [], "On#7"]);
    expect(selectorText(on)).toBe("custom");
  });
});

describe("parseOn", () => {
  it("parses the one-line form used by the CLI and MCP tools", () => {
    expect(selectorText(parseOn("text=WLAN"))).toBe('text="WLAN"');
    expect(selectorText(parseOn('text~="WLAN"'))).toBe('text~="WLAN"');
    expect(selectorText(parseOn("type=Button"))).toBe("type=Button");
    expect(selectorText(parseOn("id=id_content"))).toBe('id="id_content"');
  });

  it("chains predicates with &", () => {
    expect(selectorText(parseOn("type=Button&text=Save&clickable"))).toBe(
      "type=Button & text=\"Save\" & clickable=true",
    );
  });

  it("rejects an unknown predicate with the accepted list", () => {
    expect(() => parseOn("colour=red")).toThrow(/unknown predicate "colour"/);
    expect(() => parseOn("colour=red")).toThrow(/text=/);
  });

  it("rejects an empty spec", () => {
    expect(() => parseOn("")).toThrow(/empty selector/);
  });

  it("keeps a quoted value that contains & or =", () => {
    expect(selectorText(parseOn('text="A & B = C"'))).toBe('text="A & B = C"');
  });
});

describe("parseKeyName", () => {
  it("maps named keys to HarmonyOS key codes", () => {
    expect(parseKeyName("back")).toBe(2);
    expect(parseKeyName("HOME")).toBe(1);
    expect(parseKeyName("power")).toBe(26);
    expect(parseKeyName("enter")).toBe(2054);
    expect(parseKeyName("escape")).toBe(2070);
    expect(parseKeyName("volume_up")).toBe(16);
    expect(parseKeyName("volume-down")).toBe(17);
  });

  it("passes numeric codes through", () => {
    expect(parseKeyName(26)).toBe(26);
    expect(parseKeyName("26")).toBe(26);
  });

  it("rejects an unknown name with the accepted list", () => {
    expect(() => parseKeyName("f13")).toThrow(/unknown key "f13"/);
    expect(() => parseKeyName("f13")).toThrow(/back/);
  });
});

describe("extended On predicates", () => {
  it("supports the remaining text-like properties", () => {
    expect(selectorText(On.description("Close", "contains"))).toBe('description~="Close"');
    expect(selectorText(On.hint("Search"))).toBe('hint="Search"');
    expect(selectorText(On.accessibilityId("42"))).toBe('accessibilityId="42"');
    expect(selectorText(On.originalText("Hello"))).toBe('originalText="Hello"');
  });

  it("supports the remaining boolean properties", () => {
    expect(selectorText(On.selected())).toBe("selected=true");
    expect(selectorText(On.longClickable())).toBe("longClickable=true");
    expect(selectorText(On.checkable(false))).toBe("checkable=false");
  });

  it("maps every match mode to the device enum", () => {
    expect(On.text("a", "starts_with").toArgs()[1]).toEqual(["a", 2]);
    expect(On.text("a", "ends_with").toArgs()[1]).toEqual(["a", 3]);
    expect(On.text("a", "regex").toArgs()[1]).toEqual(["a", 4]);
    expect(On.text("a", "regex_i").toArgs()[1]).toEqual(["a", 5]);
  });

  it("parses the extended predicates from the CLI form", () => {
    expect(selectorText(parseOn("description=Close&hint~=Search"))).toBe(
      'description="Close" & hint~="Search"',
    );
    expect(selectorText(parseOn("selected&checkable=false"))).toBe(
      "selected=true & checkable=false",
    );
  });
});
