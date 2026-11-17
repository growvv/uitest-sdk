import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { PLAYER_HTML } from "../../src/live/player.js";

/**
 * Runs the live page's inline script against a minimal DOM.
 *
 * The page is one template string with no build step, so the only way to test
 * what it *does* — as opposed to what it contains — is to execute it. This
 * harness supplies the handful of globals the script touches, a clock the test
 * drives by hand, and a fake WebSocket that records every frame the page would
 * send. Asserting on those frames is asserting on what the phone receives,
 * which is what a person experiences.
 *
 * Deliberately not a DOM implementation: no layout, no CSS, no events beyond
 * the ones a test dispatches. Anything the page needs from a real browser and
 * does not use in these paths is a stub that does nothing.
 */

type Listener = (ev: FakeEvent) => void;
type FakeEvent = { preventDefault(): void; stopPropagation(): void; [key: string]: unknown };

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

class FakeElement {
  readonly listeners: Record<string, Listener[]> = {};
  readonly children: FakeElement[] = [];
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  className = "";
  textContent = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  title = "";
  width = 0;
  height = 0;
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };

  constructor(readonly tagName: string) {}

  get classList() {
    const read = () => this.className.split(/\s+/).filter(Boolean);
    const write = (names: string[]) => {
      this.className = names.join(" ");
    };
    return {
      contains: (name: string) => read().includes(name),
      add: (name: string) => {
        const names = read();
        if (!names.includes(name)) write([...names, name]);
      },
      remove: (name: string) => write(read().filter((n) => n !== name)),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !read().includes(name);
        if (on) {
          const names = read();
          if (!names.includes(name)) write([...names, name]);
        } else {
          write(read().filter((n) => n !== name));
        }
        return on;
      },
    };
  }

  get childElementCount() {
    return this.children.length;
  }

  get offsetWidth() {
    return 0;
  }

  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }

  dispatch(type: string, init: Record<string, unknown> = {}) {
    const ev: FakeEvent = { preventDefault() {}, stopPropagation() {}, ...init };
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  querySelectorAll() {
    return [] as FakeElement[];
  }

  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getContext() {
    return { drawImage() {} };
  }

  setPointerCapture() {}
  focus() {}
  select() {}
}

/** A clock the test advances; the page's timers run only when it says so. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const add = (fn: () => void, ms: number | undefined, every: number | null) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms ?? 0), every, fn });
    return id;
  };
  return {
    setTimeout: (fn: () => void, ms?: number) => add(fn, ms, null),
    setInterval: (fn: () => void, ms?: number) => add(fn, ms, Math.max(1, ms ?? 1)),
    clearTimer: (id: number) => {
      timers.delete(id);
    },
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let pick: [number, { at: number; every: number | null; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at > end) continue;
          if (!pick || entry[1].at < pick[1].at) pick = entry;
        }
        if (!pick) break;
        const [id, timer] = pick;
        now = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.fn();
      }
      now = end;
    },
  };
}

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }
}

const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PLAYER_HTML)?.[1] ?? "";

function loadPlayer() {
  const clock = makeClock();
  const ids = new Map<string, FakeElement>();
  const el = (id: string) => {
    let found = ids.get(id);
    if (!found) {
      found = new FakeElement("div");
      ids.set(id, found);
    }
    return found;
  };
  const body = new FakeElement("body");
  const docListeners: Record<string, Listener[]> = {};
  const sockets: FakeSocket[] = [];

  const documentStub = {
    getElementById: (id: string) => el(id),
    createElement: (tag: string) => new FakeElement(tag),
    body,
    addEventListener: (type: string, fn: Listener) => {
      (docListeners[type] ??= []).push(fn);
    },
  };

  class Socket extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }

  const sandbox: Record<string, unknown> = {
    document: documentStub,
    window: { addEventListener() {} },
    location: { protocol: "http:", host: "127.0.0.1:8080" },
    WebSocket: Socket,
    // Present, so the page takes its normal connect() path. MJPEG codec means
    // no decoder is ever configured, so nothing here decodes anything.
    VideoDecoder: class {
      state = "configured";
      decodeQueueSize = 0;
      configure() {}
      close() {}
      decode() {}
    },
    performance: { now: () => clock.now() },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimer,
    clearInterval: clock.clearTimer,
    atob,
    Blob,
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: "player.html" });

  const socket = () => {
    const found = sockets[0];
    if (!found) throw new Error("the page never opened a socket");
    return found;
  };

  return {
    el,
    body,
    canvas: el("screen"),
    text: el("text-input"),
    /** Delivers a server frame as the page's onmessage would. */
    hello(msg: Record<string, unknown>) {
      const socketRef = socket();
      const data = { type: "hello", codec: "mjpeg", ...msg };
      socketRef.onmessage?.({ data: JSON.stringify(data) });
    },
    fire(target: FakeElement | "document", type: string, init: Record<string, unknown> = {}) {
      if (target === "document") {
        const ev: FakeEvent = { preventDefault() {}, stopPropagation() {}, ...init };
        for (const fn of docListeners[type] ?? []) fn(ev);
        return;
      }
      target.dispatch(type, init);
    },
    frames(): Array<Record<string, unknown>> {
      return socket().sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    },
    inputs(): Array<Record<string, unknown>> {
      return this.frames().filter((m) => m.type === "input");
    },
    advance: clock.advance,
  };
}

/** A controlling tab on a 1216×2688 phone. */
const CONTROLLED = {
  width: 1216,
  height: 2688,
  clientId: "tab-1",
  control: { state: "controlled", by: "tab-1" },
};

/** The canvas after a half-scale cast: the frame is 608×1344, shown at 400×800. */
function scaledFrame() {
  const page = loadPlayer();
  page.hello(CONTROLLED);
  page.canvas.width = 608;
  page.canvas.height = 1344;
  page.canvas.rect = { left: 0, top: 0, width: 400, height: 800 };
  return page;
}

describe("live page coordinates", () => {
  it("maps a click onto the display even when the frame is scaled", () => {
    // --scale 2 and every MJPEG device (x86_64 emulators) deliver a frame at
    // half the display. A tap in the middle of the picture is 608,1344 on the
    // phone — not 304,672, which is where the top-left quadrant starts.
    const page = scaledFrame();
    page.fire(page.canvas, "pointerdown", {
      pointerId: 1,
      clientX: 200,
      clientY: 400,
      pointerType: "mouse",
      button: 0,
    });
    expect(page.inputs()).toEqual([{ type: "input", action: "down", x: 608, y: 1344 }]);
  });

  it("clamps a drag to the display, not the frame", () => {
    const page = scaledFrame();
    page.fire(page.canvas, "pointerdown", { pointerId: 1, clientX: 0, clientY: 0, pointerType: "mouse", button: 0 });
    // The page sends at most one move per 16 ms, so time has to pass.
    page.advance(20);
    page.fire(page.canvas, "pointermove", { pointerId: 1, clientX: 400, clientY: 800 });
    expect(page.inputs()).toEqual([
      { type: "input", action: "down", x: 0, y: 0 },
      { type: "input", action: "move", x: 1215, y: 2687 },
    ]);
  });

  it("lets a pinch reach the display's half-size, not the frame's", () => {
    // The half-distance is a radius on the phone: fingers at opposite corners
    // of the picture ask for 1471 px, which the display caps at 608. Using
    // the frame's size would cap it at 304 — half the zoom the person made.
    const page = scaledFrame();
    page.fire(page.canvas, "pointerdown", { pointerId: 1, clientX: 0, clientY: 0, pointerType: "touch", button: 0 });
    page.fire(page.canvas, "pointerdown", { pointerId: 2, clientX: 400, clientY: 800, pointerType: "touch", button: 0 });
    const pinch = page.inputs().find((m) => m.action === "pinch");
    expect(pinch).toEqual({ type: "input", action: "pinch", cx: 608, cy: 1344, half: 608 });
  });
});

describe("live page keyboard composition", () => {
  it("does not send pinyin when Enter commits a candidate", () => {
    // In a real browser the Enter that picks a pinyin candidate is a keydown
    // while composing. Sending the field's value then sends "hongmeng", and
    // the commit — 鸿蒙 — never reaches the phone.
    const page = loadPlayer();
    page.hello(CONTROLLED);
    page.fire(page.text, "compositionstart");
    page.text.value = "hongmeng";
    page.fire(page.text, "input");
    page.fire(page.text, "keydown", { key: "Enter" });
    expect(page.inputs()).toEqual([]);

    page.text.value = "鸿蒙";
    page.fire(page.text, "compositionend");
    page.advance(400);
    expect(page.inputs()).toEqual([{ type: "input", action: "text", text: "鸿蒙" }]);
  });

  it("does not send Enter while a composition is still open", () => {
    // The 回车 button blurs the field, which in a real browser usually fires
    // compositionend first — but not always, and clicking it mid-composition
    // sent Enter to the phone with the pinyin still local. Spec §6.4: neither
    // the text nor a system key goes out until the composition ends.
    const page = loadPlayer();
    page.hello(CONTROLLED);
    page.fire(page.text, "compositionstart");
    page.text.value = "hongmeng";
    page.fire(page.text, "input");
    page.fire(page.el("key-enter"), "click");
    expect(page.inputs()).toEqual([]);
  });

  it("releases without sending pinyin when Esc ends a composition", () => {
    const page = loadPlayer();
    page.hello(CONTROLLED);
    page.fire(page.text, "compositionstart");
    page.text.value = "hong";
    page.fire(page.text, "input");
    page.fire("document", "keydown", { key: "Escape" });
    expect(page.inputs()).toEqual([]);
    expect(page.frames()).toContainEqual({ type: "control", action: "release" });
  });
});
