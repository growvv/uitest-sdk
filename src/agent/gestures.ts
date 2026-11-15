import { UitestError } from "../errors.js";

export interface Point {
  x: number;
  y: number;
}

/** The low-level transport gestures, plus the hypium calls multi-touch needs. */
export interface GestureDevice {
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
}

export interface GestureOptions {
  /** Wall-clock duration of the movement, in ms. */
  durationMs?: number;
  /** Number of interpolated moves; overrides the duration-derived count. */
  steps?: number;
  /** Pause before the first move, so the device registers a long press. */
  holdMs?: number;
  /** Pause after arriving, before releasing. */
  pauseMs?: number;
  /** Per-step sleep override, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface GestureResult {
  elapsedMs: number;
  points: number;
}

export interface PinchOptions extends GestureOptions {
  center: Point;
  /** Half-distance between the fingers at the start. */
  from: number;
  /** Half-distance between the fingers at the end. */
  to: number;
}

export interface FingerPath {
  from: Point;
  to: Point;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stepCount(opts: GestureOptions, fallback: number): number {
  const explicit = opts.steps;
  if (explicit !== undefined) {
    const n = Math.round(explicit);
    if (!Number.isFinite(n) || n < 1) {
      throw new UitestError(`steps must be at least 1, got ${explicit}`, "EINVALIDGESTURE");
    }
    return Math.min(120, n);
  }
  const duration = opts.durationMs ?? fallback;
  return Math.max(2, Math.min(120, Math.round(duration / 16)));
}

function assertDuration(opts: GestureOptions, fallback: number): number {
  const duration = opts.durationMs ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new UitestError(`durationMs must be > 0, got ${duration}`, "EINVALIDGESTURE");
  }
  return duration;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
}

/**
 * Pointer-level gestures over the `Gestures` channel.
 *
 * Every path is built from `touchDown`/`touchMove`/`touchUp` rather than
 * `Driver.swipe`: the hypium call is measured 3–5x slower on a real device and
 * 19–38x slower on the emulator, and it gives no control over the path. The
 * one thing this must never do is leave a finger down — every failure path
 * releases the pointer before rethrowing.
 */
export class Gestures {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly device: GestureDevice, opts: GestureOptions = {}) {
    this.sleep = opts.sleep ?? realSleep;
  }

  async tap(p: Point): Promise<GestureResult> {
    const started = Date.now();
    await this.device.click(Math.round(p.x), Math.round(p.y));
    return { elapsedMs: Date.now() - started, points: 1 };
  }

  async longPress(p: Point, opts: GestureOptions = {}): Promise<GestureResult> {
    const started = Date.now();
    const holdMs = Math.max(0, opts.holdMs ?? 700);
    await this.device.touchDown(Math.round(p.x), Math.round(p.y));
    try {
      if (holdMs) await this.sleep(holdMs);
    } finally {
      await this.device.touchUp(Math.round(p.x), Math.round(p.y)).catch(() => undefined);
    }
    return { elapsedMs: Date.now() - started, points: 1 };
  }

  /** Two taps at one point. The device itself decides whether that is a double click. */
  async doubleClick(p: Point, opts: GestureOptions = {}): Promise<GestureResult> {
    const started = Date.now();
    const gap = Math.max(0, opts.pauseMs ?? 80);
    await this.device.click(Math.round(p.x), Math.round(p.y));
    if (gap) await this.sleep(gap);
    await this.device.click(Math.round(p.x), Math.round(p.y));
    return { elapsedMs: Date.now() - started, points: 2 };
  }

  async swipe(from: Point, to: Point, opts: GestureOptions = {}): Promise<GestureResult> {
    const duration = assertDuration(opts, 300);
    const steps = stepCount(opts, 300);
    const started = Date.now();
    await this.pressAndRelease(from, to, { ...opts, durationMs: duration }, steps);
    return { elapsedMs: Date.now() - started, points: steps };
  }

  /**
   * A swipe that first holds, so the device treats it as dragging a held item
   * rather than scrolling. Slower by design; `holdMs` is what makes a reorder
   * gesture work.
   */
  async drag(from: Point, to: Point, opts: GestureOptions = {}): Promise<GestureResult> {
    const duration = assertDuration(opts, 500);
    const steps = stepCount(opts, 500);
    const started = Date.now();
    await this.pressAndRelease(from, to, { ...opts, durationMs: duration, holdMs: opts.holdMs ?? 300 }, steps);
    return { elapsedMs: Date.now() - started, points: steps };
  }

  /** A fast, short path: the release velocity is what makes the list keep moving. */
  async fling(from: Point, to: Point, opts: GestureOptions = {}): Promise<GestureResult> {
    const duration = assertDuration(opts, 120);
    const steps = stepCount(opts, 120);
    const started = Date.now();
    await this.pressAndRelease(from, to, { ...opts, durationMs: duration }, steps);
    return { elapsedMs: Date.now() - started, points: steps };
  }

  /**
   * Two fingers moving apart or together around a center. Uses
   * `PointerMatrix` + `injectMultiPointerAction`: the single-pointer channel
   * cannot express two simultaneous paths.
   */
  async pinch(opts: PinchOptions): Promise<GestureResult> {
    const { center, from, to } = opts;
    const duration = assertDuration(opts, 400);
    const steps = stepCount(opts, 400);
    return this.multiTouch(
      [
        { from: { x: center.x - from, y: center.y }, to: { x: center.x - to, y: center.y } },
        { from: { x: center.x + from, y: center.y }, to: { x: center.x + to, y: center.y } },
      ],
      { ...opts, durationMs: duration, steps },
    );
  }

  /**
   * Several fingers, each with one straight path, injected together. The
   * matrix holds every finger at every sampled position; the device replays it
   * as one gesture, so all fingers move at once.
   */
  async multiTouch(paths: FingerPath[], opts: GestureOptions = {}): Promise<GestureResult> {
    if (paths.length === 0) {
      throw new UitestError("multiTouch needs at least one finger path", "EINVALIDGESTURE");
    }
    const duration = assertDuration(opts, 400);
    const steps = stepCount(opts, 400);
    const started = Date.now();
    const matrix = await this.device.hypium("PointerMatrix.create", "PointerMatrix#seed", [
      paths.length,
      steps,
    ]);
    if (typeof matrix !== "string" || matrix === "") {
      throw new UitestError("the device did not return a PointerMatrix reference", "EGESTURE");
    }
    for (let finger = 0; finger < paths.length; finger++) {
      const path = paths[finger]!;
      for (let step = 0; step < steps; step++) {
        const point = lerp(path.from, path.to, steps === 1 ? 1 : step / (steps - 1));
        await this.device.hypium("PointerMatrix.setPoint", matrix, [finger, step, point]);
      }
    }
    await this.device.hypium("Driver.injectMultiPointerAction", "Driver#0", [
      matrix,
      Math.round(duration),
    ]);
    return { elapsedMs: Date.now() - started, points: steps };
  }

  private async pressAndRelease(
    from: Point,
    to: Point,
    opts: GestureOptions,
    steps: number,
  ): Promise<void> {
    const duration = assertDuration(opts, 300);
    const holdMs = Math.max(0, opts.holdMs ?? 0);
    const pauseMs = Math.max(0, opts.pauseMs ?? 0);
    const start = { x: Math.round(from.x), y: Math.round(from.y) };
    const end = { x: Math.round(to.x), y: Math.round(to.y) };
    await this.device.touchDown(start.x, start.y);
    try {
      if (holdMs) await this.sleep(holdMs);
      const perStep = steps > 0 ? duration / steps : 0;
      for (let i = 1; i <= steps; i++) {
        const point = lerp(start, end, i / steps);
        await this.device.touchMove(point.x, point.y);
        if (perStep > 0) await this.sleep(perStep);
      }
      if (pauseMs) await this.sleep(pauseMs);
    } finally {
      // A finger left down blocks the whole device for every later test.
      await this.device.touchUp(end.x, end.y).catch(() => undefined);
    }
  }
}
