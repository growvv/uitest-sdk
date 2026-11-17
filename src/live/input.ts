import type { InputLane } from "./input-lane.js";

export type InputState = "idle" | "down";

export interface LiveStats {
  p50: number;
  p95: number;
  n: number;
}

export interface LiveInputOptions {
  lane: InputLane;
  /** Current display size, or null when layout is off (`--no-layout`). */
  bounds?: () => { width: number; height: number } | null;
  /** Where text should go when the client sends none. */
  focusPoint?: () => { x: number; y: number } | null;
  onError?: (error: Error) => void;
  now?: () => number;
  /** How long a held pointer may go without movement before it is lifted. Default 10_000. */
  holdMs?: number;
}

interface Point {
  x: number;
  y: number;
}

/** HarmonyOS key codes for the system keys the page exposes. */
const KEY_CODES = { back: 2, home: 1, enter: 2054, delete: 2055 } as const;
export type LiveKey = keyof typeof KEY_CODES;

type TextMode = "typing" | "paste";

type Op =
  | { kind: "down"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "up"; x: number; y: number }
  | { kind: "key"; code: number }
  | { kind: "text"; x: number; y: number; text: string; mode: TextMode }
  | { kind: "pinch"; cx: number; cy: number; from: number; to: number; ms: number }
  | { kind: "scroll"; x: number; y: number; down: boolean; steps: number };

const MAX_TIMINGS = 200;
const CANCEL_LIFT_MS = 500;

/**
 * Serialises everything that touches the device into one ordered stream.
 *
 * The agent answers one request per connection at a time, and a gesture is
 * stateful: a move that overtakes its down, or reaches the device after the
 * up, is a different gesture. So down/up/key/text/pinch/scroll queue strictly,
 * and moves coalesce — while one move is in flight, only the latest pending
 * position matters. That is what makes a 60 Hz pointer stream fit through a
 * ~250 Hz lane without growing a lag backlog.
 *
 * A held pointer with no movement is lifted by the watchdog: a browser tab
 * that goes to sleep mid-drag must not leave the phone stuck in a long-press.
 */
export class LiveInput {
  private readonly lane: InputLane;
  private readonly bounds: (() => { width: number; height: number } | null) | undefined;
  private readonly focusPoint: (() => { x: number; y: number } | null) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly now: () => number;
  private readonly holdMs: number;

  private current: InputState = "idle";
  private queue: Op[] = [];
  private running = false;
  /** A touchDown reached the lane and has not been followed by a touchUp. */
  private downSent = false;
  /** Last point known to be on the device, used to lift best-effort. */
  private sentPoint: Point = { x: 0, y: 0 };
  /** Last point the user aimed at; text falls back to it when unfocused. */
  private lastPoint: Point | null = null;
  private lastPointerAt = 0;
  /** Half-distance of the previous pinch, the "from" of the next segment. */
  private pinchBase: number | null = null;
  /** Wheel deltas accumulate while a scroll is in flight and merge on release. */
  private pendingWheel = 0;
  private wheelBusy = false;
  private wheelPoint: Point | null = null;
  /** Set when a lane op failed; nothing more is sent on this lane. */
  private dead = false;
  private readonly timings: number[] = [];

  constructor(opts: LiveInputOptions) {
    this.lane = opts.lane;
    this.bounds = opts.bounds;
    this.focusPoint = opts.focusPoint;
    this.onError = opts.onError;
    this.now = opts.now ?? (() => Date.now());
    this.holdMs = opts.holdMs ?? 10_000;
  }

  down(x: number, y: number): void {
    if (this.dead) return;
    const p = this.clampPoint(x, y);
    if (this.current === "down") {
      // A second down without an up would be reinterpreted by the device as a
      // move. Close the previous gesture first, in order, before starting one.
      this.push({ kind: "up", x: this.sentPoint.x, y: this.sentPoint.y });
    }
    this.current = "down";
    this.pinchBase = null;
    this.lastPoint = p;
    this.lastPointerAt = this.now();
    // Cancelled while the down is still in flight, this is the only point the
    // device may be holding — the lift must use it.
    this.sentPoint = p;
    this.push({ kind: "down", x: p.x, y: p.y });
  }

  move(x: number, y: number): void {
    if (this.dead || this.current !== "down") return;
    const p = this.clampPoint(x, y);
    this.lastPoint = p;
    this.lastPointerAt = this.now();
    this.push({ kind: "move", x: p.x, y: p.y });
  }

  up(x: number, y: number): void {
    if (this.dead || this.current !== "down") return;
    const p = this.clampPoint(x, y);
    this.current = "idle";
    this.push({ kind: "up", x: p.x, y: p.y });
  }

  /**
   * Two fingers move symmetrically around (cx, cy). A pinch is not a
   * continuous gesture the way a drag is: the device executes one discrete
   * two-pointer action per call. The first call only records the starting
   * distance; each later call sends one segment from the previous distance so
   * the scale follows the fingers instead of jumping.
   */
  pinch(cx: number, cy: number, half: number): void {
    if (this.dead) return;
    const c = this.clampPoint(cx, cy);
    const h = this.clampHalf(half);
    if (this.current === "down") {
      this.current = "idle";
      this.push({ kind: "up", x: this.sentPoint.x, y: this.sentPoint.y });
    }
    this.lastPoint = c;
    if (this.pinchBase === null) {
      this.pinchBase = h;
      return;
    }
    const from = this.pinchBase;
    if (Math.abs(h - from) < 2) return;
    this.pinchBase = h;
    this.push({ kind: "pinch", cx: c.x, cy: c.y, from, to: h, ms: 140 });
  }

  /**
   * Wheel input becomes `Driver.mouseScroll` calls. One scroll takes ~200 ms,
   * so deltas that arrive while it runs are summed and sent as one follow-up
   * instead of queueing per event.
   */
  wheel(x: number, y: number, dy: number): void {
    if (this.dead) return;
    this.wheelPoint = this.clampPoint(x, y);
    this.pendingWheel += dy;
    if (!this.wheelBusy) this.flushWheel();
  }

  key(name: LiveKey): void {
    if (this.dead) return;
    this.push({ kind: "key", code: KEY_CODES[name] });
  }

  /**
   * Text entry: short ASCII types through the IME, everything else pastes.
   * Typing costs ~179 ms/char and paste 1.3-1.9 s, but paste also clobbers the
   * device clipboard; 12 keeps ordinary short input typed while long or
   * non-ASCII text takes the faster paste path.
   */
  type(text: string, point?: { x: number; y: number }): void {
    if (this.dead) return;
    const normalized = text.replace(/\r\n?|\n/g, " ").trim();
    if (normalized === "") return;
    const mode: TextMode =
      /^[\x00-\x7F]*$/.test(normalized) && normalized.length <= 12 ? "typing" : "paste";
    const p = this.textPoint(point);
    this.push({ kind: "text", x: p.x, y: p.y, text: normalized, mode });
  }

  /** Called when the controlling client leaves, disconnects or is replaced. */
  async cancel(): Promise<void> {
    this.queue = [];
    this.current = "idle";
    this.pinchBase = null;
    this.wheelBusy = false;
    this.pendingWheel = 0;
    if (!this.downSent) return;
    this.downSent = false;
    await this.lift(this.sentPoint);
  }

  tick(now: number = this.now()): void {
    if (this.current !== "down") return;
    if (now - this.lastPointerAt <= this.holdMs) return;
    this.up(this.sentPoint.x, this.sentPoint.y);
  }

  state(): InputState {
    return this.current;
  }

  /** p50/p95 of the last successful lane calls, or null before the first. */
  stats(): LiveStats | null {
    const n = this.timings.length;
    if (n === 0) return null;
    const sorted = [...this.timings].sort((a, b) => a - b);
    return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), n };
  }

  private push(op: Op): void {
    // The lane is gone: the server has been told, and anything the page sends
    // before it hears back belongs to the next takeover, not this one.
    if (this.dead) return;
    if (op.kind === "move" && this.queue.length > 0) {
      const tail = this.queue[this.queue.length - 1]!;
      if (tail.kind === "move") {
        this.queue[this.queue.length - 1] = op;
        void this.pump();
        return;
      }
    }
    this.queue.push(op);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const op = this.queue.shift()!;
        const started = performance.now();
        try {
          await this.runOp(op);
        } catch (e) {
          await this.fail(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        this.timings.push(performance.now() - started);
        if (this.timings.length > MAX_TIMINGS) this.timings.shift();
      }
    } finally {
      this.running = false;
      // Pushes only happen between awaits, so this is a guard for a future
      // change in ordering, not the normal path.
      if (this.queue.length > 0) void this.pump();
    }
  }

  private async runOp(op: Op): Promise<void> {
    switch (op.kind) {
      case "down":
        this.downSent = true;
        await this.lane.touchDown(op.x, op.y);
        this.sentPoint = { x: op.x, y: op.y };
        return;
      case "move":
        await this.lane.touchMove(op.x, op.y);
        this.sentPoint = { x: op.x, y: op.y };
        return;
      case "up":
        await this.lane.touchUp(op.x, op.y);
        this.downSent = false;
        this.sentPoint = { x: op.x, y: op.y };
        return;
      case "key":
        await this.lane.key(op.code);
        return;
      case "text":
        await this.lane.text(op.x, op.y, op.text, op.mode);
        return;
      case "pinch":
        await this.lane.pinch(op.cx, op.cy, op.from, op.to, op.ms);
        return;
      case "scroll":
        await this.lane.scroll(op.x, op.y, op.down, op.steps);
        this.wheelBusy = false;
        if (this.pendingWheel !== 0) this.flushWheel();
        return;
    }
  }

  private flushWheel(): void {
    if (this.wheelBusy || this.pendingWheel === 0) return;
    const dy = this.pendingWheel;
    this.pendingWheel = 0;
    const point = this.wheelPoint ?? { x: 0, y: 0 };
    const steps = Math.min(Math.max(Math.round(Math.abs(dy) / 100), 1), 5);
    this.wheelBusy = true;
    this.push({ kind: "scroll", x: point.x, y: point.y, down: dy > 0, steps });
  }

  private textPoint(point?: { x: number; y: number }): Point {
    if (point) return this.clampPoint(point.x, point.y);
    const focus = this.focusPoint?.() ?? null;
    if (focus) return this.clampPoint(focus.x, focus.y);
    if (this.lastPoint) return this.clampPoint(this.lastPoint.x, this.lastPoint.y);
    const b = this.bounds?.() ?? null;
    if (b) return this.clampPoint(Math.floor(b.width / 2), Math.floor(b.height / 2));
    return { x: 0, y: 0 };
  }

  private clampHalf(half: number): number {
    const b = this.bounds?.() ?? null;
    const max = b ? Math.min(b.width, b.height) / 2 : Number.POSITIVE_INFINITY;
    return Math.round(Math.min(Math.max(half, 20), max));
  }

  private async fail(error: Error): Promise<void> {
    const wasHolding = this.downSent;
    const at = this.sentPoint;
    this.dead = true;
    this.downSent = false;
    this.current = "idle";
    this.queue = [];
    this.pinchBase = null;
    this.wheelBusy = false;
    this.pendingWheel = 0;
    // The lane rejected an op, so the gesture is over; release the pointer
    // first. The caller's onError releases control and closes the lane, so a
    // lift issued after it would reach a dead socket and leave the phone
    // pressed. A lane that cannot even lift is fine — there is nothing left to
    // do — but it must not delay the report past cancel()'s cap.
    if (wasHolding) await this.lift(at);
    this.onError?.(error);
  }

  /** Best-effort lift, capped so a silent lane cannot stall the caller. */
  private async lift(at: Point): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.lane.touchUp(at.x, at.y).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CANCEL_LIFT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private clampPoint(x: number, y: number): Point {
    const b = this.bounds?.() ?? null;
    const px = Math.round(x);
    const py = Math.round(y);
    if (!b) return { x: px, y: py };
    return {
      x: Math.min(Math.max(px, 0), Math.max(0, b.width - 1)),
      y: Math.min(Math.max(py, 0), Math.max(0, b.height - 1)),
    };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}
