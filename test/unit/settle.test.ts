import { describe, it, expect } from "vitest";
import { ScreenBuilder } from "../../src/agent/screen.js";
import { ScreenReader, settle } from "../../src/agent/settle.js";
import type { UiNode } from "../../src/model.js";

const tree = (text: string, bundle = "com.demo"): UiNode => ({
  attributes: { type: "Root", bounds: "[0,0][1000,2000]", bundleName: bundle },
  children: [
    { attributes: { type: "Text", text, bounds: "[0,100][500,200]" } },
  ],
});

interface FakeAgent {
  hypium(api: string, ref: string, args: unknown[]): Promise<unknown>;
  captureLayout(): Promise<UiNode>;
  getDisplaySize(): Promise<{ width: number; height: number }>;
  getDisplayRotation(): Promise<number>;
}

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent & { calls: string[]; captures: () => number } {
  let captures = 0;
  const calls: string[] = [];
  const base: FakeAgent = {
    async hypium(api, _ref, args) {
      calls.push(`${api}:${JSON.stringify(args)}`);
      return true;
    },
    async captureLayout() {
      captures++;
      return tree("hello");
    },
    async getDisplaySize() {
      return { width: 1000, height: 2000 };
    },
    async getDisplayRotation() {
      return 0;
    },
  };
  return Object.assign(base, overrides, { calls, captures: () => captures });
}

describe("settle", () => {
  it("uses the device-side waitForIdle and reads the screen once", async () => {
    const agent = fakeAgent();
    const reader = new ScreenReader(agent, new ScreenBuilder());
    const r = await settle(reader);
    expect(r.deviceIdle).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(agent.captures()).toBe(1);
    expect(r.screen.bundle).toBe("com.demo");
    expect(agent.calls[0]).toBe("Driver.waitForIdle:[200,3000]");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to host polling when waitForIdle is unavailable", async () => {
    let n = 0;
    const agent = fakeAgent({
      async hypium() {
        throw new Error("api not found");
      },
      async captureLayout() {
        n++;
        return tree(n < 2 ? "loading" : "done");
      },
    });
    const reader = new ScreenReader(agent, new ScreenBuilder());
    const r = await settle(reader, { pollMs: 10, startDelayMs: 0, maxSettleMs: 500 });
    expect(r.deviceIdle).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(r.screen.lines.join("\n")).toContain("done");
  });

  it("reports a timeout when the screen never stops changing", async () => {
    let n = 0;
    const agent = fakeAgent({
      async hypium() {
        return false;
      },
      async captureLayout() {
        return tree(`frame ${++n}`);
      },
    });
    const reader = new ScreenReader(agent, new ScreenBuilder());
    const r = await settle(reader, { pollMs: 10, startDelayMs: 0, maxSettleMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.deviceIdle).toBe(false);
  });

  it("does not confuse a quiet screen with a settled one after an action", async () => {
    // waitForIdle says true, but the app is still showing the old page for one
    // frame. The previous hash is returned unchanged only when nothing moved.
    const agent = fakeAgent({ async captureLayout() { return tree("before"); } });
    const reader = new ScreenReader(agent, new ScreenBuilder());
    const before = await reader.read();
    const r = await settle(reader, { previousHash: before.hash });
    expect(r.screen.hash).toBe(before.hash);
    expect(r.timedOut).toBe(false);
    expect(r.timedOut && r.screen.hash === before.hash).toBe(false);
  });
});

describe("ScreenReader", () => {
  it("caches display metadata across reads", async () => {
    let sizeCalls = 0;
    const agent = fakeAgent({
      async getDisplaySize() {
        sizeCalls++;
        return { width: 1000, height: 2000 };
      },
    });
    const reader = new ScreenReader(agent, new ScreenBuilder());
    await reader.read();
    await reader.read();
    expect(sizeCalls).toBe(1);
  });

  it("keeps refs stable across reads through one builder", async () => {
    const agent = fakeAgent();
    const reader = new ScreenReader(agent, new ScreenBuilder());
    const a = await reader.read();
    const b = await reader.read();
    expect(a.elements[0]!.ref).toBe(b.elements[0]!.ref);
  });
});
