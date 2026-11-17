import { describe, it, expect } from "vitest";
import { LiveState } from "../../src/viewer/state.js";

const ALL = [
  "idle",
  "starting",
  "live",
  "reconnecting",
  "stopping",
  "stopped",
  "failed",
] as const;

describe("LiveState", () => {
  it("starts idle", () => {
    expect(new LiveState().state).toBe("idle");
  });

  it("walks the happy path idle → starting → live → stopping → stopped", () => {
    const s = new LiveState();
    s.to("starting");
    s.to("live");
    s.to("stopping");
    s.to("stopped");
    expect(s.state).toBe("stopped");
    expect(s.history).toEqual(["starting", "live", "stopping", "stopped"]);
  });

  it("allows live → reconnecting → live without leaving live-ish", () => {
    const s = new LiveState();
    s.to("starting");
    s.to("live");
    s.to("reconnecting");
    expect(s.streaming).toBe(false);
    expect(s.connected).toBe(true);
    s.to("live");
    expect(s.streaming).toBe(true);
  });

  it("refuses a transition it does not declare", () => {
    const s = new LiveState();
    // idle can only start; jumping to live would claim a stream that is not there.
    expect(() => s.to("live")).toThrow();
    expect(s.state).toBe("idle");
  });

  it("lets any state fail", () => {
    for (const from of ALL) {
      if (from === "failed") continue;
      const s = new LiveState();
      s.force(from);
      s.to("failed");
      expect(s.state).toBe("failed");
    }
  });

  it("treats failed as terminal except for a fresh start", () => {
    const s = new LiveState();
    s.to("failed");
    expect(() => s.to("live")).toThrow();
    s.to("starting"); // a new attempt is a new run
    expect(s.state).toBe("starting");
  });

  it("counts reconnects and resets them on a clean stop", () => {
    const s = new LiveState();
    s.to("starting");
    s.to("live");
    s.to("reconnecting");
    s.to("live");
    expect(s.reconnects).toBe(1);
    s.to("stopping");
    s.to("stopped");
    expect(s.reconnects).toBe(0);
  });

  it("only reports streaming in live", () => {
    const s = new LiveState();
    for (const state of ALL) {
      s.force(state);
      expect(s.streaming).toBe(state === "live");
    }
  });

  it("reports connected while live or reconnecting", () => {
    const s = new LiveState();
    for (const state of ALL) {
      s.force(state);
      expect(s.connected).toBe(state === "live" || state === "reconnecting");
    }
  });

  it("notifies listeners once per accepted change", () => {
    const s = new LiveState();
    const seen: string[] = [];
    const off = s.onChange((next, prev) => seen.push(`${prev}>${next}`));
    s.to("starting");
    s.to("starting"); // same state: no event
    s.to("live");
    off();
    s.to("stopping");
    expect(seen).toEqual(["idle>starting", "starting>live"]);
  });

  it("names the reason a failure happened", () => {
    const s = new LiveState();
    s.to("failed", "device went away");
    expect(s.reason).toBe("device went away");
    s.to("starting");
    expect(s.reason).toBeUndefined();
  });

  it("cannot be reused after stop without a start", () => {
    const s = new LiveState();
    s.to("starting");
    s.to("stopping");
    s.to("stopped");
    expect(() => s.to("live")).toThrow();
    s.to("starting");
    expect(s.state).toBe("starting");
  });
});
