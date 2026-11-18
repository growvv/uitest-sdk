import { describe, expect, it } from "vitest";
import { mirrorOptions, windowSizeFor } from "../../src/cli.js";

describe("mirrorOptions", () => {
  it("maps --serial to the device, not to a swallowed global flag", () => {
    // The console reads `--device` out of a parser that files global flags
    // separately; a missed merge once pointed a two-device run at the wrong
    // phone. Mirror parses its own argv, so `--serial` can only mean one thing.
    expect(mirrorOptions({ serial: "ABC123" }).serial).toBe("ABC123");
  });

  it("rejects an unknown flag", () => {
    expect(() => mirrorOptions({ device: "ABC123" })).toThrow(/unknown/);
  });

  it("rejects a frame rate the extension does not accept", () => {
    // The extension silently falls back to "follow the display refresh" for
    // any other value, so a person who typed 45 would get 60 and believe 45.
    expect(() => mirrorOptions({ "max-fps": "45" })).toThrow(/15, 30, 60 or 120/);
  });

  it("defaults the port to 0 so two mirrors do not collide", () => {
    expect(mirrorOptions({}).port).toBe(0);
  });

  it("turns control off with --no-control", () => {
    expect(mirrorOptions({ noControl: true }).control).toBe(false);
  });

  it("names the window after --window-title", () => {
    expect(mirrorOptions({ "window-title": "Pixel" }).windowTitle).toBe("Pixel");
  });

  it("defaults to the bundled grpc transport", () => {
    expect(mirrorOptions({}).transport).toBe("grpc");
  });

  it("rejects a transport it does not have", () => {
    expect(() => mirrorOptions({ transport: "hls" })).toThrow(/grpc, ws or mjpeg/);
  });

  it("carries --max-size and --bit-rate through as numbers", () => {
    const opts = mirrorOptions({ "max-size": "1024", "bit-rate": "4000000" });
    expect(opts.maxSize).toBe(1024);
    expect(opts.bitRate).toBe(4_000_000);
  });

  it("rejects a non-numeric --max-size rather than sending NaN to the device", () => {
    expect(() => mirrorOptions({ "max-size": "big" })).toThrow(/number/);
  });
});

describe("windowSizeFor", () => {
  it("keeps a phone's aspect ratio at 900 high", () => {
    expect(windowSizeFor(1260, 2720)).toBe("400,900");
  });

  // The floor is 300 rather than 500: a 9:20 phone at 900 high is 405 wide,
  // and a 500 floor would letterbox every phone this tool exists for.
  it("never goes below 300 wide or above 1400", () => {
    expect(windowSizeFor(5000, 900)).toBe("1400,900");
    expect(windowSizeFor(200, 2720)).toBe("300,900");
  });
});
