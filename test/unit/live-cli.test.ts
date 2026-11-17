import { describe, it, expect } from "vitest";
import { liveOptions } from "../../src/live/cli.js";
import { PLAYER_HTML } from "../../src/viewer/player.js";

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
  it("has the takeover controls and input bar", () => {
    for (const id of ["takeover", "control-state", "input-ms", "keys", "send-text",
      "key-back", "key-home", "key-enter", "key-delete", "touch"]) {
      expect(PLAYER_HTML).toContain(`id="${id}"`);
    }
  });

  it("handles the control and input messages the server sends", () => {
    expect(PLAYER_HTML).toContain("msg.type === 'control'");
    expect(PLAYER_HTML).toContain("action: 'take'");
    expect(PLAYER_HTML).toContain("action: 'release'");
    expect(PLAYER_HTML).toContain("action: 'pinch'");
  });

  it("only sends input while this tab controls", () => {
    expect(PLAYER_HTML).toContain("function sendInput");
    expect(PLAYER_HTML).toContain("controlledId");
    expect(PLAYER_HTML).toContain("clientId");
  });

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

  it("does not require hardware decode, which fails outright without a GPU", () => {
    // Measured in Chrome 157 with --disable-gpu: asking for prefer-hardware
    // makes isConfigSupported() false and configure() throw, so zero frames
    // decode. Leaving the choice to the browser decodes fine on the same
    // machine. A hard requirement here is a black screen on GPU-less boxes.
    expect(PLAYER_HTML).not.toContain("hardwareAcceleration: 'prefer-hardware'");
  });

  it("retries in software when the browser's first decoder will not configure", () => {
    // The hint is gone, but a driver can still refuse the default decoder.
    // One software retry turns a black screen into a slower picture.
    expect(PLAYER_HTML).toContain("prefer-software");
  });

  it("opens a fresh decoder after a decode error", () => {
    // Measured in Chrome: one corrupt chunk fires the error callback, which
    // used to only null the decoder and ask for a keyframe. With no decoder
    // left, onVideo returns early forever and the picture never comes back.
    // Recovery means re-opening from the last hello, then asking for the IDR.
    expect(PLAYER_HTML).toContain("lastHello");
    expect(PLAYER_HTML).toMatch(/function onDecodeError[\s\S]{0,400}startDecoder/);
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

describe("PLAYER_HTML: capture and record buttons", () => {
  it("shows the buttons only when the server says it can serve them", () => {
    // A video-only mirror (`--no-layout`, no session) has no capture and no
    // recorder. A button that fails on click is worse than no button, so the
    // hello carries the capabilities and the page starts them hidden.
    expect(PLAYER_HTML).toContain('id="shot"');
    expect(PLAYER_HTML).toContain('id="record"');
    expect(PLAYER_HTML).toMatch(/id="shot"[^>]*hidden/);
    expect(PLAYER_HTML).toMatch(/id="record"[^>]*hidden/);
    expect(PLAYER_HTML).toContain("msg.canShot");
    expect(PLAYER_HTML).toContain("msg.canRecord");
  });

  it("sends the shot and record messages the server handles", () => {
    expect(PLAYER_HTML).toContain("type: 'shot'");
    expect(PLAYER_HTML).toContain("type: 'record'");
    // The toggle has to send the action the button is currently offering.
    expect(PLAYER_HTML).toContain("action: recording ? 'stop' : 'start'");
  });

  it("turns the record button into a visible stop state", () => {
    // A recording belongs to the device, not to the tab that started it, so
    // every tab must show it is running.
    expect(PLAYER_HTML).toContain("function setRecording");
    expect(PLAYER_HTML).toContain("'Stop'");
    expect(PLAYER_HTML).toContain("msg.type === 'saved'");
  });
});
