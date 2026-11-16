import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ApprovalScope } from "./approvals.js";
import { doctor, renderDoctor } from "./doctor.js";
import { EXIT_CODE, actionText, statusOf } from "./agent/result.js";
import type { ActionResult, ActionStatus } from "./agent/result.js";
import { renderFull } from "./agent/screen.js";
import { parseOn } from "./agent/selector.js";
import { parseKeyName } from "./agent/selector.js";
import { LeaseHeldError, UitestError } from "./errors.js";
import { HOLD_TASK, handoffDevice } from "./hold.js";
import type { Session, SessionDevice, Target } from "./session.js";
import type { TraceRecorder } from "./trace.js";

export type ArgType = "string" | "number" | "boolean";

export interface CommandSpec {
  name: string;
  description: string;
  args: Record<string, { type: ArgType; description: string; required?: boolean }>;
}

/**
 * The command surface shared by the CLI and the MCP server.
 *
 * Both front ends call `CommandRunner.run`, so a command means the same thing
 * wherever it is invoked, and the argument names are the same too. `COMMANDS`
 * is the single place a new command is declared; the MCP tool schema and the
 * `--help` text are generated from it.
 */
export const COMMANDS: CommandSpec[] = [
  {
    name: "observe",
    description: "Read what is on screen: one line per element with a ref, role, label and position.",
    args: {
      out: { type: "string", description: "Save a JPEG screenshot to this path." },
      waitMs: { type: "number", description: "Wait up to this long for the screen to change first." },
    },
  },
  {
    name: "tap",
    description: "Tap an element by ref, by text, or by a selector string like type=Button&text=Save.",
    args: {
      ref: { type: "number", description: "Element ref from the last observe." },
      text: { type: "string", description: "Visible label to tap (substring match)." },
      selector: { type: "string", description: "Selector: text=, text~=, type=, id=, clickable, chained with &." },
      x: { type: "number", description: "Raw x coordinate (use with y)." },
      y: { type: "number", description: "Raw y coordinate (use with x)." },
      long: { type: "boolean", description: "Hold instead of tapping." },
      approvalId: { type: "string", description: "Approval id a person handed back for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "type",
    description: "Type into the focused input, or the input at a ref.",
    args: {
      text: { type: "string", description: "Text to type.", required: true },
      ref: { type: "number", description: "Input element ref; defaults to the focused field." },
      approvalId: { type: "string", description: "Approval id for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "swipe",
    description: "Swipe between two points, or in a direction.",
    args: {
      from: { type: "string", description: "Start point as x,y." },
      to: { type: "string", description: "End point as x,y." },
      direction: { type: "string", description: "up, down, left or right (instead of from/to)." },
      ref: { type: "number", description: "Swipe inside this element." },
      durationMs: { type: "number", description: "Gesture duration in ms." },
      approvalId: { type: "string", description: "Approval id for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "double-click",
    description: "Double-tap an element by ref, text or selector.",
    args: {
      ref: { type: "number", description: "Element ref from the last observe." },
      text: { type: "string", description: "Visible label (substring match)." },
      selector: { type: "string", description: "Selector: text=, text~=, type=, id=, chained with &." },
      approvalId: { type: "string", description: "Approval id for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "drag",
    description: "Press, hold, and move between two points — a reorder gesture, not a scroll.",
    args: {
      from: { type: "string", description: "Start point as x,y.", required: true },
      to: { type: "string", description: "End point as x,y.", required: true },
      holdMs: { type: "number", description: "How long to hold before moving (default 300)." },
      durationMs: { type: "number", description: "Movement duration in ms." },
      approvalId: { type: "string", description: "Approval id for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "fling",
    description: "A fast swipe, so the list keeps moving after release.",
    args: {
      from: { type: "string", description: "Start point as x,y." },
      to: { type: "string", description: "End point as x,y." },
      direction: { type: "string", description: "up, down, left or right (instead of from/to)." },
      approvalId: { type: "string", description: "Approval id for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "pinch",
    description: "Two fingers apart or together: zoom in or out, around a point or inside an element.",
    args: {
      ref: { type: "number", description: "Element to pinch inside; its middle is the center." },
      center: { type: "string", description: "Center as x,y, when no ref is given." },
      from: { type: "number", description: "Half-distance between the fingers at the start." },
      to: { type: "number", description: "Half-distance at the end." },
      scale: { type: "number", description: "End distance as a multiple of the start: 2 zooms in, 0.5 zooms out." },
      approvalId: { type: "string", description: "Approval id for this exact step." },
      approvalScope: { type: "string", description: "With approvalId: once (default), task, or always." },
    },
  },
  {
    name: "key",
    description: "Press a named key (back, home, power, enter, ...) or a numeric key code.",
    args: {
      key: { type: "string", description: "Key name or numeric code.", required: true },
    },
  },
  {
    name: "wait-for",
    description: "Wait for a label to appear, using the device-side wait.",
    args: {
      text: { type: "string", description: "Label to wait for.", required: true },
      timeoutMs: { type: "number", description: "Give up after this long." },
    },
  },
  {
    name: "read-list",
    description: "Page through a scrolling list and return every label once.",
    args: {
      ref: { type: "number", description: "Scroll container ref; the largest on screen by default." },
      maxScreens: { type: "number", description: "Stop after this many screens." },
    },
  },
  {
    name: "scroll-until",
    description: "Scroll a list until a label appears.",
    args: {
      text: { type: "string", description: "Label to find.", required: true },
      ref: { type: "number", description: "Scroll container ref." },
      maxScreens: { type: "number", description: "Stop after this many screens." },
    },
  },
  {
    name: "launch",
    description: "Start an app by name or bundle id.",
    args: {
      app: { type: "string", description: "App name or bundle id.", required: true },
      ability: { type: "string", description: "Ability name, when the resolved entry is not the one you want." },
    },
  },
  {
    name: "apps",
    description: "List installed bundles, find one, name the foreground app, or check one is installed.",
    args: {
      query: { type: "string", description: "Filter by substring." },
      current: { type: "boolean", description: "Report the foreground app instead of listing." },
      has: { type: "string", description: "Answer whether this bundle is installed." },
    },
  },
  {
    name: "window",
    description: "Report a window: the focused one, or the one a bundle owns.",
    args: {
      bundleName: { type: "string", description: "Bundle whose window to report." },
      focus: { type: "boolean", description: "Bring the window to the front first." },
      close: { type: "boolean", description: "Close the window." },
    },
  },
  {
    name: "doctor",
    description: "Check which device capabilities this extension actually has.",
    args: {},
  },
  {
    name: "screenshot",
    description: "Save a JPEG of the screen and report its geometry.",
    args: {
      out: { type: "string", description: "Output path; a timestamped file under the state dir by default." },
    },
  },
  {
    name: "inspect",
    description:
      "Box and number every element on a screenshot; the numbers are refs. Optionally write an HTML panel with the node table.",
    args: {
      out: { type: "string", description: "Annotated JPEG path; a timestamped file under the state dir by default." },
      html: { type: "string", description: "Also write a self-contained HTML panel (image + node table) here." },
    },
  },
  {
    name: "report",
    description: "Write an HTML report of every step this task has recorded, across commands.",
    args: {
      task: { type: "string", description: "Task to report; default is this session's task." },
      title: { type: "string", description: "Report title." },
    },
  },
  {
    name: "status",
    description: "Report the session: task, device tag, policy, pending approvals.",
    args: {},
  },
  {
    name: "handoff",
    description:
      "Ask the person to take the phone for a step only they can do (sign in, enter a one-time code, unlock it), and stop until they run resume.",
    args: {
      reason: {
        type: "string",
        description: "What the person must do, in one line they will read.",
        required: true,
      },
    },
  },
];

export interface RunResult {
  status: ActionStatus;
  code: number;
  text: string;
  data?: Record<string, unknown>;
}

export interface RunnerOptions {
  stateDir: string;
  device: SessionDevice;
  /** Overrides the session's trace when `report` is called. */
  trace?: TraceRecorder | null;
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The fields a non-settled status carries, as data a caller can act on.
 * `status` is added by the caller, so it is not repeated here.
 */
function resultDetails(r: ActionResult): Record<string, unknown> {
  switch (r.status) {
    case "uncertain":
      return { reason: r.reason };
    case "not_found":
      return { query: r.query };
    case "blocked":
      return { rule: r.rule, reason: r.reason };
    case "approval_pending":
      return { approvalId: r.approvalId, rule: r.rule, reason: r.reason };
    case "approval_denied":
    case "stale":
      return { reason: r.reason };
    case "lease_held":
      return { task: r.task };
    case "handoff":
      return { task: r.task, reason: r.reason };
    case "device_locked":
    case "device_needs_setup":
    case "device_offline":
      return {};
    default:
      return {};
  }
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  return s.length ? s : undefined;
}

function asScope(value: unknown): ApprovalScope | undefined {
  const scope = asString(value);
  if (scope === undefined) return undefined;
  if (scope === "once" || scope === "task" || scope === "always") return scope;
  throw new UitestError(
    `invalid_argument: approval-scope must be once, task or always — got "${scope}"`,
    "EINVALIDARGUMENT",
  );
}

function asPoint(value: unknown): { x: number; y: number } | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const [x, y] = raw.split(",").map((v) => Number(v.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new UitestError(`a point must be x,y — got ${JSON.stringify(raw)}`, "EINVALIDARGUMENT");
  }
  return { x: Math.round(x!), y: Math.round(y!) };
}

/**
 * Executes one command against one session. Everything the CLI and the MCP
 * server expose goes through here, so both front ends behave identically.
 */
export class CommandRunner {
  constructor(
    private readonly session: Session,
    private readonly opts: RunnerOptions,
  ) {}

  async run(name: string, raw: Record<string, unknown>): Promise<RunResult> {
    const spec = COMMANDS.find((c) => c.name === name);
    if (!spec) {
      throw new UitestError(
        `unknown command "${name}"; commands: ${COMMANDS.map((c) => c.name).join(", ")}`,
        "EUNKNOWNCOMMAND",
      );
    }
    for (const [key, arg] of Object.entries(spec.args)) {
      if (arg.required && asString(raw[key]) === undefined && asNumber(raw[key]) === undefined) {
        throw new UitestError(`invalid_argument: ${name} needs ${key}`, "EINVALIDARGUMENT");
      }
    }

    // Handing the device over is the one command that must work precisely
    // when the session is losing it: it writes the person's lease itself, so
    // it runs before the ownership check instead of being stopped by it.
    if (name === "handoff") return this.handoff(raw);

    // A long-lived MCP session must notice that a person took the phone. The
    // check is one file read; on a session that still owns the device it is a
    // no-op, and after `resume` it takes the device again.
    try {
      await this.session.assertLease();
    } catch (e) {
      if (!(e instanceof LeaseHeldError)) throw e;
      const text = e.message;
      this.session.record(name, raw, "lease_held", text);
      return { status: "lease_held", code: EXIT_CODE.lease_held, text };
    }

    // Some commands answer from hdc instead of the session's action path
    // (`apps`, `doctor`, `launch`, `report`, `status`), so they would leave no
    // trace. Record whatever the session did not record itself.
    const before = this.session.steps;
    const result = await this.dispatch(name, raw);
    if (this.session.steps === before) {
      this.session.record(name, raw, result.status, result.text);
    }
    return result;
  }

  private async dispatch(name: string, raw: Record<string, unknown>): Promise<RunResult> {
    switch (name) {
      case "observe":
        return this.observe(raw);
      case "tap":
        return this.tap(raw);
      case "type": {
        const r = await this.session.type(String(raw.text), {
          approvalId: asString(raw.approvalId),
          approvalScope: asScope(raw.approvalScope),
          ref: asNumber(raw.ref),
        });
        return this.result(r, `typed ${String(raw.text).length} characters`);
      }
      case "swipe":
        return this.swipe(raw);
      case "double-click": {
        const target = this.targetFrom(raw);
        return this.result(
          await this.session.doubleClick(target, {
            approvalId: asString(raw.approvalId),
            approvalScope: asScope(raw.approvalScope),
          }),
        );
      }
      case "drag": {
        const from = asPoint(raw.from);
        const to = asPoint(raw.to);
        if (!from || !to) {
          throw new UitestError("invalid_argument: drag needs both from and to as x,y", "EINVALIDARGUMENT");
        }
        return this.result(
          await this.session.drag(from, to, {
            holdMs: asNumber(raw.holdMs),
            durationMs: asNumber(raw.durationMs),
            approvalId: asString(raw.approvalId),
            approvalScope: asScope(raw.approvalScope),
          }),
        );
      }
      case "fling": {
        const from = asPoint(raw.from);
        const to = asPoint(raw.to);
        const opts = {
          approvalId: asString(raw.approvalId),
          approvalScope: asScope(raw.approvalScope),
        };
        if (from && to) return this.result(await this.session.fling(from, to, opts));
        return this.result(await this.session.flingDirection(String(raw.direction ?? ""), opts));
      }
      case "pinch": {
        const center = asPoint(raw.center);
        const ref = asNumber(raw.ref);
        if (!center && ref === undefined) {
          throw new UitestError("invalid_argument: pinch needs center, or ref", "EINVALIDARGUMENT");
        }
        const r = await this.session.pinch({
          ref,
          center,
          from: asNumber(raw.from),
          to: asNumber(raw.to),
          scale: asNumber(raw.scale),
          approvalId: asString(raw.approvalId),
          approvalScope: asScope(raw.approvalScope),
        });
        return this.result(r);
      }
      case "key": {
        const r = await this.session.pressKey(raw.key as string);
        return this.result(r, `pressed ${String(raw.key)} (code ${parseKeyName(raw.key as string)})`);
      }
      case "wait-for": {
        const r = await this.session.waitFor(String(raw.text), { timeoutMs: asNumber(raw.timeoutMs) });
        return this.result(r);
      }
      case "read-list": {
        const r = await this.session.readList({
          ref: asNumber(raw.ref),
          maxScreens: asNumber(raw.maxScreens),
        });
        return {
          status: r.status,
          code: statusOf(r),
          text: r.status === "settled" ? r.items.join("\n") : `not_found: no scrollable list`,
          data: { items: r.items, complete: r.complete, screens: r.screens },
        };
      }
      case "scroll-until": {
        const r = await this.session.scrollUntilVisible(String(raw.text), {
          ref: asNumber(raw.ref),
          maxScreens: asNumber(raw.maxScreens),
        });
        return this.result(r);
      }
      case "launch":
        return this.launch(raw);
      case "apps":
        return this.apps(raw);
      case "window":
        return this.window(raw);
      case "doctor": {
        const report = await doctor(this.opts.device, this.session);
        return { status: "settled", code: 0, text: renderDoctor(report), data: { ...report } };
      }
      case "screenshot":
        return this.screenshot(raw);
      case "inspect":
        return this.inspect(raw);
      case "report":
        return this.report(raw);
      case "status":
        return this.status();
      default:
        throw new UitestError(`unknown command "${name}"`, "EUNKNOWNCOMMAND");
    }
  }

  /**
   * Gives the phone to the person and ends the agent's turn.
   *
   * The status is `handoff`, not `settled`: the step the agent wanted did not
   * happen, and nothing should be retried until a person runs `resume`. Exit
   * code 2 puts it with `lease_held`, which is the same instruction to a
   * caller — the device is not yours right now.
   */
  private async handoff(raw: Record<string, unknown>): Promise<RunResult> {
    const reason = String(raw.reason).replace(/\s+/g, " ").trim();
    const result = await handoffDevice({
      stateDir: this.opts.stateDir,
      tag: this.session.tag,
      reason,
    });
    const lines = [
      "handoff · the phone is with the person",
      `reason: ${reason}`,
      "Stop here and tell them what you need. They will run `uitest-phone resume` when done;",
      "then observe and continue. Until then every command returns lease_held.",
    ];
    if (result.tookOverFrom) lines.push(`handed over from task: ${result.tookOverFrom}`);
    const text = lines.join("\n");
    // The trace is the record the person gets at the end: the step where the
    // agent asked for help belongs in it.
    this.session.record("handoff", raw, "handoff", text);
    return {
      status: "handoff",
      code: EXIT_CODE.handoff,
      text,
      data: { task: HOLD_TASK, reason, tookOverFrom: result.tookOverFrom ?? null },
    };
  }

  private async observe(raw: Record<string, unknown>): Promise<RunResult> {
    const waitMs = asNumber(raw.waitMs);
    if (waitMs && waitMs > 0) {
      const before = await this.session.screen();
      const deadline = Date.now() + Math.min(30_000, waitMs);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        if ((await this.session.screen()).hash !== before.hash) break;
      }
    }
    const out = asString(raw.out);
    const r = await this.session.observe({ out });
    const screen = r.screen;
    const body = screen
      ? `${screen.header}\n${screen.lines.join("\n")}${out ? `\nsaved: ${out}` : ""}`
      : "not_found: no screen";
    // On the lock screen the status is the answer; the elements below are
    // context, not a page to choose from. Keep the instruction above them.
    const text = r.status === "settled" ? body : `${actionText(r)}\n${body}`;
    return {
      status: r.status,
      code: statusOf(r),
      text,
      data: {
        bundle: screen?.bundle,
        elements: screen?.elements.length ?? 0,
        firstRef: screen?.elements[0]?.ref,
        hash: screen?.hash,
        shot: out ?? null,
      },
    };
  }

  /** The target a ref/text/selector command was given. */
  private targetFrom(raw: Record<string, unknown>): Target {
    const selector = asString(raw.selector);
    if (selector) return parseOn(selector);
    const text = asString(raw.text);
    if (text) return { text };
    const ref = asNumber(raw.ref);
    if (ref !== undefined) return ref;
    throw new UitestError("invalid_argument: needs ref, text or selector", "EINVALIDARGUMENT");
  }

  private async tap(raw: Record<string, unknown>): Promise<RunResult> {
    const approvalId = asString(raw.approvalId);
    const approvalScope = asScope(raw.approvalScope);
    const long = raw.long === true || raw.long === "true";
    const ref = asNumber(raw.ref);
    const text = asString(raw.text);
    const selector = asString(raw.selector);
    const x = asNumber(raw.x);
    const y = asNumber(raw.y);

    if (selector) {
      return this.result(
        await this.session.tapSelector(parseOn(selector), { approvalId, approvalScope, long }),
      );
    }
    if (text) return this.result(await this.session.tap({ text }, { approvalId, approvalScope, long }));
    if (ref !== undefined) return this.result(await this.session.tap(ref, { approvalId, approvalScope, long }));
    if (x !== undefined && y !== undefined) {
      const before = await this.session.screen();
      await this.session.swipe({
        from: { x, y },
        to: { x, y },
        steps: 1,
        durationMs: 1,
        approvalId,
        approvalScope,
      });
      return this.result(await this.session.settle(before.hash));
    }
    throw new UitestError("invalid_argument: tap needs ref, text or selector", "EINVALIDARGUMENT");
  }

  private async swipe(raw: Record<string, unknown>): Promise<RunResult> {
    const from = asPoint(raw.from);
    const to = asPoint(raw.to);
    const durationMs = asNumber(raw.durationMs);
    const approvalId = asString(raw.approvalId);
    const approvalScope = asScope(raw.approvalScope);
    if (from && to) {
      return this.result(await this.session.swipe({ from, to, durationMs, approvalId, approvalScope }));
    }
    const direction = asString(raw.direction)?.toLowerCase();
    if (!direction) {
      throw new UitestError("invalid_argument: swipe needs from/to, or direction", "EINVALIDARGUMENT");
    }
    const screen = await this.session.screen();
    const box = raw.ref !== undefined
      ? screen.elements.find((e) => e.ref === asNumber(raw.ref))?.rect
      : undefined;
    const area = box ?? {
      x: Math.round(screen.display.width * 0.12),
      y: Math.round(screen.display.height * 0.12),
      width: Math.round(screen.display.width * 0.76),
      height: Math.round(screen.display.height * 0.76),
    };
    const cx = area.x + Math.round(area.width / 2);
    const cy = area.y + Math.round(area.height / 2);
    const dx = Math.round(area.width * 0.3);
    const dy = Math.round(area.height * 0.3);
    const points: Record<string, [{ x: number; y: number }, { x: number; y: number }]> = {
      up: [{ x: cx, y: cy + dy }, { x: cx, y: cy - dy }],
      down: [{ x: cx, y: cy - dy }, { x: cx, y: cy + dy }],
      left: [{ x: cx + dx, y: cy }, { x: cx - dx, y: cy }],
      right: [{ x: cx - dx, y: cy }, { x: cx + dx, y: cy }],
    };
    const pair = points[direction];
    if (!pair) {
      throw new UitestError("invalid_argument: direction must be up, down, left or right", "EINVALIDARGUMENT");
    }
    return this.result(
      await this.session.swipe({ from: pair[0], to: pair[1], durationMs, approvalId, approvalScope }),
    );
  }

  private async launch(raw: Record<string, unknown>): Promise<RunResult> {
    if (!this.session.apps) {
      throw new UitestError("launch needs an hdc connection", "ENOHDC");
    }
    const before = await this.session.screen();
    const result = await this.session.apps.launch(String(raw.app), { ability: asString(raw.ability) });
    // The app's own window can take a moment to come up; poll for its bundle
    // rather than declaring success the instant `aa` returns.
    const deadline = Date.now() + 5000;
    let screen = before;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      screen = await this.session.screen();
      if (screen.bundle === result.bundle) break;
    }
    return {
      status: "settled",
      code: 0,
      text: `launched ${result.bundle} · ${result.ability}\n${screen.header}`,
      data: { bundle: result.bundle, ability: result.ability },
    };
  }

  private async apps(raw: Record<string, unknown>): Promise<RunResult> {
    const apps = this.session.apps;
    if (!apps) throw new UitestError("apps needs an hdc connection", "ENOHDC");

    // The two questions an agent asks most: what is in front, and is this
    // bundle installed. Both answer with a status rather than a bare list.
    const has = asString(raw.has);
    if (has) {
      const installed = await apps.has(has);
      return {
        status: installed ? "settled" : "not_found",
        code: installed ? 0 : 1,
        text: installed ? `installed: ${has}` : `not_found · ${has} is not installed`,
        data: { bundle: has, installed },
      };
    }
    if (raw.current === true || raw.current === "true") {
      const info = await apps.current();
      if (!info) {
        return {
          status: "not_found",
          code: 1,
          text: "not_found · no foreground app (the device may be locked)",
          data: { bundle: null },
        };
      }
      return {
        status: "settled",
        code: 0,
        text: info.ability ? `${info.bundle} · ${info.ability}` : info.bundle,
        data: { bundle: info.bundle, ability: info.ability ?? null },
      };
    }

    const query = asString(raw.query) ?? "";
    const list = query ? await apps.find(query) : await apps.list();
    return {
      status: "settled",
      code: 0,
      text: `${list.length} apps\n${list.join("\n")}`,
      data: { count: list.length, apps: list },
    };
  }

  private async window(raw: Record<string, unknown>): Promise<RunResult> {
    const bundleName = asString(raw.bundleName);
    const r = await this.session.window(
      bundleName ? { bundleName } : { focused: true },
      { focus: raw.focus === true, close: raw.close === true },
    );
    if (r.status === "not_found") {
      return {
        status: r.status,
        code: statusOf(r),
        text: `not_found · no ${bundleName ? `window for ${bundleName}` : "focused window"}`,
        data: { query: r.query, bundle: "" },
      };
    }
    const bounds = r.bounds;
    const verb = raw.close === true ? "closed" : raw.focus === true ? "focused" : "window";
    const text = [
      `${verb} ${r.bundle || "(no bundle)"}`,
      `focused: ${r.focused ? "yes" : "no"}`,
      bounds ? `bounds: ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : "bounds: -",
    ].join("\n");
    return {
      status: "settled",
      code: 0,
      text,
      data: { bundle: r.bundle, focused: r.focused, bounds },
    };
  }

  private async screenshot(raw: Record<string, unknown>): Promise<RunResult> {
    const out = asString(raw.out) ?? join(this.opts.stateDir, "shots", `shot-${Date.now()}.jpg`);
    await mkdir(dirname(out), { recursive: true });
    const r = await this.session.observe({ out });
    return {
      status: r.status,
      code: statusOf(r),
      text: `saved: ${out}\nJPEG is half the display size; use display coordinates for taps`,
      data: { path: out, shot: r.shot },
    };
  }

  private async inspect(raw: Record<string, unknown>): Promise<RunResult> {
    const out = asString(raw.out) ?? join(this.opts.stateDir, "shots", `inspect-${Date.now()}.jpg`);
    const html = asString(raw.html);
    const r = await this.session.inspect({ out, html });
    const settled = r.status === "settled";
    const body = r.screen ? renderFull(r.screen) : "";
    const saved = settled
      ? `\nsaved: ${out}${html ? `\npanel: ${html}` : ""}` +
        "\nnumbers on the image are refs: tap --ref N"
      : "";
    return {
      status: r.status,
      code: statusOf(r),
      text: settled ? `${body}${saved}` : `${actionText(r)}${body ? `\n${body}` : ""}`,
      data: {
        image: settled ? (r.image ?? null) : null,
        html: settled ? (r.html ?? null) : null,
        nodes: r.nodes ?? [],
        elements: r.screen?.elements.length ?? 0,
        bundle: r.screen?.bundle,
      },
    };
  }

  private async report(raw: Record<string, unknown>): Promise<RunResult> {
    const trace = this.opts.trace ?? this.session.trace;
    if (!trace) {
      return { status: "settled", code: 0, text: "report: tracing is disabled for this session" };
    }
    // A task's steps are spread over one file per command, because each CLI
    // invocation is its own process. The trace reads them back by task name.
    const out = await trace.taskReport({
      task: asString(raw.task) ?? this.session.task,
      title: asString(raw.title),
    });
    const where = out.files > 1 ? ` from ${out.files} trace files` : "";
    return {
      status: "settled",
      code: 0,
      text: `report: ${out.path}\ntask: ${out.task || "-"} · steps ${out.steps}${where}`,
      data: { path: out.path, task: out.task, steps: out.steps, files: out.files },
    };
  }

  private status(): RunResult {
    const policy = this.session.policy.describe();
    const grants = this.session.grantList();
    const grantText = grants.length
      ? grants.map((g) => `${g.rule}@${g.bundle || "unknown"} (${g.scope})`).join(", ")
      : "none";
    const lines = [
      `settled · connected`,
      `task: ${this.session.task}`,
      `device: ${this.session.tag}`,
      `read-only: ${policy.readOnly}`,
      `confirm: ${policy.confirm.join(",") || "none"}`,
      `apps: ${policy.apps.join(",") || "all"}`,
      // Standing approvals are part of what the agent may do without asking;
      // hiding them would make the policy line a half-truth.
      `grants: ${grantText}`,
    ];
    return {
      status: "settled",
      code: 0,
      text: lines.join("\n"),
      data: { task: this.session.task, device: this.session.tag, ...policy, grants },
    };
  }

  private result(r: ActionResult, note?: string): RunResult {
    if (r.status === "settled") {
      const text = `${note ? `${note}\n` : ""}${r.screen?.header ?? ""}\n${r.screen?.lines.join("\n") ?? ""}`;
      return { status: r.status, code: statusOf(r), text: text.trim(), data: { status: r.status } };
    }
    // A non-settled status is the whole answer, and the fields it carries are
    // what the caller acts on: the approval id to repeat the step with, or the
    // rule that refused. Dropping them leaves the agent with a bare word.
    const details = resultDetails(r);
    const text = actionText(r);
    return { status: r.status, code: statusOf(r), text: text.trim(), data: { status: r.status, ...details } };
  }
}
