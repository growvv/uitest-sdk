import { ScreenBuilder } from "./screen.js";
import type { Screen, ScreenContext } from "./screen.js";
import type { UiNode } from "../../transport/model.js";

/** The device-side calls the reader needs; a real AgentClient satisfies this. */
export interface ScreenSource {
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
  captureLayout(): Promise<UiNode>;
  getDisplaySize(): Promise<{ width: number; height: number }>;
  getDisplayRotation(): Promise<number>;
}

export interface SettleOptions {
  /** Previous screen hash, so an unchanged screen is reported honestly. */
  previousHash?: string;
  /** Minimum quiet period the device itself waits for, in ms. */
  idleWaitMs?: number;
  /** Upper bound for the device-side wait, in ms. */
  idleTimeoutMs?: number;
  /** Total host-side budget for the UI to become quiet. */
  maxSettleMs?: number;
  /** Delay before the first observation. */
  startDelayMs?: number;
  /** Interval between host-side observations. */
  pollMs?: number;
  /**
   * How long an unchanged screen is disbelieved after an action. A repaint
   * takes a frame or two; without this, the old screen is read twice and
   * reported as "nothing changed" before the app has even started animating.
   */
  graceMs?: number;
}

export interface SettleResult {
  screen: Screen;
  /** True when `Driver.waitForIdle` itself reported the UI quiet. */
  deviceIdle: boolean;
  /** True when the UI never stopped changing within the budget. */
  timedOut: boolean;
  elapsedMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads screens and tracks display metadata.
 *
 * Display size and rotation are cached: they change only on fold or rotation,
 * and re-reading them on every observation costs a round trip for nothing.
 * The builder is shared across reads so refs stay stable within a session.
 */
export class ScreenReader {
  private meta: ScreenContext | null = null;
  private metaAt = 0;

  constructor(
    readonly source: ScreenSource,
    readonly builder: ScreenBuilder = new ScreenBuilder(),
    private readonly metaTtlMs = 30_000,
  ) {}

  async context(): Promise<ScreenContext> {
    if (this.meta && Date.now() - this.metaAt < this.metaTtlMs) return this.meta;
    const [size, rotation] = await Promise.all([
      this.source.getDisplaySize(),
      this.source.getDisplayRotation(),
    ]);
    this.meta = { display: size, rotation };
    this.metaAt = Date.now();
    return this.meta;
  }

  /** Forces the next `read` to ask the device for display metadata again. */
  invalidateMeta(): void {
    this.meta = null;
  }

  async read(): Promise<Screen> {
    const ctx = await this.context();
    const screen = this.builder.build(await this.source.captureLayout(), ctx);
    // Refs are handed to another process on the next command, so the table is
    // written as soon as it changes, not at release time — a crashed command
    // must not leave the next one numbering elements from scratch.
    await this.builder.persist();
    return screen;
  }
}

/**
 * Waits for the UI to stop changing, then returns the screen.
 *
 * The device-side `Driver.waitForIdle` runs first: it is one call and the
 * device knows about animations the host cannot see. Host polling — two
 * consecutive identical screen hashes — follows as confirmation, and is the
 * only path when the extension does not expose `waitForIdle`.
 *
 * An unchanged screen is not proof of a settled one: right after an action the
 * old page is still on screen for a frame or two. `graceMs` is how long that
 * reading is disbelieved. A screen that never stops changing within the budget
 * is reported as `timedOut` rather than thrown — an unsettled screen is a task
 * outcome, not a programming error.
 */
export async function settle(
  reader: ScreenReader,
  opts: SettleOptions = {},
): Promise<SettleResult> {
  const started = Date.now();
  const pollMs = Math.max(20, opts.pollMs ?? 200);
  const graceMs = Math.max(0, opts.graceMs ?? 400);
  const maxSettleMs = Math.max(0, opts.maxSettleMs ?? 3000);
  if (opts.startDelayMs) await sleep(opts.startDelayMs);

  const deviceIdle = await waitDeviceIdle(reader.source, opts);

  // Nothing was acted on and the device says the UI is quiet: one read is the
  // whole answer. With a previous hash there is something to compare against,
  // so the loop below still runs — the device can report idle while the old
  // page is still painted.
  if (deviceIdle === true && opts.previousHash === undefined) {
    const screen = await reader.read();
    return { screen, deviceIdle: true, timedOut: false, elapsedMs: Date.now() - started };
  }

  let previous: string | undefined = opts.previousHash;
  let last: Screen | null = null;
  for (;;) {
    const next = await reader.read();
    const quiet = last !== null && next.hash === last.hash;
    const changed = previous === undefined || next.hash !== previous;
    if (quiet && (changed || Date.now() - started >= graceMs)) {
      return { screen: next, deviceIdle: deviceIdle === true, timedOut: false, elapsedMs: Date.now() - started };
    }
    last = next;
    previous ??= next.hash;
    if (Date.now() - started >= maxSettleMs) {
      return {
        screen: next,
        deviceIdle: deviceIdle === true,
        timedOut: !quiet,
        elapsedMs: Date.now() - started,
      };
    }
    await sleep(pollMs);
  }
}

/**
 * `null` means the API is not available, so the caller should poll instead.
 * `false` means it is available and reported "not idle before the timeout".
 */
async function waitDeviceIdle(
  source: ScreenSource,
  opts: SettleOptions,
): Promise<boolean | null> {
  const quiet = opts.idleWaitMs ?? 200;
  const timeout = opts.idleTimeoutMs ?? 3000;
  try {
    const result = await source.hypium("Driver.waitForIdle", "Driver#0", [quiet, timeout]);
    return result === true;
  } catch {
    return null;
  }
}
