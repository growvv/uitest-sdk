import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_VERSION, VERSION } from "../../src/version.js";
import { toolDefinitions } from "../../src/mcp.js";

describe("uitest-phone identity", () => {
  it("reports the phone version and the core version it runs on", () => {
    // Both packages ship 0.10.0 side by side at this release, so the test
    // pins each value to the package it comes from rather than assuming the
    // two differ.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const corePkg = JSON.parse(
      readFileSync(new URL("../../../core/package.json", import.meta.url), "utf8"),
    );
    expect(VERSION).toBe(pkg.version);
    expect(CORE_VERSION).toBe(corePkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("generates one MCP tool per core command", () => {
    expect(toolDefinitions()).toHaveLength(21);
    expect(toolDefinitions()[0]?.name).toMatch(/^uitest_/);
  });
});
