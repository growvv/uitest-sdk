import { describe, it, expect } from "vitest";
import { HYPIIUM_CATALOG } from "../../src/driver/hypium/catalog.js";
import { HypiumDriver } from "../../src/driver/hypium/index.js";
import * as hypium from "../../src/driver/hypium/index.js";

describe("hypium catalog", () => {
  it("contains all 118 public hypium methods", () => {
    expect(HYPIIUM_CATALOG).toHaveLength(118);
    expect(new Set(HYPIIUM_CATALOG.map((e) => e.python)).size).toBe(118);
  });

  it("maps every entry to one SDK member", () => {
    expect(new Set(HYPIIUM_CATALOG.map((e) => e.ts)).size).toBe(118);
    const driver = new HypiumDriver({
      agent: {} as never,
      hdc: {} as never,
      deviceTag: "deadbeef",
    });
    for (const entry of HYPIIUM_CATALOG) {
      expect(driver[entry.ts as keyof HypiumDriver], `${entry.python} → ${entry.ts}`).toBeDefined();
    }
  });

  it("categorises every entry and uses a known status", () => {
    const categories = new Set(HYPIIUM_CATALOG.map((e) => e.category));
    expect(categories.size).toBeGreaterThanOrEqual(18);
    for (const entry of HYPIIUM_CATALOG) {
      expect(["verified", "device", "host", "hardware", "unsupported"]).toContain(entry.status);
    }
  });

  it("exports the public facade and its types from one module", () => {
    expect(hypium.HypiumDriver).toBeTypeOf("function");
    expect(hypium.Gesture).toBeTypeOf("function");
    expect(hypium.HYPIIUM_CATALOG).toHaveLength(118);
  });
});
