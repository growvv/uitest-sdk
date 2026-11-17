import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import * as sdk from "../../src/index.js";

/**
 * The root entry is deliberately small. Everything beyond connect and the
 * category-shaped session has a subpath, so an accidental `export *` or a
 * convenience re-export is a design regression, not a nicety: the root is what
 * every consumer loads, and it must not grow back into the old 130-name barrel.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every `export class …Error` declared in `src/transport/errors.ts`, in file order. */
function errorClassNames(): string[] {
  return [...read("src/transport/errors.ts").matchAll(/^export class (\w+Error)\b/gm)].map((m) => m[1]!);
}

/** Every name the root barrel publishes at runtime (type-only exports are erased). */
function rootValueNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^export \{([^}]*)\} from/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

const BASE = ["connect", "connectDevice", "Session", "Device", "tagOf", "VERSION"];

describe("package entry", () => {
  it("parses the error classes out of errors.ts", () => {
    // Guards the tests below: a regex that matched nothing would make them
    // vacuously true.
    const names = errorClassNames();
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("UitestError");
  });

  it("exports exactly the small root set", () => {
    const expected = new Set([...BASE, ...errorClassNames()]);
    const actual = Object.keys(sdk);
    expect(actual.sort()).toEqual([...expected].sort());
  });

  it("publishes every error class as a constructor, so `instanceof` works", () => {
    for (const name of errorClassNames()) {
      expect(typeof (sdk as Record<string, unknown>)[name], `${name} is not a class`).toBe("function");
    }
  });

  it("keeps the root at or below 20 runtime exports", () => {
    expect(Object.keys(sdk).length).toBeLessThanOrEqual(20);
  });

  it("does not publish a name twice in the source barrel", () => {
    // Two `export { X } from` lines for one name is a silent shadowing bug: the
    // later one wins and the first module's value is unreachable.
    const names = rootValueNames(read("src/index.ts"));
    const seen = new Set<string>();
    const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes).toEqual([]);
  });

  it("imports every subpath and publishes the advanced surface there", async () => {
    const commands = await import("../../src/exports/commands.js");
    expect(typeof commands.CommandRunner).toBe("function");
    expect(Array.isArray(commands.COMMANDS)).toBe(true);
    expect(typeof commands.parseArgv).toBe("function");
    expect(typeof commands.exitCodeForError).toBe("function");
    // The roots stays small: these names are subpath-only.
    expect("COMMANDS" in sdk).toBe(false);
    expect("CommandRunner" in sdk).toBe(false);

    const cast = await import("../../src/exports/cast.js");
    expect(typeof cast.createCast).toBe("function");
    expect(typeof cast.CastConfig).toBe("function");
    expect(typeof cast.FpsMeter).toBe("function");
    expect("createCast" in sdk).toBe(false);

    const viewer = await import("../../src/exports/viewer.js");
    expect(typeof viewer.startViewerServer).toBe("function");
    expect(typeof viewer.renderPlayerPage).toBe("function");
    expect(typeof viewer.openInput).toBe("function");
    expect("startViewerServer" in sdk).toBe(false);

    const govern = await import("../../src/exports/govern.js");
    expect(typeof govern.Policy).toBe("function");
    expect(typeof govern.Approvals).toBe("function");
    expect(typeof govern.readRecentTrace).toBe("function");
    expect("Policy" in sdk).toBe(false);

    const drivers = await import("../../src/exports/drivers.js");
    expect(typeof drivers.Device).toBe("function");
    expect(typeof drivers.HypiumDriver).toBe("function");
    expect(typeof drivers.AgentDriver).toBe("function");
    expect("HypiumDriver" in sdk).toBe(false);
  });

  it("maps every subpath to a built file in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./cast",
      "./commands",
      "./drivers",
      "./govern",
      "./viewer",
    ]);
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      expect(entry.types, `${subpath} types`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(entry.import, `${subpath} import`).toMatch(/^\.\/dist\/.+\.js$/);
    }
  });
});
