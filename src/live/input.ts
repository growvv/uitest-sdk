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

type Op =
  | { kind: "down"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "up"; x: number; y: number };

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
  private readonly timings: number[] = [];

  constructor(opts: LiveInputOptions) {
    this.lane = opts.lane;
    this.bounds = opts.bounds;
    this.onError = opts.onError;
    this.now = opts.now ?? (() => Date.now());
    this.holdMs = opts.holdMs ?? 10_000;
  }

  down(x: number, y: number): void {
    const p = this.clampPoint(x, y);
    if (this.current === "down") {
      // A second down without an up would be reinterpreted by the device as a
      // move. Close the previous gesture first, in order, before starting one.
      this.push({ kind: "up", x: this.sentPoint.x, y: this.sentPoint.y });
    }
    this.current = "down";
    this.lastPoint = p;
    this.lastPointerAt = this.now();
    // Cancelled while the down is still in flight, this is the only point the
    // device may be holding — the lift must use it.
    this.sentPoint = p;
    this.push({ kind: "down", x: p.x, y: p.y });
  }

  move(x: number, y: number): void {
    if (this.current !== "down") return;
    const p = this.clampPoint(x, y);
    this.lastPoint = p;
    this.lastPointerAt = this.now();
    this.push({ kind: "move", x: p.x, y: p.y });
  }

  up(x: number, y: number): void {
    if (this.current !== "down") return;
    const p = this.clampPoint(x, y);
    this.current = "idle";
    this.push({ kind: "up", x: p.x, y: p.y });
  }

  /** Called when the controlling client leaves, disconnects or is replaced. */
  async cancel(): Promise<void> {
    this.queue = [];
    this.current = "idle";
    if (!this.downSent) return;
    this.downSent = false;
    const at = this.sentPoint;
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
          this.fail(e instanceof Error ? e : new Error(String(e)));
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
    }
  }

  private fail(error: Error): void {
    const wasHolding = this.downSent;
    const at = this.sentPoint;
    this.downSent = false;
    this.current = "idle";
    this.queue = [];
    this.onError?.(error);
    // The lane rejected an op, so the gesture is over; release the pointer
    // without waiting. A dead lane makes the lift fail too, which is fine —
    // the caller's page is already being told to go read-only.
    if (wasHolding) void this.lane.touchUp(at.x, at.y).catch(() => undefined);
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
