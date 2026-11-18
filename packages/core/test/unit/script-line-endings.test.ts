import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPTS = new URL("../../../../scripts/", import.meta.url);

/**
 * A shebang line followed by CRLF breaks the transform Vitest runs on an
 * imported script: `#!/usr/bin/env node\r\nexport const x = 1` parses as
 * "Invalid or unexpected token". CI checks out LF and passes; a Windows
 * checkout with `core.autocrlf=true` writes CRLF and the whole suite fails on
 * files nobody edited. The repository therefore pins these scripts to LF in
 * `.gitattributes`, and this test keeps that pin honest.
 */
describe("scripts the tests import", () => {
  const shebanged = readdirSync(SCRIPTS)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => ({ name, body: readFileSync(new URL(name, SCRIPTS), "utf8") }))
    .filter((file) => file.body.startsWith("#!"));

  it("finds the scripts to check", () => {
    // A glob that matches nothing would make the assertions below vacuous.
    expect(shebanged.map((f) => f.name)).toContain("gen-acceptance-pages.mjs");
  });

  it("carries no CRLF, so a Windows checkout still parses", () => {
    const bad = shebanged.filter((f) => f.body.includes("\r\n")).map((f) => f.name);
    expect(bad).toEqual([]);
  });

  it("is pinned to LF in .gitattributes", () => {
    // The pin is tree-wide: every checkout must agree with CI, and exact-text
    // comparisons in tests and acceptance tooling fail silently on a CRLF
    // copy. A line that matches only some paths would leave the rest free to
    // drift back.
    const attrs = readFileSync(new URL("../../../../.gitattributes", import.meta.url), "utf8");
    const lines = attrs.split(/\r?\n/).map((l) => l.trim());
    const pinned = lines.some(
      (l) => !l.startsWith("#") && l.startsWith("*") && /(^|\s)eol=lf(\s|$)/.test(l),
    );
    expect(pinned).toBe(true);
  });
});
