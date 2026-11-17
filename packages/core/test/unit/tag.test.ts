import { describe, expect, it } from "vitest";
import { deviceTag, tagOf } from "../../src/transport/tag.js";

describe("tagOf", () => {
  it("hashes a serial to 8 lowercase hex characters", () => {
    expect(tagOf("SYNTH0DEVICE0001")).toMatch(/^[0-9a-f]{8}$/);
    expect(tagOf("SYNTH0DEVICE0001")).toBe(tagOf("SYNTH0DEVICE0001"));
    expect(tagOf("SYNTH0DEVICE0001")).not.toBe(tagOf("SYNTH0DEVICE0002"));
  });

  it("uses one placeholder for every absent-device spelling", () => {
    expect(tagOf(undefined)).toBe("nodevice");
    expect(tagOf(null)).toBe("nodevice");
    expect(deviceTag(null)).toBe("nodevice");
  });
});
