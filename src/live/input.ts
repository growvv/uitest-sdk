import type { InputLane } from "./input-lane.js";

export type InputState = "idle" | "down";

export interface LiveStats {
  p50: number;
  p95: number;
  /**
   * Timed operations still in the percentile buffer.
   *
   * This is a buffer size, not a count: it stops at `MAX_TIMINGS` (200). Use
   * `total` to ask "has another op happened since I last looked".
   */
  n: number;
  /**
   * Timed operations since the lane opened, never capped.
   *
   * `n` saturates, so a waiter that compares it against a target derived from
   * the gestures it just made stops being satisfiable after 200 injections —
   * a passing run then times out instead. Slow operations are counted here
   * too, because they are injections the device saw.
   */
  total: number;
  /**
   * Slow operations (scroll, paste) that were measured but kept out of p50/p95.
   *
   * A scroll is ~456 ms of device-side work and a paste 1.3-1.9 s, while a tap
   * is 3-4 ms. Averaging them into one percentile reports a latency that
   * describes no gesture: the page then says "输入 275 ms" after a tap that
   * took 4 ms. Slow ops are counted here so the number is not silently
   * dropped, and the page can say what it measured.
   */
  slow: number;
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
 * Upper bound for a pinch half when no display size is known (`--no-layout`).
 *
 * The real bound is half the short edge of the display; without one, a client
 * could send any number and the device would reject the touch point, dropping
 * the lane. 1080 covers the short edge of every phone this targets, so the cap
 * only ever rejects values no device could accept.
 */
const MAX_UNBOUNDED_HALF = 1080;

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
  /** Slow ops measured but kept out of the percentiles; see `LiveStats.slow`. */
  private slowOps = 0;
  /** Timed ops since the lane opened; never capped, unlike `timings`. */
  private timedOps = 0;

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
    // The two fingers sit at `cx ± half`. Clamping the centre alone is not
    // enough: the page's Ctrl+wheel path zooms around the pointer and lets it
    // be anywhere, so a pointer near an edge put a finger off the display.
    // The device rejects an out-of-screen touch point and drops the lane, so
    // the clamp has to keep both endpoints inside.
    const b = this.bounds?.() ?? null;
    const h = this.clampHalf(half);
    const c = this.clampCentreForHalf(cx, cy, h, b);
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
    // No point, no focus, no earlier press and no display size: there is
    // nowhere to put the text. Sending it to (0,0) types into the top-left
    // corner — the status bar — which is worse than dropping it, because the
    // person sees nothing happen and cannot tell why.
    const p = this.textPoint(point);
    if (!p) return;
    const mode: TextMode =
      /^[\x00-\x7F]*$/.test(normalized) && normalized.length <= 12 ? "typing" : "paste";
    this.push({ kind: "text", x: p.x, y: p.y, text: normalized, mode });
  }

  /**
   * Called when the controlling client leaves, disconnects or is replaced.
   *
   * Pointer and wheel operations belong to the takeover that just ended and
   * are dropped. Text does not: the page flushes its buffer before releasing
   * (spec §6.4) and clears the input box as it does, so a text op that is
   * still queued here is the person's characters with no other copy. Dropping
   * it types nothing and leaves them unable to retype what they already
   * watched disappear. Keys are dropped with the gesture — pressing Back
   * again is one click, and a stale key must not act on the next takeover.
   */
  async cancel(): Promise<void> {
    const keepText = this.queue.filter((op) => op.kind === "text");
    this.queue = [];
    this.current = "idle";
    this.pinchBase = null;
    this.wheelBusy = false;
    this.pendingWheel = 0;
    if (this.downSent) {
      this.downSent = false;
      await this.lift(this.sentPoint);
    }
    // After the lift, so the text does not land under a finger still down.
    if (keepText.length > 0 && !this.dead) {
      this.queue.push(...keepText);
      void this.pump();
    }
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
    if (n === 0 && this.slowOps === 0) return null;
    if (n === 0) return { p50: 0, p95: 0, n: 0, total: this.timedOps + this.slowOps, slow: this.slowOps };
    const sorted = [...this.timings].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      n,
      total: this.timedOps + this.slowOps,
      slow: this.slowOps,
    };
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
        const elapsed = performance.now() - started;
        // Scroll and paste are device-side work an order of magnitude slower
        // than a touch op; counting them here is what made the readout
        // describe no gesture at all.
        if (op.kind === "scroll" || (op.kind === "text" && op.mode === "paste")) {
          this.slowOps++;
        } else {
          this.timedOps++;
          this.timings.push(elapsed);
          if (this.timings.length > MAX_TIMINGS) this.timings.shift();
        }
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

  /** Where text should go, or null when no point is known. */
  private textPoint(point?: { x: number; y: number }): Point | null {
    if (point) return this.clampPoint(point.x, point.y);
    const focus = this.focusPoint?.() ?? null;
    if (focus) return this.clampPoint(focus.x, focus.y);
    if (this.lastPoint) return this.clampPoint(this.lastPoint.x, this.lastPoint.y);
    const b = this.bounds?.() ?? null;
    if (b) return this.clampPoint(Math.floor(b.width / 2), Math.floor(b.height / 2));
    return null;
  }

  private clampHalf(half: number): number {
    const b = this.bounds?.() ?? null;
    // Without a display size there is nothing to bound the half against, but a
    // value the device cannot represent must still be refused rather than
    // forwarded: the lane would drop the connection, not report a bad point.
    if (!Number.isFinite(half) || half <= 0) return 20;
    const max = b ? Math.min(b.width, b.height) / 2 : MAX_UNBOUNDED_HALF;
    return Math.round(Math.min(Math.max(half, 20), max));
  }

  /**
   * The centre for a two-finger gesture whose fingers sit at `cx ± half`.
   *
   * Moves the centre inwards rather than shrinking the half: the page is
   * asking for a scale, and a zoom that silently shrinks is the "did what it
   * felt like" behaviour this design avoids. Without a display size there is
   * nothing to clamp against, and the client is trusted as before.
   */
  private clampCentreForHalf(cx: number, cy: number, half: number, b: { width: number; height: number } | null): Point {
    if (!b) return { x: Math.round(cx), y: Math.round(cy) };
    const x = Math.max(half, Math.min(b.width - 1 - half, cx));
    const y = Math.max(half, Math.min(b.height - 1 - half, cy));
    return { x: Math.round(x), y: Math.round(y) };
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
