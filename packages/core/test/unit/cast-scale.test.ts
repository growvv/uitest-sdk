import { describe, expect, it } from "vitest";
import { resolveCastScale } from "../../src/cast/scale.js";

describe("resolveCastScale", () => {
  // The extension takes an integer divisor, 1..5.
  it.each([
    [2720, 1024, 3],
    [2720, 2720, 1],
    [2720, 5000, 1],
    [2720, 900, 4],
  ])("grpc: longest %i at max %i -> divisor %i", (longest, maxSize, want) => {
    expect(resolveCastScale("grpc", longest, { maxSize })).toBe(want);
  });

  // MJPEG's scale is a fraction, so the same maxSize means something else.
  it("mjpeg: a fraction, not a divisor", () => {
    expect(resolveCastScale("mjpeg", 2720, { maxSize: 1360 })).toBe(0.5);
    expect(resolveCastScale("mjpeg", 2720, { maxSize: 5000 })).toBe(1);
  });

  // A person asking for a size the extension cannot reach gets told, not a
  // silently clamped picture that is twice what they asked for.
  it("refuses a size below what a 5x shrink can reach", () => {
    expect(() => resolveCastScale("grpc", 2720, { maxSize: 300 })).toThrow(/544/);
  });

  it("refuses scale and maxSize together", () => {
    expect(() => resolveCastScale("grpc", 2720, { scale: 2, maxSize: 1024 })).toThrow(/EBADARG|both/);
  });

  it("passes an explicit scale through untouched", () => {
    expect(resolveCastScale("grpc", 2720, { scale: 2 })).toBe(2);
    expect(resolveCastScale("mjpeg", 2720, { scale: 0.25 })).toBe(0.25);
  });
});
