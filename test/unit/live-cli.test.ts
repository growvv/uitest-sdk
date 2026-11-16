import { describe, it, expect } from "vitest";
import { liveOptions } from "../../src/live/cli.js";
import { PLAYER_HTML } from "../../src/live/player.js";

describe("liveOptions", () => {
  it("defaults to a masked local page on 7000", () => {
    const opts = liveOptions({});
    expect(opts.httpPort).toBe(7000);
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.privacy).toBe(true);
    expect(opts.open).toBe(true);
    expect(opts.layout).toBe(true);
    expect(opts.cast.scale).toBe(1);
    expect(opts.cast.frameRate).toBe(30);
  });

  it("turns privacy off from any of the words people type", () => {
    for (const word of ["off", "false", "no", "0", "OFF"]) {
      expect(liveOptions({ privacy: word }).privacy).toBe(false);
    }
    for (const word of ["on", "true", "yes", "1"]) {
      expect(liveOptions({ privacy: word }).privacy).toBe(true);
    }
  });

  it("rejects a privacy value it cannot honour", () => {
    // Silently treating "maybe" as "on" would hide a person's intent; the
    // page must not guess whether it is allowed to show a password.
    expect(() => liveOptions({ privacy: "maybe" })).toThrow(/privacy/);
  });

  it("rejects scale and frame rates the extension cannot encode", () => {
    expect(() => liveOptions({ scale: "6" })).toThrow(/scale/);
    expect(() => liveOptions({ scale: "0" })).toThrow(/scale/);
    expect(() => liveOptions({ fps: "24" })).toThrow(/fps/);
  });

  it("rejects an unknown transport instead of picking one", () => {
    expect(() => liveOptions({ transport: "tcp" })).toThrow(/transport/);
    expect(liveOptions({ transport: "ws" }).cast.transport).toBe("ws");
  });

  it("carries the cast settings through", () => {
    const opts = liveOptions({ scale: "2", fps: "60", castPort: "5001", wsExtension: "x.z.so" });
    expect(opts.cast.scale).toBe(2);
    expect(opts.cast.frameRate).toBe(60);
    expect(opts.cast.port).toBe(5001);
    expect(opts.cast.wsExtension).toBe("x.z.so");
  });

  it("allows a video-only page and a hand-started one", () => {
    const opts = liveOptions({ noLayout: true, noOpen: true });
    expect(opts.layout).toBe(false);
    expect(opts.open).toBe(false);
  });
});

describe("PLAYER_HTML", () => {
  it("decodes with WebCodecs and asks for a keyframe when it needs one", () => {
    // The page's whole latency story rests on these three things: the browser
    // decoder, a keyframe request after any gap, and dropping deltas it cannot
    // keep up with.
    expect(PLAYER_HTML).toContain("new VideoDecoder");
    expect(PLAYER_HTML).toContain("requestIDR");
    expect(PLAYER_HTML).toContain("decodeQueueSize");
    expect(PLAYER_HTML).toContain("optimizeForLatency");
  });

  it("draws MJPEG frames when the device has no encoder", () => {
    // The emulator path is a real path, not a degradation to hide: without
    // this the page connects, says "live", and stays black.
    expect(PLAYER_HTML).toContain("createImageBitmap");
    expect(PLAYER_HTML).toContain("mjpeg");
  });

  it("has no external dependency", () => {
    // A page that needs a CDN cannot be used on an offline bench, which is
    // where a phone is usually plugged in.
    expect(PLAYER_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(PLAYER_HTML).not.toMatch(/<link[^>]+href="http/i);
    expect(PLAYER_HTML).not.toMatch(/@import/);
  });

  it("starts with masking on", () => {
    expect(PLAYER_HTML).toMatch(/id="privacy"[^>]*checked/);
  });
});
