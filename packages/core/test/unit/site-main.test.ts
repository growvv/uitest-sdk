import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Runs the site's classic script against a minimal DOM.
 *
 * `site/main.js` is one plain script with no build step, so the only way to
 * test the takeover demo's timing is to execute it. The harness supplies the
 * handful of globals the demo touches, a clock the test advances by hand, and
 * an IntersectionObserver the test drives — because scrolling out of view is
 * what the bug is about.
 */

type Listener = (ev: Record<string, unknown>) => void;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners: Record<string, Listener[]> = {};
  parentNode: FakeElement | null = null;
  className = "";
  textContent = "";
  offsetWidth = 0;

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

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }

  querySelectorAll(selector: string) {
    return findAll(this, selector);
  }

  querySelector(selector: string) {
    return findAll(this, selector)[0] ?? null;
  }

  closest(selector: string) {
    let node: FakeElement | null = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  getBoundingClientRect(): Rect {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}

/** Compound selector: `tag`, `.class`, `[attr]`, or any mix. */
function matches(el: FakeElement, part: string) {
  const tag = /^[a-z][\w-]*/i.exec(part);
  if (tag && el.tagName !== tag[0].toLowerCase()) return false;
  for (const cls of part.matchAll(/\.([\w-]+)/g)) {
    if (!el.classList.contains(cls[1]!)) return false;
  }
  for (const attr of part.matchAll(/\[([\w-]+)\]/g)) {
    if (!(attr[1]! in el.attrs)) return false;
  }
  return true;
}

function findAll(root: FakeElement, selector: string): FakeElement[] {
  let current = [root];
  for (const part of selector.trim().split(/\s+/)) {
    const next: FakeElement[] = [];
    for (const node of current) {
      const stack = [...node.children];
      while (stack.length > 0) {
        const child = stack.shift()!;
        stack.push(...child.children);
        if (matches(child, part) && !next.includes(child)) next.push(child);
      }
    }
    current = next;
  }
  return current;
}

/** A clock the test advances; the demo's timers run only when it says so. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms?: number) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms ?? 0), fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let pick: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at > end) continue;
          if (!pick || entry[1].at < pick[1].at) pick = entry;
        }
        if (!pick) break;
        const [id, timer] = pick;
        now = timer.at;
        timers.delete(id);
        timer.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

const SCRIPT = readFileSync(
  fileURLToPath(new URL("../../../../site/main.js", import.meta.url)),
  "utf8",
);

function loadSite() {
  const clock = makeClock();
  const docListeners: Record<string, Listener[]> = {};
  const observers: Array<{ targets: FakeElement[]; cb: (entries: unknown[]) => void }> = [];

  const html = new FakeElement("html");
  const body = html.appendChild(new FakeElement("body"));
  const demo = body.appendChild(new FakeElement("div"));
  demo.setAttribute("data-control-demo", "");
  const phone = demo.appendChild(new FakeElement("div"));
  phone.className = "control-phone";
  const frames: FakeElement[] = [];
  for (let i = 0; i < 5; i++) {
    const frame = phone.appendChild(new FakeElement("div"));
    frame.className = "control-frame";
    frames.push(frame);
  }
  const cursor = demo.appendChild(new FakeElement("div"));
  cursor.className = "control-cursor";
  const ripple = demo.appendChild(new FakeElement("div"));
  ripple.className = "control-ripple";
  const keys = demo.appendChild(new FakeElement("div"));
  keys.className = "control-keys";
  const keysText = keys.appendChild(new FakeElement("span"));
  keysText.className = "control-keys-text";
  const stepsEl = demo.appendChild(new FakeElement("ol"));
  stepsEl.className = "control-steps";
  const steps: FakeElement[] = [];
  for (let i = 0; i < 4; i++) steps.push(stepsEl.appendChild(new FakeElement("li")));

  const documentStub = {
    documentElement: html,
    body,
    getElementById: () => null,
    createElement: (tag: string) => new FakeElement(tag),
    querySelector: (sel: string) => findAll(html, sel)[0] ?? null,
    querySelectorAll: (sel: string) => findAll(html, sel),
    addEventListener: (type: string, fn: Listener) => {
      (docListeners[type] ??= []).push(fn);
    },
  };

  class Observer {
    targets: FakeElement[] = [];
    constructor(readonly cb: (entries: unknown[]) => void) {
      observers.push(this as unknown as { targets: FakeElement[]; cb: (entries: unknown[]) => void });
    }
    observe(target: FakeElement) {
      this.targets.push(target);
    }
    unobserve() {}
  }

  const sandbox: Record<string, unknown> = {
    document: documentStub,
    window: {
      matchMedia: () => ({ matches: false }),
      // The page tests for it on `window`, as a browser exposes it.
      IntersectionObserver: Observer,
      addEventListener() {},
    },
    navigator: {},
    IntersectionObserver: Observer,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: "main.js" });
  for (const fn of docListeners["DOMContentLoaded"] ?? []) fn({});

  return {
    demo,
    frames,
    keys,
    keysText,
    advance: clock.advance,
    pending: clock.pending,
    /** Reports the demo as entering or leaving the viewport. */
    intersect(isIntersecting: boolean) {
      for (const observer of observers) {
        if (!observer.targets.includes(demo)) continue;
        observer.cb(observer.targets.map((target) => ({ target, isIntersecting })));
      }
    },
    /** Indices of the frames currently lit. */
    lit(): number[] {
      return frames.flatMap((frame, i) => (frame.classList.contains("is-on") ? [i] : []));
    },
  };
}

describe("site takeover demo", () => {
  // The demo schedules its beats with nested setTimeout calls. Those ids were
  // never kept, so stop() only cleared the outer tick: scrolling the demo out
  // of view mid-step left the chain running, and scrolling back in started a
  // second one. Two chains then moved the cursor and swapped frames under each
  // other, showing beats that belong to a different step.
  it("stops a chain that is halfway through when the demo leaves the viewport", () => {
    const page = loadSite();
    page.intersect(true);
    page.advance(1000);
    expect(page.lit()).toEqual([0]);

    page.intersect(false);
    page.advance(20_000);

    expect(page.lit()).toEqual([0]);
    expect(page.keysText.textContent).toBe("待输入");
    expect(page.keys.classList.contains("is-on")).toBe(false);
    expect(page.pending()).toBe(0);
  });

  it("plays the demo again from the start after it scrolls back in", () => {
    const page = loadSite();
    page.intersect(true);
    page.advance(1000);
    page.intersect(false);
    page.advance(5000);
    page.intersect(true);

    // Step 0 types 「鸿蒙」 into the search field and then shows the results.
    page.advance(3000);
    expect(page.lit()).toEqual([1]);
  });
});
