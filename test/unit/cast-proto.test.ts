import { describe, it, expect } from "vitest";
import { loadScrcpyService } from "../../src/cast/client.js";

describe("scrcpy proto", () => {
  it("loads the service without a package prefix", () => {
    const svc = loadScrcpyService();
    expect(Object.keys(svc.service).sort()).toEqual(["onEnd", "onRequestIDRFrame", "onStart"]);
  });
  it("onStart is server-streaming", () => {
    expect(loadScrcpyService().service.onStart.responseStream).toBe(true);
  });
  it("onEnd is unary", () => {
    expect(loadScrcpyService().service.onEnd.responseStream).toBe(false);
  });
});
