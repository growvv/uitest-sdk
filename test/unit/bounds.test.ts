import { describe, it, expect } from "vitest";
import { parseBounds, cropRect } from "../../src/util/bounds.js";

describe("parseBounds", () => {
  it("parses the device format", () => {
    expect(parseBounds("[0,0][1216,2688]")).toEqual({ x: 0, y: 0, width: 1216, height: 2688 });
  });
  it("parses an offset rect", () => {
    expect(parseBounds("[79,804][1136,2262]")).toEqual({ x: 79, y: 804, width: 1057, height: 1458 });
  });
  it("returns null for empty or malformed input", () => {
    expect(parseBounds("")).toBeNull();
    expect(parseBounds("garbage")).toBeNull();
    expect(parseBounds("[1,2]")).toBeNull();
  });
});

describe("cropRect", () => {
  it("clamps to the outer rect", () => {
    expect(cropRect({ x: -10, y: -10, width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 50 }))
      .toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
  it("returns a zero rect when fully outside", () => {
    expect(cropRect({ x: 200, y: 200, width: 10, height: 10 }, { x: 0, y: 0, width: 50, height: 50 }))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
