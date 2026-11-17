import { describe, expect, it, vi } from "vitest";
import { createViewerSource } from "../../src/viewer/source.js";
import type { Screen } from "../../src/driver/agent/screen.js";

function fakes() {
  const setRedact = vi.fn();
  const read = vi.fn(async (): Promise<Screen> => ({
    header: "",
    bundle: "com.demo",
    display: { width: 1080, height: 2340 },
    rotation: 0,
    elements: [],
    lines: [],
    hash: "h",
    signatures: new Set(),
    tree: { attributes: {}, children: [] },
    at: 0,
  }));
  const observe = vi.fn(async () => ({ status: "settled" }));
  const session = { reader: { builder: { setRedact }, read }, observe };
  const device = {
    deviceId: "SERIAL",
    agent: { getDisplaySize: async () => ({ width: 1080, height: 2340 }) },
  };
  return { session, device, setRedact, read, observe };
}

describe("createViewerSource", () => {
  it("toggles redaction with the privacy flag the page sent", async () => {
    const f = fakes();
    const source = createViewerSource(f.session as never, f.device as never, { stateDir: "state" });

    await source.readScreen!(false);
    expect(f.setRedact).toHaveBeenLastCalledWith(false);
    await source.readScreen!(true);
    expect(f.setRedact).toHaveBeenLastCalledWith(true);
  });

  it("omits the layout reader when the layout is off", () => {
    const f = fakes();
    const source = createViewerSource(f.session as never, f.device as never, {
      stateDir: "state",
      layout: false,
    });
    expect(source.readScreen).toBeUndefined();
    // The display size is not a layout read: a half-scale frame still needs it.
    expect(source.displaySize).toBeDefined();
  });

  it("omits the screenshot when capture is off", () => {
    const f = fakes();
    const source = createViewerSource(f.session as never, f.device as never, {
      stateDir: "state",
      capture: false,
    });
    expect(source.capture).toBeUndefined();
  });

  it("saves screenshots through the session, so they are masked", async () => {
    const f = fakes();
    const source = createViewerSource(f.session as never, f.device as never, { stateDir: "state" });

    const path = await source.capture!();

    expect(path).toContain("state");
    expect(path).toContain("shots");
    expect(f.observe).toHaveBeenCalledWith({ out: path });
  });

  it("reports the display size without reading the layout", async () => {
    const f = fakes();
    const source = createViewerSource(f.session as never, f.device as never, { stateDir: "state" });
    expect(await source.displaySize!()).toEqual({ width: 1080, height: 2340 });
    expect(f.read).not.toHaveBeenCalled();
  });
});
