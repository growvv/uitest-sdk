import { describe, expect, it } from "vitest";
import { PLAYER_HTML } from "../../src/viewer/player.js";

/**
 * What the shipped page contains, as opposed to what its script does when run
 * (that is `viewer-player.test.ts`). These assertions are the ones a product
 * builds on: the console reuses this page and adds markup, so the controls,
 * the decoder choices and the offline guarantee are a contract, not styling.
 */
describe("PLAYER_HTML", () => {
  it("has the takeover controls and input bar", () => {
    for (const id of [
      "takeover",
      "control-state",
      "input-ms",
      "keys",
      "send-text",
      "key-back",
      "key-home",
      "key-enter",
      "key-delete",
      "touch",
    ]) {
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

  /**
   * `hidden` is the only mechanism the server has to turn a control off, and
   * the UA rule it relies on loses to any author `display` declaration. Both
   * `aside` and `label.switch` set `display: flex`, so a mirror with
   * `inspect: false` still showed a dead 340 px panel and a privacy switch
   * that controlled nothing — visible in its own published screenshots.
   */
  it("lets `hidden` win over the layout rules", () => {
    expect(PLAYER_HTML).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
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

  it("shows a startup recording failure that arrived before the tab did", () => {
    // `--record` can fail on a transport that cannot record. The broadcast
    // reaches nobody if the browser opened slowly, so the greeting carries the
    // reason too.
    expect(PLAYER_HTML).toContain("msg.recordingError");
  });
});
