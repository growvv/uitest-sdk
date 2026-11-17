/** A frame-rate reading over the meter's window. */
export interface FpsStats {
  /** Frames per second between the oldest and newest frame in the window. */
  fps: number;
  /** Frames currently inside the window. */
  frames: number;
  /** Milliseconds between the oldest and newest frame in the window. */
  spanMs: number;
  /** Timestamp of the newest frame, or null when none was added. */
  lastAt: number | null;
  /** Time since the newest frame; 0 when it is the one just added. */
  stalledMs: number;
}

export interface FpsMeterOptions {
  /** How much history the reading covers. Default 2000 ms. */
  windowMs?: number;
}

/**
 * Client-side frame-rate statistics for any frame stream.
 *
 * The meter knows nothing about casting: call `add()` with a timestamp each
 * time a frame arrives (or let it use `Date.now()`), and read `stats()`. FPS is
 * computed from intervals, not from frames divided by the window, so a stream
 * that just started does not report a fake low rate; two frames are needed
 * before a rate exists at all.
 */
export class FpsMeter {
  private readonly windowMs: number;
  private readonly times: number[] = [];

  constructor(opts: FpsMeterOptions = {}) {
    const windowMs = opts.windowMs ?? 2000;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive number, got ${windowMs}`);
    }
    this.windowMs = windowMs;
  }

  add(at: number = Date.now()): void {
    this.times.push(at);
    this.prune(at);
  }

  reset(): void {
    this.times.length = 0;
  }

  stats(now: number = Date.now()): FpsStats {
    this.prune(now);
    const first = this.times[0];
    const last = this.times[this.times.length - 1];
    if (first === undefined || last === undefined) {
      return { fps: 0, frames: 0, spanMs: 0, lastAt: null, stalledMs: 0 };
    }
    const spanMs = last - first;
    const fps = this.times.length >= 2 && spanMs > 0 ? ((this.times.length - 1) * 1000) / spanMs : 0;
    return {
      fps,
      frames: this.times.length,
      spanMs,
      lastAt: last,
      stalledMs: Math.max(0, now - last),
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.times.length && this.times[drop]! < cutoff) drop++;
    if (drop > 0) this.times.splice(0, drop);
  }
}
