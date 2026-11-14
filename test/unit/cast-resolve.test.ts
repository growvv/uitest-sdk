import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCastingExtension } from "../../src/cast/resolve.js";

describe("resolveCastingExtension", () => {
  it("returns the extension path on arm64", () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-"));
    mkdirSync(join(dir, "arm64"));
    writeFileSync(join(dir, "arm64", "libscreen_casting.z.so"), "");
    expect(resolveCastingExtension("arm64", dir)).toBe(join(dir, "arm64", "libscreen_casting.z.so"));
  });

  it("returns null on x86_64 (no build exists)", () => {
    expect(resolveCastingExtension("x86_64", "/ext")).toBeNull();
  });

  it("returns null on arm64 when the file is absent", () => {
    expect(resolveCastingExtension("arm64", "/nonexistent")).toBeNull();
  });

  it("returns null on arm64 when no extension dir is configured", () => {
    expect(resolveCastingExtension("arm64")).toBeNull();
  });
});
