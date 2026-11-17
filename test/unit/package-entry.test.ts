import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import * as sdk from "../../src/index.js";
import { DeviceStateError } from "../../src/transport/errors.js";

/**
 * The package entry, `src/index.ts`, is the only thing an `import "uitest-sdk"`
 * reaches — `package.json` maps the root export to `dist/index.js` and nothing
 * else. So a name that exists in `src/transport/errors.ts` but is missing here is not
 * exported at all: no amount of reading the docs would tell you why
 * `instanceof sdk.DeviceStateError` throws.
 *
 * These tests read the source rather than a hand-written list, so a class added
 * to `errors.ts` later cannot quietly miss the barrel.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every `export class …Error` declared in `src/transport/errors.ts`, in file order. */
function errorClassNames(): string[] {
  return [...read("src/transport/errors.ts").matchAll(/^export class (\w+Error)\b/gm)].map((m) => m[1]!);
}

/** Every name the barrel's `export { … }` statements publish at runtime. */
function barrelValueNames(): string[] {
  const source = read("src/index.ts");
  const names: string[] = [];
  for (const m of source.matchAll(/^export \{([^}]*)\} from/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("package entry", () => {
  it("parses the error classes out of errors.ts", () => {
    // Guards the two tests below: a regex that matched nothing would make them
    // vacuously true.
    const names = errorClassNames();
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("UitestError");
  });

  it("exports every error class, so `instanceof` works from the package root", () => {
    const missing = errorClassNames().filter((name) => !(name in sdk));
    expect(missing, `not exported from src/index.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("publishes every error class as a constructor, not just a type", () => {
    for (const name of errorClassNames()) {
      const ctor = (sdk as Record<string, unknown>)[name];
      expect(typeof ctor, `${name} is exported but is not a class`).toBe("function");
    }
  });

  it("exports DeviceStateError with its state carried through", () => {
    // The one class that was missing. Its `state` is what a caller branches on,
    // so it is the reason the class exists at all.
    const e = new DeviceStateError("device_locked", "phone is locked", "ENODEVICE");
    expect(e).toBeInstanceOf(sdk.DeviceStateError);
    expect(e).toBeInstanceOf(sdk.DeviceNotConnectedError);
    expect(e).toBeInstanceOf(sdk.UitestError);
    expect(e.state).toBe("device_locked");
    expect(e.code).toBe("ENODEVICE");
  });

  it("resolves every name the barrel publishes", () => {
    // A re-export of a name that no longer exists is a type error but survives
    // a stale build; at runtime it is `undefined` and fails at the call site.
    const names = barrelValueNames();
    expect(names.length).toBeGreaterThan(80);
    const unresolved = names.filter((name) => (sdk as Record<string, unknown>)[name] === undefined);
    expect(unresolved, `exported but undefined at runtime: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("does not publish a name twice", () => {
    // Two `export { X } from` lines for one name is a silent shadowing bug: the
    // later one wins and the first module's value is unreachable.
    const names = barrelValueNames();
    const seen = new Set<string>();
    const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes).toEqual([]);
  });
});
