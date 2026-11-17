import { On, selectorText } from "./selector.js";
import { ElementNotFoundError, UitestError } from "../transport/errors.js";
import type { InputTextMode, Rect, WindowFilter } from "../transport/model.js";

/** The device-side calls a component handle makes; AgentClient satisfies this. */
export interface HypiumSource {
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
}

/** The device returns `{left, top, right, bottom, displayId}` for getBounds. */
interface DeviceBounds {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
}

const DRIVER = "Driver#0";

/**
 * Builds a chained `On` predicate on the device and returns its reference.
 * A chained predicate names its parent as `this`, so the chain is built from
 * the root outwards — the parent must be resolved before the child call.
 */
export async function resolveSelector(device: HypiumSource, selector: On): Promise<string> {
  const [api, args, target] = selector.toArgs();
  if (api === null) {
    if (typeof target !== "string") {
      throw new UitestError("a raw selector must carry a device reference", "ESELECTOR");
    }
    return target;
  }
  const parent = typeof target === "string" ? target : await resolveSelector(device, target);
  const ref = await device.hypium(api, parent, args);
  if (typeof ref !== "string" || ref === "") {
    throw new UitestError(
      `the device did not return a selector reference for ${selectorText(selector)}`,
      "ESELECTOR",
    );
  }
  return ref;
}

/**
 * Device-side component lookup. Selectors are evaluated on the device, so one
 * call replaces a host-side layout capture plus a tree walk — measured ~125 ms
 * against ~414 ms for a capture, and it cannot race a rerender between the two.
 */
export class Components {
  constructor(private readonly device: HypiumSource) {}

  private resolve(selector: On): Promise<string> {
    return resolveSelector(this.device, selector);
  }

  async find(selector: On): Promise<ComponentHandle | null> {
    const resolved = await this.resolve(selector);
    const ref = await this.device.hypium("Driver.findComponent", DRIVER, [resolved]);
    if (typeof ref !== "string" || ref === "") return null;
    return new ComponentHandle(this.device, ref, selector);
  }

  /** Like `find`, but a miss is an error carrying the selector. */
  async require(selector: On): Promise<ComponentHandle> {
    const handle = await this.find(selector);
    if (!handle) {
      throw new ElementNotFoundError(
        `not_found: no component matches ${selectorText(selector)}`,
        "ENOTFOUND",
      );
    }
    return handle;
  }

  /**
   * Waits on the device for the selector. The device's own wait knows about
   * layout passes a host poll cannot see, and one round trip replaces N.
   */
  async waitFor(selector: On, opts: WaitOptions = {}): Promise<ComponentHandle | null> {
    const timeoutMs = Math.max(1, Math.round(opts.timeoutMs ?? 5000));
    const resolved = await this.resolve(selector);
    const ref = await this.device.hypium("Driver.waitForComponent", DRIVER, [resolved, timeoutMs]);
    if (typeof ref !== "string" || ref === "") return null;
    return new ComponentHandle(this.device, ref, selector);
  }

  async findAll(selector: On): Promise<ComponentHandle[]> {
    const resolved = await this.resolve(selector);
    const refs = await this.device.hypium("Driver.findComponents", DRIVER, [resolved]);
    if (!Array.isArray(refs)) return [];
    return refs
      .filter((r): r is string => typeof r === "string" && r !== "")
      .map((r) => new ComponentHandle(this.device, r, selector));
  }

  /**
   * The focused window, or the one owned by `bundleName`.
   *
   * The extension has no window enumeration — `Driver.findWindows` does not
   * exist (measured) — so a window is always addressed by filter.
   */
  async window(filter: WindowFilter = {}): Promise<UiWindowHandle | null> {
    if (Object.values(filter).every((v) => v === undefined)) {
      throw new UitestError(
        "findWindow needs at least one condition (title, bundleName, focused or actived); " +
          "the device rejects an empty filter",
        "EWINDOWFILTER",
      );
    }
    const ref = await this.device.hypium("Driver.findWindow", DRIVER, [filter]);
    if (typeof ref !== "string" || ref === "") return null;
    return new UiWindowHandle(this.device, ref, filter);
  }
}

/**
 * One component on the device. The reference is only valid while that component
 * exists; a rerender that destroys it makes later calls fail, which is what
 * keeps an action from landing on whatever replaced it.
 */
export class ComponentHandle {
  constructor(
    private readonly device: HypiumSource,
    readonly ref: string,
    readonly selector: On | string,
  ) {}

  private call(api: string, args: unknown[] = []): Promise<unknown> {
    return this.device.hypium(api, this.ref, args);
  }

  private async stringCall(api: string): Promise<string> {
    const v = await this.call(api);
    return v === null || v === undefined ? "" : String(v);
  }

  async bounds(): Promise<Rect> {
    const raw = (await this.call("Component.getBounds")) as DeviceBounds | null;
    if (!raw || typeof raw !== "object") {
      throw new UitestError(`getBounds returned ${JSON.stringify(raw)}`, "ENOBOUNDS");
    }
    const left = Number(raw.left ?? 0);
    const top = Number(raw.top ?? 0);
    const right = Number(raw.right ?? left);
    const bottom = Number(raw.bottom ?? top);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  async text(): Promise<string> {
    const v = await this.call("Component.getText");
    return v === null || v === undefined ? "" : String(v);
  }

  async id(): Promise<string> {
    const v = await this.call("Component.getId");
    return v === null || v === undefined ? "" : String(v);
  }

  /**
   * The compatibility `key` property. The extension has no `Component.getKey`
   * (measured: "No handler found"), and on OpenHarmony the key is the id.
   */
  async key(): Promise<string> {
    return this.id();
  }

  async type(): Promise<string> {
    const v = await this.call("Component.getType");
    return v === null || v === undefined ? "" : String(v);
  }

  async description(): Promise<string> {
    return this.stringCall("Component.getDescription");
  }

  async hint(): Promise<string> {
    return this.stringCall("Component.getHint");
  }

  async accessibilityId(): Promise<string> {
    return this.stringCall("Component.getAccessibilityId");
  }

  async originalText(): Promise<string> {
    return this.stringCall("Component.getOriginalText");
  }

  async displayId(): Promise<number> {
    const v = await this.call("Component.getDisplayId");
    return Number(v ?? 0);
  }

  async boundsCenter(): Promise<{ x: number; y: number }> {
    const raw = (await this.call("Component.getBoundsCenter")) as
      | { x?: number; y?: number }
      | null;
    if (!raw || typeof raw !== "object") {
      throw new UitestError(`getBoundsCenter returned ${JSON.stringify(raw)}`, "ENOBOUNDS");
    }
    return { x: Number(raw.x ?? 0), y: Number(raw.y ?? 0) };
  }

  async allProperties(): Promise<Record<string, string>> {
    const raw = await this.call("Component.getAllProperties");
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        out[key] = value === null || value === undefined ? "" : String(value);
      }
    }
    return out;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.call("Component.isEnabled")) === true;
  }

  async isFocused(): Promise<boolean> {
    return (await this.call("Component.isFocused")) === true;
  }

  async isSelected(): Promise<boolean> {
    return (await this.call("Component.isSelected")) === true;
  }

  async isClickable(): Promise<boolean> {
    return (await this.call("Component.isClickable")) === true;
  }

  async isLongClickable(): Promise<boolean> {
    return (await this.call("Component.isLongClickable")) === true;
  }

  async isScrollable(): Promise<boolean> {
    return (await this.call("Component.isScrollable")) === true;
  }

  async isCheckable(): Promise<boolean> {
    return (await this.call("Component.isCheckable")) === true;
  }

  async isChecked(): Promise<boolean> {
    return (await this.call("Component.isChecked")) === true;
  }

  async scrollToTop(): Promise<void> {
    await this.call("Component.scrollToTop");
  }

  async scrollToBottom(): Promise<void> {
    await this.call("Component.scrollToBottom");
  }

  async pinchIn(scale = 0.5): Promise<void> {
    await this.call("Component.pinchIn", [scale]);
  }

  async pinchOut(scale = 1.5): Promise<void> {
    await this.call("Component.pinchOut", [scale]);
  }

  /** Drags this component to a point on screen. */
  async dragTo(point: { x: number; y: number }): Promise<void> {
    await this.call("Component.dragTo", [point]);
  }

  async click(): Promise<void> {
    await this.call("Component.click");
  }

  async longClick(): Promise<void> {
    await this.call("Component.longClick");
  }

  async doubleClick(): Promise<void> {
    await this.call("Component.doubleClick");
  }

  async inputText(text: string, mode?: InputTextMode): Promise<void> {
    await this.call("Component.inputText", mode ? [text, mode] : [text]);
  }

  async clearText(): Promise<void> {
    await this.call("Component.clearText");
  }

  /** Scrolls this container until `target` is found. Returns null on a miss. */
  async scrollSearch(target: On): Promise<ComponentHandle | null> {
    const resolved = await resolveSelector(this.device, target);
    const ref = await this.call("Component.scrollSearch", [resolved]);
    if (typeof ref !== "string" || ref === "") return null;
    return new ComponentHandle(this.device, ref, target);
  }

  toString(): string {
    return `${this.ref} (${selectorText(this.selector)})`;
  }
}

/** A window as the device sees it. */
export class UiWindowHandle {
  constructor(
    private readonly device: HypiumSource,
    readonly ref: string,
    readonly filter: WindowFilter = {},
  ) {}

  private call(api: string, args: unknown[] = []): Promise<unknown> {
    return this.device.hypium(api, this.ref, args);
  }

  async bounds(): Promise<Rect> {
    const raw = (await this.call("UiWindow.getBounds")) as DeviceBounds | null;
    if (!raw || typeof raw !== "object") {
      throw new UitestError(`UiWindow.getBounds returned ${JSON.stringify(raw)}`, "ENOBOUNDS");
    }
    const left = Number(raw.left ?? 0);
    const top = Number(raw.top ?? 0);
    const right = Number(raw.right ?? left);
    const bottom = Number(raw.bottom ?? top);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  async bundleName(): Promise<string> {
    const v = await this.call("UiWindow.getBundleName");
    return v === null || v === undefined ? "" : String(v);
  }

  async title(): Promise<string> {
    const v = await this.call("UiWindow.getTitle");
    return v === null || v === undefined ? "" : String(v);
  }

  async windowMode(): Promise<number> {
    return Number((await this.call("UiWindow.getWindowMode")) ?? 0);
  }

  async displayId(): Promise<number> {
    return Number((await this.call("UiWindow.getDisplayId")) ?? 0);
  }

  async isFocused(): Promise<boolean> {
    return (await this.call("UiWindow.isFocused")) === true;
  }

  async isActive(): Promise<boolean> {
    return (await this.call("UiWindow.isActive")) === true;
  }

  async focus(): Promise<void> {
    await this.call("UiWindow.focus");
  }

  async moveTo(x: number, y: number): Promise<void> {
    await this.call("UiWindow.moveTo", [x, y]);
  }

  async resize(width: number, height: number): Promise<void> {
    await this.call("UiWindow.resize", [width, height]);
  }

  async split(): Promise<void> {
    await this.call("UiWindow.split");
  }

  async maximize(): Promise<void> {
    await this.call("UiWindow.maximize");
  }

  async resume(): Promise<void> {
    await this.call("UiWindow.resume");
  }

  async minimize(): Promise<void> {
    await this.call("UiWindow.minimize");
  }

  async close(): Promise<void> {
    await this.call("UiWindow.close");
  }

  toString(): string {
    const f = this.filter;
    const what = f.focused ? "focused" : f.bundleName ? `bundle ${f.bundleName}` : "window";
    return `${what} (${this.ref})`;
  }
}
