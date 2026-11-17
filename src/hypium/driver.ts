import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { AppManager } from "../apps.js";
import { ComponentHandle, Components, UiWindowHandle } from "../agent/components.js";
import { Gestures } from "../agent/gestures.js";
import { On, parseKeyName } from "../agent/selector.js";
import { ElementNotFoundError, UitestError, UnsupportedError } from "../errors.js";
import type { InputTextMode, Rect, WindowFilter } from "../model.js";
import { cropJpeg, decodeJpeg, findTemplate, type Raster } from "./image.js";
import { shellQuote } from "../util/shell.js";
import type {
  ActionOptions,
  CaptureOptions,
  CheckExistOptions,
  ComponentPredicate,
  Direction,
  DisappearOptions,
  DragOptions,
  FlingOptions,
  Gesture as GestureType,
  GestureOptions,
  HookCallback,
  HypiumAgent,
  HypiumHdc,
  HypiumIO,
  HypiumLogger,
  ImageCheckOptions,
  ImageOptions,
  MouseButton,
  MouseClickOptions,
  PenOptions,
  PinchOptions,
  PointLike,
  Rotation,
  Side,
  SwipeOptions,
  Target,
  TargetOptions,
  TouchMode,
  WaitComponentOptions,
  WaitIdleOptions,
  WindowCheck,
} from "./types.js";
import { Gesture } from "./types.js";

type Point = { x: number; y: number };

const DRIVER = "Driver#0";
const DEFAULT_TIMEOUT_MS = 10_000;

function pair(point: PointLike): [number, number] {
  if (Array.isArray(point)) {
    const tuple = point as readonly [number, number];
    return [Number(tuple[0]), Number(tuple[1])];
  }
  const p = point as { x: number; y: number };
  return [Number(p.x), Number(p.y)];
}

function isRect(value: unknown): value is Rect {
  return (
    !!value &&
    typeof value === "object" &&
    "x" in value &&
    "y" in value &&
    "width" in value &&
    "height" in value
  );
}

function isRatio(x: number, y: number): boolean {
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

function centerOf(rect: Rect, offset: [number, number] = [0.5, 0.5]): Point {
  return {
    x: Math.round(rect.x + rect.width * offset[0]),
    y: Math.round(rect.y + rect.height * offset[1]),
  };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export { shellQuote };

/** Splits a connector command the way a shell would, respecting quotes. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of String(command ?? "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

const BUNDLE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const ABILITY_RE = /^[A-Za-z0-9_.$]+$/;

function assertBundle(bundle: string): string {
  if (!BUNDLE_RE.test(bundle)) {
    throw new UitestError(`invalid bundle id: ${JSON.stringify(bundle)}`, "EINVALIDBUNDLE");
  }
  return bundle;
}

function assertAbility(ability: string): string {
  if (!ABILITY_RE.test(ability)) {
    throw new UitestError(`invalid ability name: ${JSON.stringify(ability)}`, "EINVALIDABILITY");
  }
  return ability;
}

function buttonId(button: MouseButton | undefined): number {
  if (button === undefined) return 0;
  if (typeof button === "number") {
    if (![0, 1, 2].includes(button)) {
      throw new UitestError(`invalid mouse button: ${button}`, "EINVALIDBUTTON");
    }
    return button;
  }
  const value = { left: 0, right: 1, middle: 2 }[button];
  if (value === undefined) {
    throw new UitestError(`invalid mouse button: ${JSON.stringify(button)}`, "EINVALIDBUTTON");
  }
  return value;
}

function directionCode(direction: Direction): number {
  return { left: 0, right: 1, up: 2, down: 3 }[direction];
}

function unsupported(label: string, detail: string): UnsupportedError {
  return new UnsupportedError(`${label} is not available: ${detail}`, "EUNSUPPORTED");
}

export interface HypiumDriverOptions {
  agent: HypiumAgent;
  hdc: HypiumHdc;
  /** The hashed 8-character tag, never the raw serial. */
  deviceTag: string;
  sleep?: (ms: number) => Promise<void>;
  log?: HypiumLogger;
  io?: HypiumIO;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const defaultLog: HypiumLogger = {
  debug: (msg) => console.debug(msg),
  info: (msg) => console.info(msg),
  warning: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

/**
 * The complete hypium 6.1.0.210 driver surface, expressed over the same agent
 * RPC the rest of the SDK uses. One class, one connection, no hidden session:
 * actions are the measured-fast paths (`Gestures` for single-pointer moves,
 * `Driver` for selectors and multi-finger matrices) rather than whatever the
 * Python implementation happened to call.
 *
 * Differences from hypium, all deliberate and documented:
 * - `sn()` returns the hashed device tag; the raw serial never leaves the SDK.
 * - Toast / UI event APIs throw `UnsupportedError`: the extension's
 *   `UIEventObserver` never replies over the raw socket (measured).
 * - Image matching is `template` mode only; SIFT needs OpenCV on the host.
 * - `ScreenLock.isLocked()` reports the real lock state instead of `false`.
 */
export class HypiumDriver {
  private readonly agent: HypiumAgent;
  private readonly hdcRunner: HypiumHdc;
  private readonly io: HypiumIO;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly components: Components;
  private readonly gestures: Gestures;
  private readonly apps: AppManager;
  private readonly hooks = new Map<string, Map<string, HookCallback>>();
  private implicitWaitSeconds = 10;

  readonly deviceTag: string;
  readonly log: HypiumLogger;

  constructor(opts: HypiumDriverOptions) {
    this.agent = opts.agent;
    this.hdcRunner = opts.hdc;
    this.deviceTag = opts.deviceTag;
    this.sleep = opts.sleep ?? realSleep;
    this.log = opts.log ?? defaultLog;
    this.io = opts.io ?? {
      writeFile: (path, data) => writeFile(path, data),
      readFile: (path) => readFile(path),
    };
    this.components = new Components(this.agent);
    this.gestures = new Gestures(this.agent, { sleep: this.sleep });
    this.apps = new AppManager(this.hdcRunner);
  }

  // ---------------------------------------------------------------- logging

  logDebug(msg: string): void {
    this.log.debug(msg);
  }

  logInfo(msg: string): void {
    this.log.info(msg);
  }

  logWarning(msg: string): void {
    this.log.warning(msg);
  }

  logError(msg: string): void {
    this.log.error(msg);
  }

  // --------------------------------------------------------------- identity

  /** The raw serial is deliberately not exposed; this is its stable hash. */
  async sn(): Promise<string> {
    return this.deviceTag;
  }

  async getDeviceType(): Promise<string> {
    return (await this.hdcRunner.shell("param get const.product.devicetype")).trim();
  }

  async deviceType(): Promise<string> {
    return this.getDeviceType();
  }

  async getOsType(): Promise<string> {
    return "OHOS";
  }

  async osType(): Promise<string> {
    return this.getOsType();
  }

  get screenLock(): { isLocked: () => Promise<boolean> } {
    return { isLocked: () => this.isDisplayLocked() };
  }

  // ------------------------------------------------------------------ hooks

  addHook(type: string, id: string, callback: HookCallback): void {
    let byId = this.hooks.get(type);
    if (!byId) {
      byId = new Map();
      this.hooks.set(type, byId);
    }
    byId.set(id, callback);
  }

  removeHook(type: string, id: string): void {
    this.hooks.get(type)?.delete(id);
  }

  removeAllHooks(type: string): void {
    this.hooks.delete(type);
  }

  /** Equivalent to `close` in hypium: drop host-side listeners, not the link. */
  close(): void {
    this.hooks.clear();
  }

  private notify(type: string, event: Record<string, unknown>): void {
    for (const callback of this.hooks.get(type)?.values() ?? []) {
      try {
        callback(event);
      } catch (e) {
        this.log.warning(`hook for ${type} failed: ${(e as Error).message}`);
      }
    }
  }

  private before(params: Record<string, unknown>): void {
    this.notify("ui_action_start", params);
  }

  // ------------------------------------------------------------ shell / hdc

  async shell(cmd: string, timeoutSeconds = 60): Promise<string> {
    return this.hdcRunner.shell(cmd, Math.max(1, Math.round(timeoutSeconds * 1000)));
  }

  async executeShellCommand(cmd: string, timeoutSeconds = 300): Promise<string> {
    return this.shell(cmd, timeoutSeconds);
  }

  async hdc(cmd: string | string[], timeoutSeconds = 60): Promise<string> {
    const args = Array.isArray(cmd) ? cmd : splitCommand(cmd);
    if (args.length === 0) {
      throw new UitestError("hdc needs at least one argument", "EINVALIDHDC");
    }
    return this.hdcRunner.command(args, Math.max(1, Math.round(timeoutSeconds * 1000)));
  }

  async executeConnectorCommand(cmd: string | string[], timeoutSeconds = 300): Promise<string> {
    return this.hdc(cmd, timeoutSeconds);
  }

  // --------------------------------------------------------------- display

  async getDisplaySize(): Promise<{ width: number; height: number }> {
    return this.agent.getDisplaySize();
  }

  async getDisplayRotation(): Promise<number> {
    return this.agent.getDisplayRotation();
  }

  /**
   * Rotation is an integer only. The extension's argument checker rejects a
   * name ("Expect integer which cannot be less than 0", measured), so accepting
   * one here would be a promise the device breaks.
   */
  async setDisplayRotation(rotation: Rotation): Promise<unknown> {
    if (typeof rotation !== "number" || ![0, 1, 2, 3].includes(rotation)) {
      throw new UitestError(
        `rotation must be one of 0, 1, 2, 3 (got ${JSON.stringify(rotation)}); the device takes an integer only`,
        "EINVALIDROTATION",
      );
    }
    return this.agent.hypium("Driver.setDisplayRotation", DRIVER, [rotation]);
  }

  async setDisplayRotationEnabled(enabled: boolean): Promise<unknown> {
    return this.agent.hypium("Driver.setDisplayRotationEnabled", DRIVER, [enabled]);
  }

  async isDisplayOn(): Promise<boolean> {
    const out = await this.hdcRunner.shell("hidumper -s PowerManagerService -a '-a'");
    return out.includes("Current State: AWAKE");
  }

  /**
   * Reads `screenLocked` from the lock service dump. The dump is a table of
   * ` * name <tab> value <tab> description` rows, so the field name sits at
   * index 1 after a whitespace split and the value at index 2. Taking index 1
   * compared the name against "true"/"false", which never matched — the method
   * then fell through to "is the display awake?", and an awake but locked phone
   * (what the power key leaves behind) read as unlocked.
   */
  async isDisplayLocked(): Promise<boolean> {
    const out = await this.hdcRunner.shell("hidumper -s ScreenlockService -a -all");
    for (const line of out.split(/\r?\n/)) {
      const fields = line.split(/\s+/).filter(Boolean);
      if (fields[1] !== "screenLocked") continue;
      if (fields[2] === "true") return true;
      if (fields[2] === "false") return false;
    }
    return !(await this.isDisplayOn());
  }

  async wakeUpDisplay(): Promise<void> {
    this.before({ operate_type: "wake" });
    await this.hdcRunner.shell("power-shell wakeup");
  }

  async closeDisplay(): Promise<void> {
    this.before({ operate_type: "sleep" });
    await this.hdcRunner.shell("power-shell suspend");
  }

  /** Swipe-up unlock. A device with a PIN or pattern still needs a person. */
  async unlock(): Promise<void> {
    await this.wakeUpDisplay();
    await this.sleep(1000);
    if (!(await this.isDisplayLocked())) return;
    const type = (await this.getDeviceType()).toLowerCase();
    if (type.includes("2in1") || type.includes("tablet")) {
      await this.triggerKey(2054); // ENTER
      return;
    }
    const { width, height } = await this.agent.getDisplaySize();
    await this.gestures.swipe(
      { x: Math.round(width / 2), y: Math.round(height * 0.99) },
      { x: Math.round(width / 2), y: Math.round(height * 0.7) },
      { durationMs: 200, steps: 6 },
    );
  }

  async setSleepTime(seconds: number): Promise<void> {
    if (!(await this.isDisplayOn())) await this.wakeUpDisplay();
    await this.hdcRunner.shell(`power-shell timeout -o ${Math.max(0, Math.round(seconds * 1000))}`);
  }

  async restoreSleepTime(): Promise<void> {
    await this.hdcRunner.shell("power-shell timeout -r");
  }

  // -------------------------------------------------------------- targeting

  async toAbsPos(x: number, y: number): Promise<Point> {
    if (isRatio(x, y)) {
      const { width, height } = await this.agent.getDisplaySize();
      return { x: Math.round(x * width), y: Math.round(y * height) };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  async toAbsolutePosition(x: number, y: number): Promise<Point> {
    return this.toAbsPos(x, y);
  }

  private async screenRect(): Promise<Rect> {
    const { width, height } = await this.agent.getDisplaySize();
    return { x: 0, y: 0, width, height };
  }

  private async areaRect(area?: Target): Promise<Rect> {
    return area ? this.boundsOf(area) : this.screenRect();
  }

  private async boundsOf(target: Target): Promise<Rect> {
    if (target instanceof On) return (await this.requireComponent(target)).bounds();
    if (target instanceof ComponentHandle) return target.bounds();
    if (isRect(target)) return target;
    throw new UitestError(
      "an area must be a component, selector or rectangle, not a point",
      "EINVALIDAREA",
    );
  }

  private async pointOf(target: Target, opts: TargetOptions = {}): Promise<Point> {
    const offset = opts.offset ?? [0.5, 0.5];
    if (target instanceof On) return centerOf(await (await this.requireComponent(target)).bounds(), offset);
    if (target instanceof ComponentHandle) return centerOf(await target.bounds(), offset);
    if (isRect(target)) return centerOf(target, offset);
    const [rawX, rawY] = pair(target);
    if (isRatio(rawX, rawY)) {
      const area = opts.area ? await this.boundsOf(opts.area) : await this.screenRect();
      return {
        x: Math.round(area.x + rawX * area.width),
        y: Math.round(area.y + rawY * area.height),
      };
    }
    if (opts.area) {
      const area = await this.boundsOf(opts.area);
      return { x: Math.round(area.x + rawX), y: Math.round(area.y + rawY) };
    }
    return { x: Math.round(rawX), y: Math.round(rawY) };
  }

  private async resolvePointIn(target: PointLike, area: Rect): Promise<Point> {
    const [x, y] = pair(target);
    if (isRatio(x, y)) {
      return {
        x: Math.round(area.x + x * area.width),
        y: Math.round(area.y + y * area.height),
      };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  private async requireComponent(selector: On): Promise<ComponentHandle> {
    const handle = await this.findComponent(selector);
    if (handle) return handle;
    throw new ElementNotFoundError(
      `not_found: no component matches ${selector.toString()}`,
      "ENOTFOUND",
    );
  }

  // -------------------------------------------------------------- tap / key

  async click(target: Target, opts: ActionOptions = {}): Promise<void> {
    const point = await this.pointOf(target, opts);
    this.before({ operate_type: "click", point: [point.x, point.y] });
    await this.agent.click(point.x, point.y);
    if (opts.waitMs) await this.sleep(opts.waitMs);
  }

  async doubleClick(target: Target, opts: ActionOptions = {}): Promise<void> {
    const point = await this.pointOf(target, opts);
    this.before({ operate_type: "doubleClick", point: [point.x, point.y] });
    await this.gestures.doubleClick(point);
    if (opts.waitMs) await this.sleep(opts.waitMs);
  }

  async longClick(
    target: Target,
    opts: ActionOptions & { pressTime?: number } = {},
  ): Promise<void> {
    const point = await this.pointOf(target, opts);
    this.before({ operate_type: "longClick", point: [point.x, point.y] });
    await this.gestures.longPress(point, { holdMs: Math.max(0, (opts.pressTime ?? 2) * 1000) });
    if (opts.waitMs) await this.sleep(opts.waitMs);
  }

  async touch(
    target: Target,
    opts: ActionOptions & { mode?: TouchMode; scrollTarget?: On | ComponentHandle } = {},
  ): Promise<void> {
    const mode = opts.mode ?? "normal";
    if (opts.scrollTarget && target instanceof On) {
      const found = await this.boundedScrollFind(target, opts.scrollTarget);
      if (!found) {
        throw new ElementNotFoundError(
          `not_found: no component matches ${target.toString()} after scrolling`,
          "ENOTFOUND",
        );
      }
      await this.actOnHandle(found, mode);
    } else if (target instanceof On || target instanceof ComponentHandle) {
      await this.actOnHandle(target, mode);
    } else {
      if (mode === "long") await this.longClick(target, opts);
      else if (mode === "double") await this.doubleClick(target, opts);
      else await this.click(target, opts);
    }
    if (opts.waitMs) await this.sleep(opts.waitMs);
  }

  private async actOnHandle(target: On | ComponentHandle, mode: TouchMode): Promise<void> {
    const handle = target instanceof ComponentHandle ? target : await this.requireComponent(target);
    this.before({ operate_type: mode, component: handle.ref });
    if (mode === "long") await handle.longClick();
    else if (mode === "double") await handle.doubleClick();
    else await handle.click();
  }

  async switchComponentStatus(component: On | ComponentHandle, checked: boolean): Promise<void> {
    const handle = component instanceof ComponentHandle ? component : await this.requireComponent(component);
    if ((await handle.isChecked()) !== checked) await handle.click();
  }

  async pressKey(
    key: string | number,
    key2?: string | number,
    mode: "normal" | "long" | "double" = "normal",
  ): Promise<unknown> {
    const code = parseKeyName(key as string | number);
    if (key2 !== undefined) return this.pressCombinationKey(code, key2);
    this.before({ operate_type: "key", key: code, mode });
    if (mode === "long") {
      return this.hdcRunner.shell(`uinput -K -l ${code}`);
    }
    if (mode === "double") {
      return this.hdcRunner.shell(`uinput -K -d ${code} -u ${code} -i 200 -d ${code} -u ${code}`);
    }
    return this.triggerKey(code);
  }

  async pressCombinationKey(
    key1: string | number,
    key2: string | number,
    key3?: string | number,
  ): Promise<unknown> {
    const codes = [key1, key2, key3]
      .filter((k) => k !== undefined)
      .map((k) => parseKeyName(k as string | number));
    this.before({ operate_type: "combination", keys: codes });
    return this.agent.hypium("Driver.triggerCombineKeys", DRIVER, codes);
  }

  private triggerKey(code: number): Promise<unknown> {
    return this.agent.hypium("Driver.triggerKey", DRIVER, [code]);
  }

  async pressHome(): Promise<void> {
    this.before({ operate_type: "home" });
    await this.triggerKey(1);
    await this.sleep(1000);
  }

  async goHome(): Promise<void> {
    const type = (await this.getDeviceType()).toLowerCase();
    if (type.includes("2in1") || type.includes("tablet")) {
      await this.pressCombinationKey(2076, 2020); // META_LEFT + D
    } else {
      await this.pressHome();
    }
  }

  async pressBack(): Promise<void> {
    this.before({ operate_type: "back" });
    await this.triggerKey(2);
  }

  async goBack(): Promise<void> {
    const type = (await this.getDeviceType()).toLowerCase();
    if (type.includes("2in1") || type.includes("tablet")) await this.pressBack();
    else await this.swipeToBack("left", { times: 1 });
  }

  async pressPower(): Promise<void> {
    this.before({ operate_type: "power" });
    await this.triggerKey(26);
  }

  async takeScreenshot(): Promise<void> {
    this.before({ operate_type: "screenshot" });
    await this.pressCombinationKey("volume_down", "power");
    await this.sleep(500);
  }

  // ---------------------------------------------------------------- gestures

  async drag(start: Target, end: Target, opts: DragOptions = {}): Promise<void> {
    const from = await this.pointOf(start, { area: opts.area });
    const to = await this.pointOf(end, { area: opts.area });
    const pressMs = Math.max(0, opts.pressMs ?? 1500);
    const durationMs =
      opts.speed && opts.speed > 0
        ? Math.max(1, Math.round((distance(from, to) / opts.speed) * 1000))
        : Math.max(1, Math.round(opts.durationMs ?? 1000));
    this.before({ operate_type: "drag", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    await this.gestures.drag(from, to, { holdMs: pressMs, durationMs });
  }

  async slide(start: Target, end: Target, opts: DragOptions = {}): Promise<void> {
    const from = await this.pointOf(start, { area: opts.area });
    const to = await this.pointOf(end, { area: opts.area });
    const durationMs = Math.max(1, Math.round(opts.durationMs ?? opts.speed ? (opts.speed ? (distance(from, to) / opts.speed) * 1000 : 300) : 300));
    this.before({ operate_type: "slide", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    await this.gestures.swipe(from, to, { durationMs });
  }

  private async swipeEndpoints(
    direction: Direction,
    opts: SwipeOptions,
  ): Promise<{ from: Point; to: Point; area: Rect }> {
    const area = await this.areaRect(opts.area);
    const percent = clamp(opts.distance ?? 60, 1, 100);
    const vertical = direction === "up" || direction === "down";
    const span = vertical ? area.height : area.width;
    const delta = (span * percent) / 200;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;

    if (opts.startPoint) {
      const from = await this.resolvePointIn(opts.startPoint, area);
      const to =
        direction === "up"
          ? { x: from.x, y: Math.max(area.y, from.y - delta * 2) }
          : direction === "down"
            ? { x: from.x, y: Math.min(area.y + area.height, from.y + delta * 2) }
            : direction === "left"
              ? { x: Math.max(area.x, from.x - delta * 2), y: from.y }
              : { x: Math.min(area.x + area.width, from.x + delta * 2), y: from.y };
      return { from, to, area };
    }

    if (!vertical && opts.side) {
      const from = {
        x: Math.round(area.x + area.width * (opts.side === "left" ? 0.05 : 0.95)),
        y: Math.round(cy),
      };
      const to = {
        x: Math.round(
          clamp(
            from.x + (direction === "right" ? delta * 2 : -delta * 2),
            area.x,
            area.x + area.width,
          ),
        ),
        y: from.y,
      };
      return { from, to, area };
    }

    switch (direction) {
      case "up":
        return { from: { x: Math.round(cx), y: Math.round(cy + delta) }, to: { x: Math.round(cx), y: Math.round(cy - delta) }, area };
      case "down":
        return { from: { x: Math.round(cx), y: Math.round(cy - delta) }, to: { x: Math.round(cx), y: Math.round(cy + delta) }, area };
      case "left":
        return { from: { x: Math.round(cx + delta), y: Math.round(cy) }, to: { x: Math.round(cx - delta), y: Math.round(cy) }, area };
      default:
        return { from: { x: Math.round(cx - delta), y: Math.round(cy) }, to: { x: Math.round(cx + delta), y: Math.round(cy) }, area };
    }
  }

  async swipe(direction: Direction, opts: SwipeOptions = {}): Promise<void> {
    const { from, to } = await this.swipeEndpoints(direction, opts);
    this.before({ operate_type: "swipe", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    await this.gestures.swipe(from, to, {
      durationMs: opts.durationMs ?? 300,
      steps: opts.steps,
    });
  }

  async fling(direction: Direction, opts: FlingOptions = {}): Promise<void> {
    const { from, to } = await this.swipeEndpoints(direction, {
      distance: opts.distance,
      area: opts.area,
    });
    const named = { fast: 4000, normal: 2000, slow: 1000 } as const;
    const speed = typeof opts.speed === "number" ? opts.speed : named[opts.speed ?? "normal"];
    const durationMs = clamp(Math.round((distance(from, to) / Math.max(1, speed)) * 1000), 40, 1200);
    this.before({ operate_type: "fling", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    await this.gestures.fling(from, to, { durationMs });
  }

  async swipeToHome(times = 1): Promise<void> {
    const { width, height } = await this.agent.getDisplaySize();
    const from = { x: Math.round(width / 2), y: height - 10 };
    const to = { x: Math.round(width / 2), y: Math.round(height - height / 6) };
    for (let i = 0; i < Math.max(1, times); i++) {
      await this.gestures.swipe(from, to, { durationMs: 200 });
      if (i + 1 < times) await this.sleep(300);
    }
    await this.sleep(1000);
  }

  async swipeToBack(
    side: Side = "left",
    opts: { times?: number; height?: number } = {},
  ): Promise<void> {
    const { width, height } = await this.agent.getDisplaySize();
    const y = clamp((opts.height ?? 0.5) * height, 0, height - 1);
    const from = { x: Math.round(side === "left" ? width * 0.01 : width * 0.99), y: Math.round(y) };
    const to = {
      x: Math.round(side === "left" ? width * 0.4 : width * 0.6),
      y: Math.round(Math.min(height - 1, y * 1.2)),
    };
    for (let i = 0; i < Math.max(1, opts.times ?? 1); i++) {
      await this.gestures.swipe(from, to, { durationMs: 200 });
      if (i + 1 < (opts.times ?? 1)) await this.sleep(150);
    }
  }

  async swipeToRecentTask(): Promise<void> {
    const { width, height } = await this.agent.getDisplaySize();
    await this.gestures.swipe(
      { x: Math.round(width / 2), y: height - 10 },
      { x: Math.round(width / 2), y: Math.round(height * 0.6) },
      { durationMs: 300, pauseMs: 1000 },
    );
  }

  async pinchIn(area?: Target, opts: PinchOptions = {}): Promise<void> {
    await this.pinch(area, opts.scale ?? 0.4, opts);
  }

  async pinchOut(area?: Target, opts: PinchOptions = {}): Promise<void> {
    await this.pinch(area, opts.scale ?? 1.6, opts);
  }

  private async pinch(area: Target | undefined, scale: number, opts: PinchOptions): Promise<void> {
    const rect = await this.areaRect(area);
    const safeScale = clamp(scale, 0.05, 5);
    const radius = Math.min(rect.width, rect.height) / 4;
    const direction = opts.direction ?? "diagonal";
    const dx = direction === "vertical" ? 0 : direction === "horizontal" ? radius : radius / Math.SQRT2;
    const dy = direction === "horizontal" ? 0 : direction === "vertical" ? radius : radius / Math.SQRT2;
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await this.gestures.multiTouch(
      [
        {
          from: { x: center.x - dx, y: center.y - dy },
          to: { x: center.x - dx * safeScale, y: center.y - dy * safeScale },
        },
        {
          from: { x: center.x + dx, y: center.y + dy },
          to: { x: center.x + dx * safeScale, y: center.y + dy * safeScale },
        },
      ],
      { durationMs: opts.durationMs ?? 400 },
    );
  }

  async twoFingerSwipe(
    start1: PointLike,
    end1: PointLike,
    start2: PointLike,
    end2: PointLike,
    opts: GestureOptions = {},
  ): Promise<void> {
    const area = await this.areaRect(opts.area);
    await this.gestures.multiTouch(
      [
        { from: await this.resolvePointIn(start1, area), to: await this.resolvePointIn(end1, area) },
        { from: await this.resolvePointIn(start2, area), to: await this.resolvePointIn(end2, area) },
      ],
      { durationMs: opts.durationMs ?? 500 },
    );
  }

  async multiFingerTouch(
    points: PointLike[],
    opts: GestureOptions = {},
  ): Promise<void> {
    if (points.length < 1 || points.length > 4) {
      throw new UitestError(`multiFingerTouch supports 1–4 fingers, got ${points.length}`, "EINVALIDGESTURE");
    }
    const area = await this.areaRect(opts.area);
    const resolved: Point[] = [];
    for (const point of points) resolved.push(await this.resolvePointIn(point, area));
    await this.gestures.multiTap(resolved, { holdMs: opts.durationMs ?? 100 });
  }

  async injectGesture(
    gesture: GestureType | Gesture,
    opts: GestureOptions = {},
  ): Promise<void> {
    const sampled = await this.sampleGesture(gesture as Gesture, opts);
    await this.gestures.injectPaths([sampled.path], { durationMs: sampled.durationMs });
  }

  async injectMultiFingerGesture(
    gestures: (GestureType | Gesture)[],
    opts: GestureOptions = {},
  ): Promise<void> {
    if (gestures.length === 0) {
      throw new UitestError("injectMultiFingerGesture needs at least one finger", "EINVALIDGESTURE");
    }
    const sampled = [];
    for (const gesture of gestures) sampled.push(await this.sampleGesture(gesture as Gesture, opts));
    const duration = Math.max(...sampled.map((s) => s.durationMs));
    await this.gestures.injectPaths(sampled.map((s) => s.path), { durationMs: duration });
  }

  private async sampleGesture(
    gesture: Gesture,
    opts: GestureOptions,
  ): Promise<{ path: Point[]; durationMs: number }> {
    if (!gesture?.steps?.length) {
      throw new UitestError("gesture has no steps; call start() first", "EINVALIDGESTURE");
    }
    const area = await this.areaRect(opts.area);
    const speed = Math.max(1, opts.speed ?? 2000);
    const path: Point[] = [];
    let durationMs = 0;
    let previous: Point | null = null;

    for (let index = 0; index < gesture.steps.length; index++) {
      const step = gesture.steps[index]!;
      const point = await this.resolvePointIn(step.point as PointLike, area);
      if (index === 0) {
        path.push(point);
        if (step.holdMs > 0) {
          path.push(point);
          path.push(point);
        }
        durationMs += step.holdMs;
        previous = point;
        continue;
      }
      const moveMs = step.moveMs ?? (distance(previous!, point) / speed) * 1000;
      const samples = clamp(Math.round(moveMs / 16), 2, 120);
      for (let i = 1; i <= samples; i++) {
        path.push({
          x: Math.round(previous!.x + ((point.x - previous!.x) * i) / samples),
          y: Math.round(previous!.y + ((point.y - previous!.y) * i) / samples),
        });
      }
      durationMs += moveMs;
      if (step.holdMs > 0) {
        path.push(point);
        path.push(point);
        durationMs += step.holdMs;
      }
      previous = point;
    }
    return { path, durationMs: Math.max(1, Math.round(durationMs)) };
  }

  // ------------------------------------------------------------------- mouse

  async mouseClick(target: Target, opts: MouseClickOptions = {}): Promise<unknown> {
    const point = await this.pointOf(target);
    const keys = (opts.keys ?? []).map((key) => parseKeyName(key as string | number));
    this.before({ operate_type: "mouseClick", point: [point.x, point.y] });
    return this.agent.hypium("Driver.mouseClick", DRIVER, [point, buttonId(opts.button), ...keys]);
  }

  async mouseDoubleClick(target: Target, opts: MouseClickOptions = {}): Promise<unknown> {
    const point = await this.pointOf(target);
    this.before({ operate_type: "mouseDoubleClick", point: [point.x, point.y] });
    return this.agent.hypium("Driver.mouseDoubleClick", DRIVER, [point, buttonId(opts.button)]);
  }

  async mouseLongClick(
    target: Target,
    opts: MouseClickOptions & { pressMs?: number } = {},
  ): Promise<unknown> {
    const point = await this.pointOf(target);
    this.before({ operate_type: "mouseLongClick", point: [point.x, point.y] });
    return this.agent.hypium("Driver.mouseLongClick", DRIVER, [
      point,
      buttonId(opts.button),
      Math.round(opts.pressMs ?? 1500),
    ]);
  }

  async mouseScroll(
    target: Target,
    direction: "up" | "down",
    steps: number,
    opts: MouseClickOptions = {},
  ): Promise<unknown> {
    if (direction !== "up" && direction !== "down") {
      throw new UitestError(`invalid scroll direction: ${JSON.stringify(direction)}`, "EINVALIDDIRECTION");
    }
    const point = await this.pointOf(target);
    const keys = (opts.keys ?? []).map((key) => parseKeyName(key as string | number));
    this.before({ operate_type: "mouseScroll", point: [point.x, point.y] });
    return this.agent.hypium("Driver.mouseScroll", DRIVER, [
      point,
      direction === "down",
      Math.max(1, Math.round(steps)),
      ...keys,
    ]);
  }

  async mouseMoveTo(target: Target): Promise<unknown> {
    const point = await this.pointOf(target);
    this.before({ operate_type: "mouseMoveTo", point: [point.x, point.y] });
    return this.agent.hypium("Driver.mouseMoveTo", DRIVER, [point]);
  }

  async mouseMove(start: Target, end: Target, opts: { speed?: number } = {}): Promise<unknown> {
    const from = await this.pointOf(start);
    const to = await this.pointOf(end);
    this.before({ operate_type: "mouseMove", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    return this.agent.hypium("Driver.mouseMoveWithTrack", DRIVER, [
      from,
      to,
      Math.round(opts.speed ?? 3000),
    ]);
  }

  async mouseDrag(start: Target, end: Target, opts: { speed?: number } = {}): Promise<unknown> {
    const from = await this.pointOf(start);
    const to = await this.pointOf(end);
    this.before({ operate_type: "mouseDrag", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    return this.agent.hypium("Driver.mouseDrag", DRIVER, [from, to, Math.round(opts.speed ?? 3000)]);
  }

  // --------------------------------------------------------------------- pen

  async penClick(target: Target, opts: TargetOptions = {}): Promise<unknown> {
    const point = await this.pointOf(target, opts);
    this.before({ operate_type: "penClick", point: [point.x, point.y] });
    return this.agent.hypium("Driver.penClick", DRIVER, [point]);
  }

  async penDoubleClick(target: Target, opts: TargetOptions = {}): Promise<unknown> {
    const point = await this.pointOf(target, opts);
    this.before({ operate_type: "penDoubleClick", point: [point.x, point.y] });
    return this.agent.hypium("Driver.penDoubleClick", DRIVER, [point]);
  }

  async penLongClick(
    target: Target,
    opts: TargetOptions & { pressure?: number } = {},
  ): Promise<unknown> {
    const point = await this.pointOf(target, opts);
    this.before({ operate_type: "penLongClick", point: [point.x, point.y] });
    return this.agent.hypium("Driver.penLongClick", DRIVER, [point, clamp(opts.pressure ?? 0.5, 0, 1)]);
  }

  async penSwipe(direction: Direction, opts: PenOptions & SwipeOptions = {}): Promise<unknown> {
    const { from, to } = await this.swipeEndpoints(direction, opts);
    const speed = this.penSpeed(from, to, opts);
    this.before({ operate_type: "penSwipe", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    return this.agent.hypium("Driver.penSwipe", DRIVER, [
      from,
      to,
      speed,
      clamp(opts.pressure ?? 0.5, 0, 1),
    ]);
  }

  async penSlide(
    start: Target,
    end: Target,
    opts: PenOptions & DragOptions = {},
  ): Promise<unknown> {
    const from = await this.pointOf(start, { area: opts.area });
    const to = await this.pointOf(end, { area: opts.area });
    this.before({ operate_type: "penSlide", start_point: [from.x, from.y], end_point: [to.x, to.y] });
    return this.agent.hypium("Driver.penSwipe", DRIVER, [
      from,
      to,
      this.penSpeed(from, to, opts),
      clamp(opts.pressure ?? 0.5, 0, 1),
    ]);
  }

  async penDrag(
    start: Target,
    end: Target,
    opts: PenOptions & DragOptions = {},
  ): Promise<void> {
    const from = await this.pointOf(start, { area: opts.area });
    const to = await this.pointOf(end, { area: opts.area });
    const gesture = new Gesture()
      .start(from, (opts.pressMs ?? 1500) / 1000)
      .moveTo(to, (opts.durationMs ?? 1000) / 1000);
    await this.penInjectGesture(gesture, { pressure: opts.pressure, speed: opts.speed });
  }

  async penInjectGesture(
    gesture: GestureType | Gesture,
    opts: PenOptions = {},
  ): Promise<unknown> {
    const sampled = await this.sampleGesture(gesture as Gesture, opts);
    const matrix = await this.buildMatrix([sampled.path]);
    this.before({ operate_type: "penGesture", points: sampled.path.length });
    return this.agent.hypium("Driver.injectPenPointerAction", DRIVER, [
      matrix,
      Math.round(opts.speed ?? 2000),
      clamp(opts.pressure ?? 0.5, 0, 1),
    ]);
  }

  private penSpeed(from: Point, to: Point, opts: GestureOptions & DragOptions): number {
    if (typeof opts.speed === "number" && opts.speed > 0) return clamp(Math.round(opts.speed), 200, 40000);
    const duration = (opts.durationMs ?? 300) / 1000;
    return clamp(Math.round(distance(from, to) / Math.max(0.001, duration)), 200, 40000);
  }

  private async buildMatrix(paths: Point[][]): Promise<string> {
    const steps = Math.max(...paths.map((path) => path.length));
    const matrix = await this.agent.hypium("PointerMatrix.create", "PointerMatrix#seed", [
      paths.length,
      steps,
    ]);
    if (typeof matrix !== "string" || matrix === "") {
      throw new UitestError("the device did not return a PointerMatrix reference", "EGESTURE");
    }
    for (let finger = 0; finger < paths.length; finger++) {
      const path = paths[finger]!;
      for (let step = 0; step < steps; step++) {
        const point = path[Math.min(step, path.length - 1)]!;
        await this.agent.hypium("PointerMatrix.setPoint", matrix, [finger, step, point]);
      }
    }
    return matrix;
  }

  // -------------------------------------------------------- special hardware

  private async supported<T>(label: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/capability not support|not support/i.test(message)) {
        throw unsupported(label, message);
      }
      throw e;
    }
  }

  async touchpadSwipe(
    direction: Direction,
    opts: { fingers?: number; speed?: number } = {},
  ): Promise<unknown> {
    return this.supported("touchpadSwipe", () =>
      this.agent.hypium("Driver.touchPadMultiFingerSwipe", DRIVER, [
        clamp(Math.round(opts.fingers ?? 3), 1, 4),
        directionCode(direction),
        { stay: false, speed: opts.speed ?? 0 },
      ]),
    );
  }

  async touchpadSwipeAndHold(
    direction: Direction,
    opts: { fingers?: number; speed?: number } = {},
  ): Promise<unknown> {
    return this.supported("touchpadSwipeAndHold", () =>
      this.agent.hypium("Driver.touchPadMultiFingerSwipe", DRIVER, [
        clamp(Math.round(opts.fingers ?? 3), 1, 4),
        directionCode(direction),
        { stay: true, speed: opts.speed ?? 0 },
      ]),
    );
  }

  async rotateCrown(steps: number, opts: { speed?: number } = {}): Promise<unknown> {
    return this.supported("rotateCrown", () =>
      this.agent.hypium("Driver.crownRotate", DRIVER, [
        Math.round(steps),
        clamp(Math.round(opts.speed ?? 20), 1, 500),
      ]),
    );
  }

  // -------------------------------------------------------------- components

  async findComponent(
    target: On | ComponentHandle | string,
    opts: { scrollTarget?: On | ComponentHandle } = {},
  ): Promise<ComponentHandle | null> {
    if (target instanceof ComponentHandle) return target;
    const selector = typeof target === "string" ? On.raw(target) : target;
    if (opts.scrollTarget) return this.boundedScrollFind(selector, opts.scrollTarget);
    const found = await this.components.find(selector);
    if (found) return found;
    if (this.implicitWaitSeconds <= 0) return null;
    return this.components.waitFor(selector, {
      timeoutMs: Math.round(this.implicitWaitSeconds * 1000),
    });
  }

  async findAllComponents(target: On): Promise<ComponentHandle[]>;
  async findAllComponents(target: On, index: number): Promise<ComponentHandle | null>;
  async findAllComponents(
    target: On,
    index?: number,
  ): Promise<ComponentHandle[] | ComponentHandle | null> {
    const all = await this.components.findAll(target);
    if (index === undefined) return all;
    return all[index] ?? null;
  }

  async waitForComponent(
    by: On,
    opts: WaitComponentOptions = {},
  ): Promise<ComponentHandle | null> {
    return this.components.waitFor(by, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async waitForComponentDisappear(
    by: On,
    opts: DisappearOptions = {},
  ): Promise<ComponentHandle | null> {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pollMs = Math.max(1, opts.pollMs ?? 200);
    const attempts = Math.ceil(timeoutMs / pollMs) + 2;
    let last: ComponentHandle | null = null;
    for (let i = 0; i < attempts; i++) {
      last = await this.components.find(by);
      if (!last) return null;
      if (i > 0 && timeoutMs === 0) break;
      await this.sleep(pollMs);
    }
    return last;
  }

  async getComponentBound(component: On | ComponentHandle): Promise<Rect | null> {
    if (component instanceof ComponentHandle) return component.bounds();
    const handle = await this.components.find(component);
    return handle ? handle.bounds() : null;
  }

  async getComponentPos(component: On | ComponentHandle): Promise<Point | null> {
    const bounds = await this.getComponentBound(component);
    return bounds ? centerOf(bounds) : null;
  }

  /** The supported property names, in hypium's order plus the measured extras. */
  static readonly COMPONENT_PROPERTIES = [
    "id",
    "text",
    "key",
    "type",
    "enabled",
    "focused",
    "clickable",
    "scrollable",
    "checked",
    "checkable",
    "description",
    "selected",
    "bounds",
    "hint",
    "accessibilityId",
    "originalText",
    "displayId",
  ] as const;

  async getComponentProperty(
    component: On | ComponentHandle,
    property: string,
  ): Promise<unknown> {
    const getters: Record<string, (h: ComponentHandle) => Promise<unknown>> = {
      id: (h) => h.id(),
      text: (h) => h.text(),
      key: (h) => h.key(),
      type: (h) => h.type(),
      enabled: (h) => h.isEnabled(),
      focused: (h) => h.isFocused(),
      clickable: (h) => h.isClickable(),
      scrollable: (h) => h.isScrollable(),
      checked: (h) => h.isChecked(),
      checkable: (h) => h.isCheckable(),
      description: (h) => h.description(),
      selected: (h) => h.isSelected(),
      bounds: (h) => h.bounds(),
      hint: (h) => h.hint(),
      accessibilityId: (h) => h.accessibilityId(),
      originalText: (h) => h.originalText(),
      displayId: (h) => h.displayId(),
    };
    const getter = getters[property];
    if (!getter) {
      throw new UitestError(
        `unknown property "${property}"; use ${Object.keys(getters).join(", ")}`,
        "EINVALIDPROPERTY",
      );
    }
    const handle = component instanceof ComponentHandle ? component : await this.requireComponent(component);
    return getter(handle);
  }

  async checkComponent(
    component: On | ComponentHandle,
    expected: ComponentPredicate,
    opts: { expectEqual?: boolean; waitMs?: number } = {},
  ): Promise<boolean> {
    let handle: ComponentHandle | null =
      component instanceof ComponentHandle ? component : null;
    if (!handle) {
      handle =
        opts.waitMs && opts.waitMs > 0
          ? await this.waitForComponent(component as On, { timeoutMs: opts.waitMs })
          : await this.components.find(component as On);
    }
    if (!handle) return false;
    const expectEqual = opts.expectEqual ?? true;
    for (const [property, value] of Object.entries(expected)) {
      const actual = await this.getComponentProperty(handle, property);
      const equal = this.sameValue(actual, value);
      if (equal !== expectEqual) return false;
    }
    return true;
  }

  private sameValue(actual: unknown, expected: unknown): boolean {
    if (typeof expected === "boolean") return Boolean(actual) === expected;
    if (typeof expected === "number") return Number(actual) === expected;
    if (expected === null) return actual === null || actual === "";
    return String(actual ?? "") === String(expected);
  }

  async checkComponentExist(
    selector: On,
    opts: CheckExistOptions = {},
  ): Promise<boolean> {
    const expectExist = opts.expectExist ?? true;
    const found = opts.scrollTarget
      ? await this.boundedScrollFind(selector, opts.scrollTarget)
      : opts.waitMs && opts.waitMs > 0
        ? await this.waitForComponent(selector, { timeoutMs: opts.waitMs })
        : await this.components.find(selector);
    return (found !== null) === expectExist;
  }

  async checkExist(selector: On, opts: CheckExistOptions = {}): Promise<boolean> {
    return this.checkComponentExist(selector, opts);
  }

  /**
   * Scrolls a container host-side. `Component.scrollSearch` exists on the
   * device but blocks to the 30 s request timeout when the target is absent and
   * leaves the global lock held (measured), so the SDK never calls it.
   */
  private async boundedScrollFind(
    selector: On,
    scrollTarget: On | ComponentHandle,
    attempts = 6,
  ): Promise<ComponentHandle | null> {
    let container: ComponentHandle;
    try {
      container = scrollTarget instanceof ComponentHandle
        ? scrollTarget
        : await this.requireComponent(scrollTarget);
      const direct = await this.components.find(selector);
      if (direct) return direct;
      const bounds = await container.bounds();
      const from = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height * 0.8) };
      const to = { x: from.x, y: Math.round(bounds.y + bounds.height * 0.2) };
      for (let i = 0; i < attempts; i++) {
        await this.gestures.swipe(from, to, { durationMs: 300 });
        await this.sleep(300);
        const found = await this.components.find(selector);
        if (found) return found;
      }
      return null;
    } catch {
      return null;
    }
  }

  async clearText(component: On | ComponentHandle): Promise<void> {
    const handle = component instanceof ComponentHandle ? component : await this.requireComponent(component);
    this.before({ operate_type: "clearText", component: handle.ref });
    await handle.clearText();
  }

  async inputText(
    target: On | ComponentHandle | Target,
    text: string,
    mode?: InputTextMode,
  ): Promise<void> {
    if (target instanceof On || target instanceof ComponentHandle) {
      const handle = target instanceof ComponentHandle ? target : await this.requireComponent(target);
      this.before({ operate_type: "inputText", component: handle.ref });
      await handle.inputText(text, mode);
      return;
    }
    const point = await this.pointOf(target);
    this.before({ operate_type: "inputText", point: [point.x, point.y] });
    await this.agent.hypium(
      "Driver.inputText",
      DRIVER,
      mode ? [point, text, mode] : [point, text],
    );
  }

  async moveCursor(direction: "left" | "right" | "up" | "down" | "begin" | "end", times = 1): Promise<void> {
    const key = {
      left: 2014,
      right: 2015,
      up: 2012,
      down: 2013,
      begin: 2081,
      end: 2082,
    }[direction];
    if (key === undefined) {
      throw new UitestError(`invalid cursor direction: ${JSON.stringify(direction)}`, "EINVALIDDIRECTION");
    }
    for (let i = 0; i < Math.max(1, times); i++) await this.triggerKey(key);
  }

  async inputTextOnCurrentCursor(text: string): Promise<void> {
    this.before({ operate_type: "inputTextOnCurrentCursor" });
    await this.hdcRunner.shell(`uitest uiInput text ${shellQuote(text)}`);
  }

  // ----------------------------------------------------------------- windows

  async findWindow(filter: WindowFilter): Promise<UiWindowHandle | null> {
    return this.components.window(filter);
  }

  async getCurrentWindow(): Promise<UiWindowHandle | null> {
    return (
      (await this.components.window({ actived: true })) ??
      (await this.components.window({ focused: true }))
    );
  }

  async getWindowSize(): Promise<{ width: number; height: number } | null> {
    const window = await this.getCurrentWindow();
    if (!window) return null;
    const bounds = await window.bounds();
    return { width: bounds.width, height: bounds.height };
  }

  async checkWindow(
    window: UiWindowHandle | WindowFilter,
    expected: WindowCheck = {},
  ): Promise<boolean> {
    const handle = window instanceof UiWindowHandle ? window : await this.findWindow(window);
    if (!handle) return false;
    if (expected.title !== undefined && (await handle.title()) !== expected.title) return false;
    if (
      expected.bundleName !== undefined &&
      (await handle.bundleName()) !== expected.bundleName
    ) {
      return false;
    }
    return true;
  }

  async checkCurrentWindow(expected: WindowCheck = {}): Promise<boolean> {
    const window = await this.getCurrentWindow();
    if (!window) return false;
    return this.checkWindow(window, expected);
  }

  async checkWindowExist(filter: WindowFilter, expectExist = true): Promise<boolean> {
    return ((await this.findWindow(filter)) !== null) === expectExist;
  }

  // -------------------------------------------------------------- app & file

  async startApp(
    packageName: string,
    opts: { ability?: string; params?: string; waitMs?: number } = {},
  ): Promise<string> {
    const bundle = assertBundle(packageName);
    const ability = assertAbility(opts.ability ?? (await this.apps.entryAbility(bundle)) ?? "");
    if (!ability) {
      throw new UitestError(
        `no entry ability found for ${bundle}; pass opts.ability`,
        "ENOABILITY",
      );
    }
    const command = `aa start -b ${bundle} -a ${ability}${opts.params ? ` ${opts.params}` : ""}`;
    const output = await this.hdcRunner.shell(command);
    if (/error|fail|not found|does not exist/i.test(output) && !/success/i.test(output)) {
      throw new UitestError(`startApp failed: ${output.trim() || "aa returned no output"}`, "ELAUNCH");
    }
    if ((opts.waitMs ?? 1000) > 0) await this.sleep(opts.waitMs ?? 1000);
    return command;
  }

  async stopApp(packageName: string, opts: { waitMs?: number } = {}): Promise<void> {
    await this.apps.stop(assertBundle(packageName));
    if ((opts.waitMs ?? 500) > 0) await this.sleep(opts.waitMs ?? 500);
  }

  async hasApp(packageName: string): Promise<boolean> {
    return this.apps.has(packageName);
  }

  async currentApp(): Promise<[string | null, string | null]> {
    const current = await this.apps.current();
    return current ? [current.bundle, current.ability ?? null] : [null, null];
  }

  async installApp(packagePath: string, options = ""): Promise<string> {
    const args = ["install", ...splitCommand(options), packagePath];
    return this.hdcRunner.command(args);
  }

  async uninstallApp(packageName: string): Promise<string> {
    const output = await this.hdcRunner.shell(`bm uninstall -n ${assertBundle(packageName)}`);
    if (/error|fail|not found/i.test(output) && !/success/i.test(output)) {
      throw new UitestError(`uninstallApp failed: ${output.trim()}`, "EUNINSTALL");
    }
    return output.trim();
  }

  async clearAppData(packageName: string): Promise<string> {
    const bundle = assertBundle(packageName);
    let output = await this.hdcRunner.shell(`bm clean -n ${bundle} -d`);
    if (/error|fail|not found/i.test(output) && !/success/i.test(output)) {
      output = await this.hdcRunner.shell(`bm clean -n ${bundle} -c`);
    }
    if (/error|fail|not found/i.test(output) && !/success/i.test(output)) {
      throw new UitestError(`clearAppData failed: ${output.trim()}`, "ECLEAR");
    }
    return output.trim();
  }

  async pullFile(devicePath: string, localPath?: string, timeoutSeconds = 60): Promise<void> {
    const local = localPath ?? basename(devicePath);
    await this.hdcRunner.pull(devicePath, local);
    void timeoutSeconds;
  }

  async pushFile(localPath: string, devicePath: string, timeoutSeconds = 60): Promise<void> {
    await this.hdcRunner.push(localPath, devicePath);
    void timeoutSeconds;
  }

  async hasFile(path: string): Promise<boolean> {
    const output = await this.hdcRunner.shell(`ls ${shellQuote(path)}`);
    return !/no such file|not found|does not exist/i.test(output);
  }

  // -------------------------------------------------------------- wait & IME

  async wait(seconds: number): Promise<void> {
    await this.sleep(Math.max(0, seconds * 1000));
  }

  async waitForIdle(opts: WaitIdleOptions = {}): Promise<boolean> {
    const idleMs = Math.max(1, Math.round(opts.idleMs ?? 500));
    const timeoutMs = Math.max(1, Math.round(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    return (
      (await this.agent.hypium("Driver.waitForIdle", DRIVER, [idleMs, timeoutMs])) === true
    );
  }

  setImplicitWaitTime(seconds: number): void {
    this.implicitWaitSeconds = Math.max(0, seconds);
  }

  getImplicitWaitTime(): number {
    return this.implicitWaitSeconds;
  }

  // --------------------------------------------------------------- screenshot

  async captureScreen(opts: CaptureOptions = {}): Promise<Buffer | string> {
    if (opts.inPc === false) {
      if (!opts.savePath) {
        throw new UitestError(
          "inPc: false needs a device savePath",
          "EINVALIDCAPTURE",
        );
      }
      await this.hdcRunner.shell(`uitest screenCap -p ${shellQuote(opts.savePath)}`);
      if (!(await this.hasFile(opts.savePath))) {
        throw new UitestError(
          `device screenshot was not written to ${opts.savePath}`,
          "ECAPTURE",
        );
      }
      return opts.savePath;
    }

    let buffer = await this.agent.captureScreen({ scale: opts.scale ?? 0.5 });
    if (opts.area) {
      const area = await this.boundsOf(opts.area);
      const display = await this.agent.getDisplaySize();
      const raster = decodeJpeg(buffer);
      const factor = raster.width / display.width;
      buffer = cropJpeg(buffer, {
        x: area.x * factor,
        y: area.y * factor,
        width: area.width * factor,
        height: area.height * factor,
      });
    }
    if (!opts.savePath) return buffer;
    await this.io.writeFile(opts.savePath, buffer);
    return opts.savePath;
  }

  private async screenRaster(scale: number): Promise<{ raster: Raster; factor: number }> {
    const buffer = await this.agent.captureScreen({ scale });
    const raster = decodeJpeg(buffer);
    const display = await this.agent.getDisplaySize();
    return { raster, factor: display.width / raster.width };
  }

  private async templateRaster(imagePath: string): Promise<Raster> {
    const data = await this.io.readFile(imagePath);
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw unsupported(
        "findImage with a PNG template",
        "only JPEG templates are decoded on the host; convert the template to JPEG",
      );
    }
    return decodeJpeg(data);
  }

  async findImage(imagePath: string, opts: ImageOptions = {}): Promise<Rect | null> {
    if (opts.mode === "sift") {
      throw unsupported(
        "findImage mode 'sift'",
        "SIFT needs OpenCV on the host; use mode 'template' with a same-scale JPEG",
      );
    }
    const { raster, factor } = await this.screenRaster(opts.scale ?? 0.5);
    const template = await this.templateRaster(imagePath);

    if (opts.area) {
      const area = await this.boundsOf(opts.area);
      const crop = {
        x: area.x / factor,
        y: area.y / factor,
        width: area.width / factor,
        height: area.height / factor,
      };
      const clipped = {
        x: Math.max(0, Math.floor(crop.x)),
        y: Math.max(0, Math.floor(crop.y)),
        width: Math.min(raster.width - Math.max(0, Math.floor(crop.x)), Math.ceil(crop.width)),
        height: Math.min(raster.height - Math.max(0, Math.floor(crop.y)), Math.ceil(crop.height)),
      };
      const region: Raster = {
        width: clipped.width,
        height: clipped.height,
        data: new Uint8Array(clipped.width * clipped.height * 4),
      };
      for (let row = 0; row < clipped.height; row++) {
        const src = ((clipped.y + row) * raster.width + clipped.x) * 4;
        region.data.set(raster.data.subarray(src, src + clipped.width * 4), row * clipped.width * 4);
      }
      const hit = findTemplate(region, template, opts.similarity ?? 0.95);
      if (!hit) return null;
      return {
        x: Math.round((clipped.x + hit.rect.x) * factor),
        y: Math.round((clipped.y + hit.rect.y) * factor),
        width: Math.round(hit.rect.width * factor),
        height: Math.round(hit.rect.height * factor),
      };
    }

    const hit = findTemplate(raster, template, opts.similarity ?? 0.95);
    if (!hit) return null;
    return {
      x: Math.round(hit.rect.x * factor),
      y: Math.round(hit.rect.y * factor),
      width: Math.round(hit.rect.width * factor),
      height: Math.round(hit.rect.height * factor),
    };
  }

  async touchImage(
    imagePath: string,
    opts: ImageOptions & { touchMode?: TouchMode; waitMs?: number } = {},
  ): Promise<void> {
    const rect = await this.findImage(imagePath, opts);
    if (!rect) {
      throw new ElementNotFoundError(
        `not_found: no image matching ${imagePath} on screen`,
        "ENOTFOUND",
      );
    }
    const point = centerOf(rect);
    if (opts.touchMode === "long") await this.longClick(point, { waitMs: opts.waitMs });
    else if (opts.touchMode === "double") await this.doubleClick(point, { waitMs: opts.waitMs });
    else await this.click(point, { waitMs: opts.waitMs });
  }

  async checkImageExist(
    imagePath: string,
    opts: ImageCheckOptions & { expectExist?: boolean } = {},
  ): Promise<boolean> {
    const expectExist = opts.expectExist ?? true;
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 3000);
    const pollMs = Math.max(1, opts.pollMs ?? 500);
    const deadline = Date.now() + timeoutMs;
    do {
      const hit = await this.findImage(imagePath, opts);
      if ((hit !== null) === expectExist) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(pollMs);
    } while (true);
  }

  // ------------------------------------------------------- toast / UI events

  private eventUnsupported(label: string): never {
    throw unsupported(
      label,
      "the extension's UIEventObserver returns from start but never replies to " +
        "getRecentUiEvent over the raw RPC socket (measured 2026-11-16, 30 s timeout). " +
        "No timeout or retry makes the reply appear.",
    );
  }

  async startListenToast(): Promise<void> {
    this.eventUnsupported("startListenToast");
  }

  async getLatestToast(): Promise<string> {
    this.eventUnsupported("getLatestToast");
  }

  async checkToast(): Promise<boolean> {
    this.eventUnsupported("checkToast");
  }

  async startListenUiEvent(): Promise<void> {
    this.eventUnsupported("startListenUiEvent");
  }

  async getLatestUiEvent(): Promise<Record<string, unknown> | null> {
    this.eventUnsupported("getLatestUiEvent");
  }
}
