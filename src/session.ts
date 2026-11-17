import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { tagOf } from "./transport/tag.js";
import { AppManager } from "./transport/apps.js";
import { Approvals, Grants } from "./governance/approvals.js";
import type {
  ApprovalDecision,
  ApprovalScope,
  DecisionResult,
  Grant,
  PendingApproval,
} from "./governance/approvals.js";
import { Components, ComponentHandle } from "./driver/agent/components.js";
import { Gestures } from "./driver/agent/gestures.js";
import { On, selectorText, parseKeyName } from "./driver/agent/selector.js";
import { ScreenReader, settle } from "./driver/agent/settle.js";
import { Screenshot } from "./driver/agent/shot.js";
import { inspectScreen, renderPanel } from "./driver/agent/inspector.js";
import type { InspectNode } from "./driver/agent/inspector.js";
import { ScreenBuilder, findElement, findText, renderDiff, renderFull } from "./driver/agent/screen.js";
import type { Screen, ScreenElement } from "./driver/agent/screen.js";
import { Policy } from "./governance/policy.js";
import type { PolicyOptions } from "./governance/policy.js";
import { FileRefStore } from "./refs.js";
import { Lease } from "./governance/lease.js";
import { TraceRecorder } from "./governance/trace.js";
import { ElementNotFoundError, UitestError } from "./transport/errors.js";
import { actionText } from "./driver/agent/result.js";
import type { ActionResult } from "./driver/agent/result.js";
import type { Point } from "./driver/agent/gestures.js";
import type { InputTextMode, Rect } from "./transport/model.js";
import type { UiNode } from "./transport/model.js";
import type { ShellRunner } from "./transport/apps.js";

/** The device calls a session needs; `Device` satisfies this. */
export interface SessionAgent {
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
  captureLayout(): Promise<UiNode>;
  getDisplaySize(): Promise<{ width: number; height: number }>;
  getDisplayRotation(): Promise<number>;
  captureScreen(opts?: { scale?: number }): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  inputText(x: number, y: number, text: string, mode?: InputTextMode): Promise<void>;
  triggerKey(code: number): Promise<void>;
}

export interface SessionDevice {
  readonly deviceId?: string;
  readonly agent: SessionAgent;
  readonly hdc?: ShellRunner;
  dispose?(): Promise<void>;
}

export interface SessionOptions {
  /** Short name for this task; appears in the lease, trace and report. */
  task?: string;
  /** Where traces and screenshots go. Defaults to `.uitest-phone` in cwd. */
  stateDir?: string;
  /** Lease settings, or `false` to opt out of exclusive access. */
  lease?: { dir?: string; staleMs?: number } | false;
  /** Policy applied before every device action. */
  policy?: PolicyOptions;
  /** Save a screenshot with each step. */
  traceShots?: boolean;
  /** Upper bound for the post-action settle, in ms. */
  settleMs?: number;
  /** Do not read or write a trace file. */
  noTrace?: boolean;
  /** How long a person has to answer an approval, in ms. Defaults to 60 s. */
  approvalTtlMs?: number;
}

export type Target = number | { ref: number } | { text: string } | On;

export interface TapOptions {
  /** Approval id a person handed back for this exact step. */
  approvalId?: string;
  /** `task` or `always` remembers the answer for this rule and app. */
  approvalScope?: ApprovalScope;
  long?: boolean;
  holdMs?: number;
}

export interface TypeOptions {
  approvalId?: string;
  approvalScope?: ApprovalScope;
  /** Input to type into; defaults to the focused field. */
  ref?: number;
  /**
   * Paste the text in one go instead of typing it character by character.
   * The extension's clipboard path; measured on a 36-character string it is
   * about twice as fast as per-key input (1.3 s vs 2.8 s), and non-ASCII
   * survives intact.
   */
  paste?: boolean;
}

export interface InspectOptions {
  /** Annotated JPEG path. */
  out: string;
  /** Also write a self-contained HTML panel here. */
  html?: string;
}

/** An inspect step's outcome, including the files it wrote and the node table. */
export type InspectResult = ActionResult & {
  image: string | null;
  html: string | null;
  nodes: InspectNode[];
};

export interface SwipeInput {
  from: Point;
  to: Point;
  steps?: number;
  durationMs?: number;
  holdMs?: number;
  approvalId?: string;
  approvalScope?: ApprovalScope;
}

export interface WaitForOptions {
  timeoutMs?: number;
}

export interface ListOptions {
  /** Scroll container ref; the largest scrollable on screen by default. */
  ref?: number;
  /** Stop after this many screens. */
  maxScreens?: number;
  /** Stop after this long, in ms. */
  maxMs?: number;
}

export type ReadListResult = ActionResult & {
  /** Every distinct label, in reading order. */
  items: string[];
  /** True when the list reported its own end. */
  complete: boolean;
  /** How many screens were read. */
  screens: number;
};

export interface WindowFilter {
  /** The window that currently has input focus. */
  focused?: boolean;
  /** The window owned by this bundle. */
  bundleName?: string;
}

export interface WindowOptions {
  /** Bring the window to the front before reporting. */
  focus?: boolean;
  /** Close the window before reporting. */
  close?: boolean;
}

export interface PinchInput {
  approvalId?: string;
  approvalScope?: ApprovalScope;
  /** Center of the gesture; required unless `ref` is given. */
  center?: Point;
  /** Element to pinch inside; its middle becomes the center. */
  ref?: number;
  /** Half-distance between the fingers at the start. */
  from?: number;
  /** Half-distance at the end; wins over `scale` when both are given. */
  to?: number;
  /** End distance as a multiple of the start: 2 zooms in, 0.5 zooms out. */
  scale?: number;
}

export type WindowResult = ActionResult & {
  /** Empty when the window could not be found. */
  bundle: string;
  focused: boolean;
  bounds: Rect | null;
};

const DEFAULT_STATE = ".uitest-phone";

export { tagOf };

/**
 * One task's view of one device.
 *
 * Everything an agent does goes through here: observe, act on a ref or a
 * selector, settle, get a status back, and leave a trace. The session owns the
 * lease (so two tasks cannot interleave), the policy (so risky steps stop
 * before the device is touched), and the ref table (so a ref addresses the
 * element it was observed on, or nothing at all).
 */
export class Session {
  readonly reader: ScreenReader;
  readonly components: Components;
  readonly gestures: Gestures;
  readonly apps: AppManager | null;
  readonly policy: Policy;
  readonly trace: TraceRecorder | null;
  readonly task: string;
  readonly tag: string;
  /** Where this session keeps refs, traces, approvals and grants. */
  readonly stateDir: string;

  private readonly approvals: Approvals;
  private readonly grants: Grants;
  private lease: Lease | null;
  private readonly settleMs: number;
  private readonly traceShots: boolean;
  private readonly shotsDir: string;
  private released = false;
  private lastScreen: Screen | null = null;
  private stepCount = 0;

  private constructor(
    private readonly device: SessionDevice,
    private readonly opts: SessionOptions,
    lease: Lease | null,
    trace: TraceRecorder | null,
  ) {
    this.task = opts.task?.trim() || "task";
    this.lease = lease;
    this.trace = trace;
    this.policy = new Policy(opts.policy);
    this.settleMs = Math.max(0, opts.settleMs ?? 3000);
    this.traceShots = opts.traceShots === true;
    this.stateDir = opts.stateDir ?? join(process.cwd(), DEFAULT_STATE);
    const stateDir = this.stateDir;
    this.shotsDir = join(stateDir, "shots");
    this.tag = tagOf(device.deviceId);
    // The ref table is per device and outlives the process: the CLI runs one
    // command per invocation, so a ref printed by `observe` must still mean the
    // same element in the next `tap`.
    const refs = new FileRefStore(join(stateDir, `refs-${this.tag}.json`));
    this.reader = new ScreenReader(device.agent, new ScreenBuilder(refs));
    // Approvals outlive the process for the same reason: the command that asks
    // for one and the command that replays it are separate invocations.
    this.approvals = new Approvals({
      dir: join(stateDir, "approvals", this.tag),
      ttlMs: opts.approvalTtlMs ?? 60_000,
    });
    this.grants = new Grants({ path: join(stateDir, `grants-${this.tag}.json`) });
    this.components = new Components(device.agent);
    this.gestures = new Gestures(device.agent);
    this.apps = device.hdc ? new AppManager(device.hdc) : null;
  }

  /**
   * Takes the device for `task`. Fails with `lease_held` when another live task
   * owns it, before anything is read or written on the device.
   */
  static async open(device: SessionDevice, opts: SessionOptions = {}): Promise<Session> {
    const stateDir = opts.stateDir ?? join(process.cwd(), DEFAULT_STATE);
    const tag = tagOf(device.deviceId);

    let lease: Lease | null = null;
    if (opts.lease !== false) {
      const dir = opts.lease?.dir ?? join(stateDir, "leases");
      await mkdir(dir, { recursive: true });
      lease = await Lease.acquire({
        path: join(dir, `${tag}.lock`),
        task: opts.task?.trim() || "task",
        staleMs: opts.lease?.staleMs,
      });
    }

    const trace = opts.noTrace
      ? null
      : new TraceRecorder({
          dir: join(stateDir, "traces"),
          task: opts.task?.trim() || "task",
          deviceId: device.deviceId,
        });

    return new Session(device, opts, lease, trace);
  }

  // ------------------------------------------------------------- observing

  /** Reads the current screen and records it. */
  async observe(opts: { out?: string } = {}): Promise<ActionResult> {
    const screen = await this.reader.read();
    this.lastScreen = screen;
    if (screen.locked) {
      // The lock screen is not content. Returning it as `settled` invites the
      // agent to act on the clock and the camera shortcut.
      return this.finish("observe", opts, "device_locked", actionText({ status: "device_locked", screen }), {
        screen,
      });
    }
    let shot: string | null = null;
    if (opts.out) {
      shot = await this.saveShot(opts.out, screen);
    }
    const text = renderFull(screen) + (shot ? `\nsaved: ${shot}` : "");
    return this.finish("observe", opts, "settled", text, { screen, shot });
  }

  /**
   * Reads the screen, boxes every element on the frame and numbers it.
   *
   * This is `observe` plus pixels: the numbers on the image are the `ref`s in
   * the table, so a caller can look at the layout and then `tap --ref`. The
   * optional HTML panel embeds the same frame and lets a person hover a row to
   * find its box.
   */
  async inspect(opts: InspectOptions): Promise<InspectResult> {
    const screen = await this.reader.read();
    this.lastScreen = screen;
    if (screen.locked) {
      return (await this.finish(
        "inspect",
        opts,
        "device_locked",
        actionText({ status: "device_locked", screen }),
        { screen, image: null, html: null, nodes: [] },
      )) as InspectResult;
    }
    const [frame, ctx] = await Promise.all([this.device.agent.captureScreen(), this.reader.context()]);
    const shot = await Screenshot.from(frame, ctx);
    const inspection = inspectScreen(screen, shot);
    await inspection.annotated.save(opts.out);

    let panel: string | null = null;
    if (opts.html) {
      await mkdir(dirname(opts.html), { recursive: true });
      await writeFile(opts.html, renderPanel(screen, inspection), "utf8");
      panel = opts.html;
    }

    const text =
      `${renderFull(screen)}\nsaved: ${opts.out}` +
      (panel ? `\npanel: ${panel}` : "") +
      "\nnumbers on the image are refs: tap --ref N";
    return (await this.finish("inspect", opts, "settled", text, {
      screen,
      image: opts.out,
      html: panel,
      nodes: inspection.nodes,
    })) as InspectResult;
  }

  /** The screen as of the last read, or a fresh one. */
  async screen(): Promise<Screen> {
    return this.reader.read();
  }

  /** Standing approvals, for `status` and the report. */
  grantList(): Grant[] {
    return this.grants.list();
  }

  /** Approvals waiting for a person, or answered and not yet consumed. */
  pendingApprovals(): PendingApproval[] {
    return this.approvals.pending();
  }

  /** The person-side answer to a pending approval (CLI or console). */
  resolveApproval(
    id: string,
    decision: ApprovalDecision,
    opts: { by?: "cli" | "console"; scope?: ApprovalScope; reason?: string } = {},
  ): DecisionResult {
    return this.approvals.decide(id, decision, opts);
  }

  /** Where one approval stands, or null when the id is unknown. */
  approvalStatus(id: string): PendingApproval | null {
    return this.approvals.status(id);
  }

  // ---------------------------------------------------------------- acting

  /**
   * Taps a ref, a text label, or a device-side selector.
   *
   * A ref is resolved against the current screen and tapped by coordinate; a
   * text or `On` selector goes through `Component.click`, which the device
   * resolves itself. Either way the step is gated first.
   */
  async tap(target: Target, opts: TapOptions = {}): Promise<ActionResult> {
    const resolved = await this.resolveTarget(target);
    if (resolved.kind === "miss") {
      return this.finish("tap", { target }, "not_found", `not_found · ${resolved.query}`, {
        screen: resolved.screen,
        query: resolved.query,
      });
    }

    const gate = await this.gate(
      "tap",
      target,
      resolved.labels,
      resolved.signature,
      resolved.screen,
      null,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) return this.finish("tap", { target }, gate.status, gate.text, { screen: resolved.screen, ...gate.extra });

    const before = resolved.screen;
    if (resolved.handle) {
      if (opts.long) await resolved.handle.longClick();
      else await resolved.handle.click();
    } else if (opts.long) {
      await this.gestures.longPress(resolved.point!, { holdMs: opts.holdMs ?? 800 });
    } else {
      await this.device.agent.click(resolved.point!.x, resolved.point!.y);
    }
    return this.after("tap", { target }, before);
  }

  /** Taps a device-side selector, bypassing the layout read. */
  async tapSelector(selector: On, opts: TapOptions = {}): Promise<ActionResult> {
    const gate = await this.gate(
      "tap",
      selector,
      [selectorText(selector)],
      selectorText(selector),
      undefined,
      null,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) {
      return this.finish("tap", { selector: selectorText(selector) }, gate.status, gate.text, gate.extra);
    }
    const handle = await this.components.find(selector);
    if (!handle) {
      return this.finish("tap", { selector: selectorText(selector) }, "not_found", `not_found · ${selectorText(selector)}`, {
        query: selectorText(selector),
      });
    }
    const before = await this.reader.read();
    this.lastScreen = before;
    if (opts.long) await handle.longClick();
    else await handle.click();
    return this.after("tap", { selector: selectorText(selector) }, before);
  }

  /**
   * Types into an input. Without a ref the focused field is used; a password
   * field is refused by the policy before any keystroke is sent.
   */
  async type(text: string, opts: TypeOptions = {}): Promise<ActionResult> {
    const before = await this.reader.read();
    this.lastScreen = before;
    const field = opts.ref !== undefined ? findElement(before, opts.ref) : before.elements.find((e) => e.focused && e.input);
    if (!field) {
      const query = opts.ref !== undefined ? `ref ${opts.ref}` : "a focused input";
      return this.finish("type", { text: "[redacted]", ref: opts.ref }, "not_found", `not_found · ${query}`, {
        screen: before,
        query,
      });
    }
    const gate = await this.gate(
      "type",
      { ref: field.ref },
      [field.label, ...field.state],
      field.signature,
      before,
      field.node,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) {
      return this.finish("type", { text: "[redacted]", ref: opts.ref }, gate.status, gate.text, {
        screen: before,
        ...gate.extra,
      });
    }
    // `InputTextMode` is the extension's own shape. Only `paste` is exposed
    // here: `addition` was measured to be a no-op on the `Driver.inputText`
    // path this method uses (it only appends through `Component.inputText`),
    // and offering a flag that silently does nothing is worse than not having
    // it. Omitting the mode entirely selects the default path.
    await this.device.agent.inputText(
      field.center.x,
      field.center.y,
      text,
      opts.paste ? { paste: true } : undefined,
    );
    return this.after("type", { text: "[redacted]", ref: opts.ref }, before);
  }

  /** Presses a named key (`back`, `home`, `power`, ...) or a numeric key code. */
  async pressKey(key: string | number): Promise<ActionResult> {
    const code = parseKeyName(key);
    const before = await this.reader.read();
    this.lastScreen = before;
    await this.device.agent.triggerKey(code);
    return this.after("key", { key: String(key) }, before);
  }

  async swipe(input: SwipeInput): Promise<ActionResult> {
    if (!input?.from || !input?.to) {
      throw new UitestError("a swipe needs both `from` and `to`", "EINVALIDARGUMENT");
    }
    const before = await this.reader.read();
    this.lastScreen = before;
    const gate = await this.gate(
      "swipe",
      input,
      labelsUnder(before, input.from, input.to),
      "",
      before,
      null,
      input.approvalId,
      input.approvalScope,
    );
    if (gate) return this.finish("swipe", { input }, gate.status, gate.text, { screen: before, ...gate.extra });
    await this.gestures.swipe(input.from, input.to, {
      steps: input.steps,
      durationMs: input.durationMs,
      holdMs: input.holdMs,
    });
    return this.after("swipe", { input }, before);
  }

  async longPress(target: Target, holdMs = 800): Promise<ActionResult> {
    return this.tap(target, { long: true, holdMs });
  }

  async doubleClick(target: Target, opts: TapOptions = {}): Promise<ActionResult> {
    const resolved = await this.resolveTarget(target);
    if (resolved.kind === "miss") {
      return this.finish("double-click", { target }, "not_found", `not_found · ${resolved.query}`, {
        screen: resolved.screen,
        query: resolved.query,
      });
    }
    const gate = await this.gate(
      "double-click",
      target,
      resolved.labels,
      resolved.signature,
      resolved.screen,
      null,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) {
      return this.finish("double-click", { target }, gate.status, gate.text, { screen: resolved.screen, ...gate.extra });
    }
    if (resolved.handle) await resolved.handle.doubleClick();
    else await this.gestures.doubleClick(resolved.point!);
    return this.after("double-click", { target }, resolved.screen);
  }

  /**
   * Two fingers moving apart or together.
   *
   * Either around an explicit `center`, or inside the element at `ref` — the
   * zoom surface a person would use. `scale` is the end distance as a multiple
   * of the start: 2 zooms in, 0.5 zooms out. The device needs a real
   * `PointerMatrix` for two simultaneous paths; the single-pointer channel
   * cannot express them.
   */
  async pinch(opts: PinchInput): Promise<ActionResult> {
    let center = opts.center;
    let span: number;
    const screen = await this.reader.read();
    this.lastScreen = screen;

    if (opts.ref !== undefined) {
      const element = screen.elements.find((e) => e.ref === opts.ref);
      if (!element) {
        return this.finish("pinch", { ref: opts.ref }, "not_found", `not_found · ref ${opts.ref}`, {
          screen,
          query: `ref ${opts.ref}`,
        });
      }
      center = element.center;
      // Start well inside the element so both fingers land on the zoom surface.
      span = Math.max(20, Math.round(Math.min(element.rect.width, element.rect.height) * 0.25));
    } else if (!center) {
      throw new UitestError("a pinch needs a center, or a ref to pinch inside", "EINVALIDARGUMENT");
    } else {
      span = opts.from ?? Math.round(Math.min(screen.display.width, screen.display.height) * 0.15);
    }

    const from = opts.from ?? span;
    const to = opts.to ?? Math.round(from * (opts.scale ?? 2));
    const args = { center, from, to };
    const gate = await this.gate(
      "pinch",
      args,
      labelsUnder(screen, center, center),
      "",
      screen,
      null,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) return this.finish("pinch", args, gate.status, gate.text, { screen, ...gate.extra });
    await this.gestures.pinch({ center, from, to });
    return this.after("pinch", args, screen);
  }

  /**
   * Presses, holds, then moves to `to`. The hold is what makes the device treat
   * this as dragging a held item instead of scrolling the list under it.
   */
  async drag(
    from: Point,
    to: Point,
    opts: { holdMs?: number; durationMs?: number; approvalId?: string; approvalScope?: ApprovalScope } = {},
  ): Promise<ActionResult> {
    if (!from || !to) {
      throw new UitestError("a drag needs both `from` and `to`", "EINVALIDARGUMENT");
    }
    const before = await this.reader.read();
    this.lastScreen = before;
    const gate = await this.gate(
      "drag",
      { from, to, holdMs: opts.holdMs },
      labelsUnder(before, from, to),
      "",
      before,
      null,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) return this.finish("drag", { from, to }, gate.status, gate.text, { screen: before, ...gate.extra });
    await this.gestures.drag(from, to, { holdMs: opts.holdMs, durationMs: opts.durationMs });
    return this.after("drag", { from, to }, before);
  }

  /** A fast swipe between two points: the release velocity keeps the list moving. */
  async fling(
    from: Point,
    to: Point,
    opts: { approvalId?: string; approvalScope?: ApprovalScope } = {},
  ): Promise<ActionResult> {
    if (!from || !to) {
      throw new UitestError("a fling needs both `from` and `to`", "EINVALIDARGUMENT");
    }
    const before = await this.reader.read();
    this.lastScreen = before;
    const gate = await this.gate(
      "fling",
      { from, to },
      labelsUnder(before, from, to),
      "",
      before,
      null,
      opts.approvalId,
      opts.approvalScope,
    );
    if (gate) return this.finish("fling", { from, to }, gate.status, gate.text, { screen: before, ...gate.extra });
    await this.gestures.fling(from, to);
    return this.after("fling", { from, to }, before);
  }

  /**
   * A fling in a direction, inside a box inset from the screen edge so the
   * gesture does not start on the system's own edge-swipe region.
   */
  async flingDirection(
    direction: string,
    opts: { approvalId?: string; approvalScope?: ApprovalScope } = {},
  ): Promise<ActionResult> {
    const screen = await this.screen();
    const area = {
      x: Math.round(screen.display.width * 0.12),
      y: Math.round(screen.display.height * 0.12),
      width: Math.round(screen.display.width * 0.76),
      height: Math.round(screen.display.height * 0.76),
    };
    const cx = area.x + Math.round(area.width / 2);
    const cy = area.y + Math.round(area.height / 2);
    const dx = Math.round(area.width * 0.3);
    const dy = Math.round(area.height * 0.3);
    const paths: Record<string, [Point, Point]> = {
      up: [{ x: cx, y: cy + dy }, { x: cx, y: cy - dy }],
      down: [{ x: cx, y: cy - dy }, { x: cx, y: cy + dy }],
      left: [{ x: cx + dx, y: cy }, { x: cx - dx, y: cy }],
      right: [{ x: cx - dx, y: cy }, { x: cx + dx, y: cy }],
    };
    const pair = paths[String(direction).toLowerCase()];
    if (!pair) {
      throw new UitestError("invalid_argument: direction must be up, down, left or right", "EINVALIDARGUMENT");
    }
    return this.fling(pair[0], pair[1], opts);
  }

  /**
   * Waits for a text label on the device. This is the call to prefer over
   * polling `observe` in a loop: one round trip, and the device sees layout
   * passes a host cannot.
   */
  async waitFor(query: string | On | { text: string }, opts: WaitForOptions = {}): Promise<ActionResult> {
    const selector =
      typeof query === "string" ? On.text(query) : query instanceof On ? query : On.text(query.text);
    const handle = await this.components.waitFor(selector, { timeoutMs: opts.timeoutMs ?? 10_000 });
    const screen = await this.reader.read();
    this.lastScreen = screen;
    if (!handle) {
      return this.finish("wait-for", { query: selectorText(selector) }, "not_found", `not_found · ${selectorText(selector)}`, {
        screen,
        query: selectorText(selector),
      });
    }
    return this.finish("wait-for", { query: selectorText(selector) }, "settled", renderFull(screen), { screen });
  }

  // ----------------------------------------------------------------- lists

  /**
   * Reads a scrolling list by paging it, one screen at a time.
   *
   * Each page is the labels inside the scroll container, in reading order. A
   * new page usually repeats the tail of the previous one, so the repeated
   * prefix is dropped before appending. Paging stops at the list's own end
   * marker, when a scroll reveals nothing new, or at the screen budget.
   */
  async readList(opts: ListOptions = {}): Promise<ReadListResult> {
    const maxScreens = Math.min(30, Math.max(1, opts.maxScreens ?? 8));
    const deadline = Date.now() + Math.min(60_000, Math.max(1000, opts.maxMs ?? 30_000));
    const seen = new Set<string>();
    const items: string[] = [];
    let complete = false;
    let screens = 0;
    let screen = await this.reader.read();
    this.lastScreen = screen;

    const container = findScrollContainer(screen, opts.ref);
    if (!container) {
      return await this.finishList(
        "not_found",
        "not_found · no scrollable list on screen; pass ref",
        [],
        false,
        0,
        screen,
      );
    }

    for (let page = 0; page < maxScreens; page++) {
      screens += 1;
      const labels = listPage(screen, container);
      const fresh = labels.filter((label) => !seen.has(label));
      for (const label of labels) seen.add(label);
      items.push(...fresh);
      if (/没有更多|no more|end of list|到底了|已显示全部/i.test(labels.join(" "))) {
        complete = true;
        break;
      }
      if (page > 0 && fresh.length === 0) break;
      if (Date.now() > deadline) break;
      if (page === maxScreens - 1) break;
      const next = await this.scrollContainer(screen, container);
      if (!next) break;
      screen = next;
    }
    return await this.finishList("settled", items.join("\n"), items, complete, screens, screen);
  }

  /**
   * Finds a target inside a scroll container by paging it one screen at a time.
   *
   * The first page is answered from the screen already on hand, so a visible
   * target costs no scroll at all.
   */
  async scrollUntilVisible(
    target: string | On | { text: string },
    opts: ListOptions & { timeoutMs?: number } = {},
  ): Promise<ActionResult> {
    const selector =
      typeof target === "string" ? On.text(target) : target instanceof On ? target : On.text(target.text);
    const label = selectorText(selector);

    // Host paging, not `Component.scrollSearch`. Measured on a real device: a
    // scrollSearch that misses blocks for 30 s (the request times out) and the
    // device's global lock stays held afterwards, so every later command fails
    // with "Disallow concurrent use". Paging costs one scroll per screen and
    // leaves the device usable; a search that hits is not worth that risk.
    const maxScreens = Math.min(30, Math.max(1, opts.maxScreens ?? 8));
    let screen = await this.reader.read();
    this.lastScreen = screen;
    const needle = label.toLowerCase().replace(/^text[~=]?"?|"$/g, "");
    for (let page = 0; page < maxScreens; page++) {
      if (screen.elements.some((e) => e.label.toLowerCase().includes(needle))) {
        return this.finish("scroll-until", { target: label }, "settled", `found ${label}
${renderFull(screen)}`, {
          screen,
        });
      }
      const box = findScrollContainer(screen, opts.ref);
      if (!box || page === maxScreens - 1) break;
      const next = await this.scrollContainer(screen, box);
      if (!next) break;
      screen = next;
    }
    return this.finish("scroll-until", { target: label }, "not_found", `not_found · ${label}`, {
      screen,
      query: label,
    });
  }

  // --------------------------------------------------------------- windows

  /**
   * Reports one window, optionally focusing or closing it first.
   *
   * The extension has no window enumeration, so a window is always addressed by
   * filter — the focused one, or the one a bundle owns. A filter that matches
   * nothing is `not_found`, not an error.
   */
  async window(filter: WindowFilter = {}, opts: WindowOptions = {}): Promise<WindowResult> {
    const handle = await this.components.window(filter);
    const screen = await this.reader.read();
    this.lastScreen = screen;
    const what = filter.focused ? "the focused window" : filter.bundleName ? `window ${filter.bundleName}` : "a window";
    if (!handle) {
      return (await this.finish("window", { ...filter, ...opts }, "not_found", `not_found · ${what}`, {
        screen,
        query: what,
        bundle: "",
        focused: false,
        bounds: null,
      })) as WindowResult;
    }
    if (opts.focus) await handle.focus();
    if (opts.close) await handle.close();
    const bundle = await handle.bundleName();
    const focused = opts.close ? false : await handle.isFocused();
    // A closed window's bounds are meaningless; ask only when it still exists.
    const bounds = opts.close ? null : await handle.bounds();
    const lines = [
      `${opts.close ? "closed" : opts.focus ? "focused" : "window"} ${bundle || what}`,
      `focused: ${focused ? "yes" : "no"}`,
      bounds ? `bounds: ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : "bounds: -",
    ];
    return (await this.finish("window", { ...filter, ...opts }, "settled", lines.join("\n"), {
      screen,
      bundle,
      focused,
      bounds,
    })) as WindowResult;
  }

  // -------------------------------------------------------------- settling

  /** Waits for the UI to stop changing and returns the settled screen. */
  async settle(previousHash?: string): Promise<ActionResult> {
    const result = await settle(this.reader, {
      previousHash,
      maxSettleMs: this.settleMs,
    });
    this.lastScreen = result.screen;
    const text = result.timedOut
      ? `uncertain · the UI did not settle within ${this.settleMs} ms\n${renderFull(result.screen)}`
      : renderFull(result.screen);
    if (result.timedOut) {
      return this.finish("settle", {}, "uncertain", text, {
        screen: result.screen,
        reason: `no stable screen within ${this.settleMs} ms`,
      });
    }
    return this.finish("settle", {}, "settled", text, { screen: result.screen });
  }

  /**
   * Checks that this session still owns the device, before a command runs.
   *
   * A one-command process is covered by `open` alone, but `mcp` keeps one
   * session for the life of the process: without this, a person's `hold` would
   * replace the lock file and the session would keep driving the phone.
   * Throws `LeaseHeldError` when the device moved; takes the device again when
   * the person handed it back with `resume`.
   */
  async assertLease(): Promise<void> {
    await this.lease?.reacquire();
  }

  // ---------------------------------------------------------------- finish

  /** Ends the task: releases the lease, stops the trace, disposes the device. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.trace?.flush();
    await this.lease?.release();
    await this.device.dispose?.();
  }

  // --------------------------------------------------------------- helpers

  private async resolveTarget(target: Target): Promise<ResolvedTarget> {
    if (typeof target === "number") return this.resolveRef(target);
    if (target instanceof On) {
      const handle = await this.components.find(target);
      const screen = await this.reader.read();
      this.lastScreen = screen;
      if (!handle) return { kind: "miss", query: selectorText(target), screen };
      const rect = await handle.bounds();
      return {
        kind: "hit",
        handle,
        point: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
        labels: [selectorText(target)],
        signature: selectorText(target),
        screen,
      };
    }
    if ("ref" in target) return this.resolveRef(target.ref);
    if ("text" in target) {
      const selector = On.text(target.text, "contains");
      const handle = await this.components.find(selector);
      const screen = await this.reader.read();
      this.lastScreen = screen;
      if (!handle) {
        // The device-side lookup can miss a label the layout model can see.
        const element = findText(screen, target.text);
        if (!element) return { kind: "miss", query: target.text, screen };
        return {
          kind: "hit",
          point: element.center,
          labels: [element.label],
          signature: element.signature,
          screen,
        };
      }
      const rect = await handle.bounds();
      return {
        kind: "hit",
        handle,
        point: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
        labels: [target.text],
        signature: `${target.text}|${rect.x},${rect.y},${rect.width},${rect.height}`,
        screen,
      };
    }
    throw new UitestError("a target must be a ref, { ref }, { text } or an On selector", "EINVALIDARGUMENT");
  }

  private async resolveRef(ref: number): Promise<ResolvedTarget> {
    const screen = await this.reader.read();
    this.lastScreen = screen;
    const element = findElement(screen, ref);
    if (!element) return { kind: "miss", query: `ref ${ref}`, screen };
    return {
      kind: "hit",
      point: element.center,
      labels: [element.label],
      signature: element.signature,
      screen,
    };
  }

  /**
   * Runs the policy and the approval check for one step.
   *
   * Returns null when the step may proceed. Otherwise the caller returns the
   * status as-is — nothing has touched the device at this point.
   */
  private async gate(
    command: string,
    args: unknown,
    labels: string[],
    signature: string,
    screen?: Screen,
    node?: UiNode | null,
    approvalId?: string,
    approvalScope?: ApprovalScope,
  ): Promise<GateOutcome | null> {
    if (screen?.locked) {
      // Acting on a locked phone reaches nothing but the lock screen, and the
      // policy below is written for apps. Stop before touching the device.
      return { status: "device_locked", text: actionText({ status: "device_locked", screen }), extra: {} };
    }
    if (screen) {
      const scope = this.policy.scope(screen.bundle);
      if (scope.kind === "block") {
        return { status: "blocked", text: `blocked_by_policy · rule: ${scope.rule}\n${scope.reason}`, extra: { rule: scope.rule, reason: scope.reason } };
      }
    }
    const decision = this.policy.check({ action: command, labels, node: node ?? null });
    if (decision.kind === "block") {
      return {
        status: "blocked",
        text: `blocked_by_policy · rule: ${decision.rule}\n${decision.reason}`,
        extra: { rule: decision.rule, reason: decision.reason },
      };
    }
    const step = { command, args: sanitize(args), signature };

    // A supplied approval is checked even when the step no longer needs one:
    // an id borrowed from another step must fail loudly, not be ignored.
    if (approvalId) {
      const result = this.approvals.consume(approvalId, step, { scope: approvalScope });
      if (result.kind === "approved") {
        // A remembered answer: the id itself stays single-use, but the rule it
        // carried now covers this app (and task, for `task`).
        const scope = result.scope ?? approvalScope;
        if ((scope === "task" || scope === "always") && result.rule) {
          this.grants.add({
            rule: result.rule,
            bundle: screen?.bundle ?? "",
            task: scope === "task" ? this.task : null,
            scope,
          });
        }
        return null;
      }
      if (result.kind === "pending") {
        return {
          status: "approval_pending",
          text:
            `approval_pending · approval_id: ${approvalId} · waiting for a person\n` +
            "The same command with the same approvalId proceeds once a person allows it.",
          extra: {
            approvalId,
            ...(decision.kind === "approval" ? { rule: decision.rule, reason: decision.reason } : {}),
          },
        };
      }
      if (result.kind === "stale") {
        return { status: "stale", text: `stale · ${result.reason}`, extra: { reason: result.reason } };
      }
      return {
        status: "approval_denied",
        text: `approval_denied · ${result.reason}`,
        extra: { reason: result.reason },
      };
    }
    if (decision.kind === "allow") return null;
    // A grant the person already gave covers this step without asking again.
    const standing = this.grants.permits({
      rule: decision.rule,
      bundle: screen?.bundle ?? "",
      task: this.task,
    });
    if (standing) return null;
    const pending = this.approvals.request(step, decision.rule, {
      bundle: screen?.bundle ?? "",
      task: this.task,
    });
    return {
      status: "approval_pending",
      text:
        `approval_pending · approval_id: ${pending.id} · rule: ${decision.rule} · waiting for a person\n` +
        `Ask the person to approve this exact step (${decision.reason}). Then repeat the same command with approvalId: ${pending.id}.`,
      extra: { approvalId: pending.id, rule: decision.rule, reason: decision.reason },
    };
  }

  /** Settles, diffs against the pre-action screen, and records the step. */
  private async after(command: string, args: unknown, before: Screen): Promise<ActionResult> {
    const result = await settle(this.reader, {
      previousHash: before.hash,
      maxSettleMs: this.settleMs,
    });
    this.lastScreen = result.screen;
    const diff = renderDiff(before, result.screen);
    if (result.timedOut) {
      return this.finish(command, args, "uncertain", `${diff.text}\nsettle: timeout`, {
        screen: result.screen,
        diff,
        reason: `the UI did not settle within ${this.settleMs} ms`,
      });
    }
    return this.finish(command, args, "settled", diff.text, { screen: result.screen, diff });
  }

  /** Scrolls a container up by one page and returns the settled screen. */
  private async scrollContainer(before: Screen, container: ScreenElement): Promise<Screen | null> {
    const x = container.rect.x + Math.round(container.rect.width / 2);
    const fromY = container.rect.y + Math.round(container.rect.height * 0.8);
    const toY = container.rect.y + Math.round(container.rect.height * 0.2);
    await this.gestures.swipe({ x, y: fromY }, { x, y: toY }, { durationMs: 300 });
    const result = await settle(this.reader, { previousHash: before.hash, maxSettleMs: Math.min(2000, this.settleMs) });
    this.lastScreen = result.screen;
    if (result.screen.hash === before.hash) return null;
    return result.screen;
  }

  private async finishList(
    status: "settled" | "not_found",
    text: string,
    items: string[],
    complete: boolean,
    screens: number,
    screen: Screen,
  ): Promise<ReadListResult> {
    const base =
      status === "settled"
        ? await this.finish(
            "read-list",
            {},
            "settled",
            `screens: ${screens} · complete: ${complete}\n${items.join("\n")}`,
            { screen },
          )
        : await this.finish("read-list", {}, "not_found", text, { screen, query: "a scrollable list" });
    return Object.assign(base, { items, complete, screens }) as unknown as ReadListResult;
  }

  private async saveShot(path: string, screen?: Screen): Promise<string> {
    const frame = await this.device.agent.captureScreen();
    const ctx = await this.reader.context();
    const shot = await Screenshot.from(frame, ctx);
    // A code the text render masks must not be readable in the pixels either.
    // The layout is read again after the frame: if a code appeared between the
    // screen text and the capture, its box is still in the union. Over-masking
    // is harmless; under-masking is the leak.
    let fresh: Screen | null = null;
    try {
      fresh = await this.reader.read();
    } catch {
      // A device hiccup here must not cost the screenshot; the passed screen
      // still covers everything it saw.
    }
    const rects = [...(screen?.elements ?? []), ...(fresh?.elements ?? [])]
      .filter((e) => e.masked)
      .map((e) => e.rect);
    return shot.redact(rects).save(path);
  }

  /** How many steps this session has recorded. */
  get steps(): number {
    return this.stepCount;
  }

  /**
   * Records a step the session did not run through its own action path.
   *
   * `apps`, `doctor` and `launch` answer from hdc rather than a screen read, so
   * they never reach `finish`. A report that says "every step" has to include
   * the step that changed the app, so the command layer records those here.
   */
  record(command: string, args: unknown, status: ActionResult["status"], text: string): void {
    this.stepCount += 1;
    this.trace?.step({ command, args: sanitize(args), status, text, shot: null });
  }

  private async finish(
    command: string,
    args: unknown,
    status: ActionResult["status"],
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<ActionResult> {
    this.stepCount += 1;
    const screen = (extra.screen as Screen | null | undefined) ?? this.lastScreen;
    const shot = this.traceShots && screen ? await this.autoShot(command, screen) : null;
    const { screen: _s, ...rest } = extra;
    const result = {
      status,
      screen: screen ?? null,
      step: this.stepCount,
      shot,
      ...rest,
    } as ActionResult;
    this.trace?.step({
      command,
      args: sanitize(args),
      status,
      text,
      shot,
    });
    return result;
  }

  private async autoShot(label: string, screen: Screen): Promise<string | null> {
    try {
      const file = join(
        this.shotsDir,
        `${String(this.stepCount).padStart(3, "0")}-${label}.jpg`,
      );
      return await this.saveShot(file, screen);
    } catch {
      return null;
    }
  }
}

/** Keeps `screen` out of the trace: it is large and already in the step text. */
/**
 * The step as the trace and the approval hash see it: no screen (large, and
 * already in the step text) and no approval id (that is the answer to the
 * step, not part of it).
 */
function sanitize(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object") return {};
  const { screen: _screen, approvalId: _approvalId, ...rest } = args as Record<string, unknown>;
  return rest;
}

/**
 * The list container a caller means: an explicit ref, else the largest
 * scrollable that covers a real part of the screen. Small scrollables are
 * usually a carousel or a nested strip, not the list being read.
 */
function findScrollContainer(screen: Screen, ref?: number): ScreenElement | null {
  if (ref !== undefined) return findElement(screen, ref);
  const area = (e: ScreenElement) => e.rect.width * e.rect.height;
  const screenArea = screen.display.width * screen.display.height;
  const scrollables = screen.elements
    .filter((e) => e.scrollable && area(e) >= screenArea * 0.2)
    .sort((a, b) => area(b) - area(a));
  return scrollables[0] ?? null;
}

/** Labels inside a container, top to bottom, left to right. */
function listPage(screen: Screen, container: ScreenElement): string[] {
  const inside = (e: ScreenElement) => {
    const cx = e.rect.x + e.rect.width / 2;
    const cy = e.rect.y + e.rect.height / 2;
    return (
      cx >= container.rect.x &&
      cx <= container.rect.x + container.rect.width &&
      cy >= container.rect.y &&
      cy <= container.rect.y + container.rect.height
    );
  };
  return screen.elements
    .filter(
      (e) =>
        e !== container &&
        e.label &&
        // The container is rebuilt every screen; its bounds are what identify it.
        !(e.role === "list" && sameRect(e.rect, container.rect)) &&
        inside(e),
    )
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .map((e) => e.label);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function labelsUnder(screen: Screen, from: Point, to: Point): string[] {
  const hits = [...nodesAt(screen, from), ...nodesAt(screen, to)];
  return [...new Set(hits.map((e) => e.label).filter(Boolean))];
}

function nodesAt(screen: Screen, p: Point): ScreenElement[] {
  return screen.elements.filter(
    (e) => p.x >= e.rect.x && p.x < e.rect.x + e.rect.width && p.y >= e.rect.y && p.y < e.rect.y + e.rect.height,
  );
}

type ResolvedTarget =
  | {
      kind: "hit";
      point: Point;
      labels: string[];
      signature: string;
      screen: Screen;
      handle?: ComponentHandle;
    }
  | { kind: "miss"; query: string; screen: Screen };

interface GateOutcome {
  status: Extract<
    ActionResult["status"],
    "blocked" | "approval_pending" | "approval_denied" | "stale" | "device_locked"
  >;
  text: string;
  extra: Record<string, unknown>;
}

export { ElementNotFoundError, On };
