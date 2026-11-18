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

  // `npm publish` runs prepublishOnly, and a package's own `vitest run` has no
  // test files of its own: the root config's include is `packages/*/test`, which
  // matches nothing from inside `packages/console`. Vitest then exits 1, so the
  // release could never be published — found when the first `npm publish` was
  // refused with "No test files found". The hook runs the repo's suite from the
  // root instead.
  it("runs the repo's suite before publishing, not an empty package run", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const hook = String(pkg.scripts?.prepublishOnly ?? "");
    expect(hook).toContain("build");
    expect(hook).not.toMatch(/(^|&&\s*)npm test(\s|$)/);
    expect(hook).toMatch(/--prefix \.\.\/\.\.|-w uitest-console|cd \.\.\/\.\./);
  });
});
