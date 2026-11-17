import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_VERSION, VERSION } from "../../src/version.js";
import { CONSOLE_SCRIPT } from "../../src/page.js";

describe("uitest-console identity", () => {
  it("reports the console version and the core version it runs on", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const corePkg = JSON.parse(
      readFileSync(new URL("../../../core/package.json", import.meta.url), "utf8"),
    );
    expect(VERSION).toBe(pkg.version);
    expect(CORE_VERSION).toBe(corePkg.version);
  });

  it("is a product, not a second player", () => {
    // The console reuses core's page; its own script only adds the inbox,
    // hold and activity. A decoder here would be the second implementation the
    // architecture forbids.
    expect(CONSOLE_SCRIPT).not.toContain("VideoDecoder");
    expect(CONSOLE_SCRIPT).not.toContain("new WebSocket");
    expect(CONSOLE_SCRIPT).not.toContain("getContext");
  });
});
