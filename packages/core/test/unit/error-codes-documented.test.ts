import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every error code a caller can receive is in the documented table.
 *
 * The project promises "every failure is a `UitestError` subclass with a stable
 * code", and a caller's whole strategy — retry, ask the person, give up — is a
 * switch on that code. A code that is thrown but not listed is one nobody can
 * look up, and the cross-check found 25 of them.
 */
const SRC = join(import.meta.dirname, "../../src");
const DOC = join(import.meta.dirname, "../../docs/api.md");

/** Node's own errno for "already exists"; not a code this project defines. */
const NOT_OURS = new Set(["EEXIST"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Codes passed as the `code` argument of an error constructor. */
function thrownCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    // `new SomethingError("message", "ECODE", cause?)` and the two-line form.
    for (const m of text.matchAll(/new\s+\w*Error\(\s*[\s\S]{0,400}?"(E[A-Z0-9]+)"/g)) {
      codes.add(m[1]!);
    }
  }
  return codes;
}

function documentedCodes(): Set<string> {
  const text = readFileSync(DOC, "utf8");
  const codes = new Set<string>();
  for (const m of text.matchAll(/`(E[A-Z0-9]+)`/g)) codes.add(m[1]!);
  return codes;
}

describe("error taxonomy", () => {
  it("documents every code an error can carry", () => {
    const documented = documentedCodes();
    const missing = [...thrownCodes()].filter((c) => !NOT_OURS.has(c) && !documented.has(c)).sort();
    expect(missing, `codes thrown but not in docs/api.md: ${missing.join(", ")}`).toEqual([]);
  });
});
