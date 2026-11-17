import { describe, it, expect } from "vitest";
import { CliRunner } from "../../src/driver/cli.js";
import type { HdcRunner } from "../../src/transport/hdc.js";

function fakeHdc(readFile: string) {
  const calls: string[] = [];
  const hdc = {
    shell: async (c: string) => { calls.push(c); return ""; },
    pull: async () => { /* noop */ },
    readLocal: async () => readFile
  } as unknown as HdcRunner;
  return { hdc, calls };
}

describe("CliRunner", () => {
  it("passes windowId through to dumpLayout", async () => {
    const { hdc, calls } = fakeHdc('{"attributes":{"id":"w"},"children":[]}');
    const r = new CliRunner(hdc);
    const tree = await r.dumpLayout({ windowId: 16 });
    expect(tree.attributes.id).toBe("w");
    expect(calls[0]).toContain("-w 16");
  });

  it("adds -a when font attributes are requested", async () => {
    const { hdc, calls } = fakeHdc('{"attributes":{},"children":[]}');
    await new CliRunner(hdc).dumpLayout({ withFontAttrs: true });
    expect(calls[0]).toContain("-a");
  });

  it("passes bundleName through with -b", async () => {
    const { hdc, calls } = fakeHdc('{"attributes":{},"children":[]}');
    await new CliRunner(hdc).dumpLayout({ bundleName: "com.demo" });
    expect(calls[0]).toContain("-b com.demo");
  });

  it("removes the device-side file afterwards", async () => {
    const { hdc, calls } = fakeHdc('{"attributes":{},"children":[]}');
    await new CliRunner(hdc).dumpLayout();
    expect(calls.some((c) => c.startsWith("rm -f /data/local/tmp/uitest_sdk_"))).toBe(true);
  });

  it("throws a parse error on non-JSON output", async () => {
    const { hdc } = fakeHdc("not json");
    await expect(new CliRunner(hdc).dumpLayout()).rejects.toThrow();
  });
});
