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

  /**
   * `maxSize` is an upper bound, and the mjpeg fraction is rounded to two
   * decimals — 1014/2560 rounds up to 0.40, which is a 1024 px frame, larger
   * than the 1014 the person asked for. The grpc path already refuses what it
   * cannot reach; this one must not quietly overshoot.
   */
  it("mjpeg: rounds down, so the frame never exceeds maxSize", () => {
    expect(resolveCastScale("mjpeg", 2560, { maxSize: 1014 })).toBe(0.39);
    expect(resolveCastScale("mjpeg", 2560, { maxSize: 1024 })).toBe(0.4);
  });

  it("mjpeg: refuses a size below the smallest fraction instead of clamping", () => {
    // 0.05 is the floor; 50 px on a 2560 display would need 0.019. A clamped
    // 128 px picture is not what was asked for, so say so.
    expect(() => resolveCastScale("mjpeg", 2560, { maxSize: 50 })).toThrow(/EBADARG|0\.05|128/);
  });
});
