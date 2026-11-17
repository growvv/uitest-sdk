import { describe, expect, it } from "vitest";
import { Device } from "../../src/driver/device.js";

describe("Device surface", () => {
  it("owns connection, not transport policy", () => {
    expect("createCast" in Device.prototype).toBe(false);
    expect("openInputLane" in Device.prototype).toBe(false);
    expect("dispose" in Device.prototype).toBe(true);
  });
});
