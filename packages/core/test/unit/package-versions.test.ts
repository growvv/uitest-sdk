import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../../../packages/${p}/package.json`, import.meta.url), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };
const PRODUCTS = ["phone", "console", "mirror"];

describe("workspace versions", () => {
  // npm resolves a workspace range that does not match the workspace's own
  // version from the registry, so a missed bump breaks the install instead of
  // the build — and only for the people installing it.
  it("pins every product to the core it ships beside", () => {
    const core = read("core").version;
    for (const p of PRODUCTS) {
      expect(read(p).dependencies?.["uitest-sdk"], p).toBe(`~${core}`);
    }
  });
});
