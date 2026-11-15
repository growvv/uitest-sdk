import type net from "node:net";
import jpeg from "jpeg-js";
import { FrameDemux } from "./demux.js";
import { SerialQueue } from "./queue.js";
import {
  AgentBusyError,
  AgentConnectionError,
  AgentProtocolError,
  UitestError,
} from "../errors.js";
import type { Rect, UiEvent, UiNode } from "../model.js";
import { cropRect, parseBounds } from "../util/bounds.js";

export type AgentMethod = "Captures" | "CtrlCmd" | "Gestures" | "callHypiumApi";

export interface AgentClientOptions {
  requestTimeoutMs?: number;
  retryOnBusy?: boolean;
  maxBusyRetries?: number;
  /**
   * Called once when the connection drops, to rebuild the transport. The failed
   * request still rejects — replaying a write is unsafe — but later calls use
   * the replacement socket.
   */
  reconnect?: () => Promise<net.Socket>;
}

export const MODULE_ID = "com.ohos.devicetest.hypiumApiHelper";

/** The device-side global lock. This is the only condition worth retrying. */
const BUSY_PATTERN = "Disallow concurrent use";
/** One capture channel per device: waiting on it would steal another's stream. */
const CAPTURE_CONFLICT_PATTERN = "Capture already running";

/**
 * The device sends `exception` either as a string (1.1.x) or as an object with
 * `code`/`message` (some APIs, and 1.2.x). Normalise before matching, or the
 * first `.includes` on an object takes the whole client down.
 */
export function exceptionText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["message", "msg", "error", "reason", "code"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? "unknown exception");
}

export function isBusyException(msg: unknown): boolean {
  return exceptionText(msg).includes(BUSY_PATTERN);
}

function isCaptureConflict(msg: unknown): boolean {
  return exceptionText(msg).includes(CAPTURE_CONFLICT_PATTERN);
}

const NOT_RUNNING_PATTERNS = [
  "Capture is not running",
  "capture is not running",
  "Capture not started",
];

/** True for the "another process already stopped it" failures `stopStream` tolerates. */
function isNotRunning(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : exceptionText(e);
  return NOT_RUNNING_PATTERNS.some((p) => msg.includes(p));
}

interface AgentReply {
  result?: unknown;
  exception?: unknown;
  pts?: number;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Depth-first search for the node matching a window selector. */
function findNode(
  root: UiNode,
  sel: { windowId?: number; bundleName?: string },
): UiNode | null {
  const matches = (n: UiNode): boolean => {
    const a = n.attributes;
    if (sel.bundleName !== undefined && a["bundleName"] !== sel.bundleName) return false;
    if (sel.windowId !== undefined && a["windowId"] !== String(sel.windowId)) return false;
    return true;
  };
  const walk = (n: UiNode): UiNode | null => {
    if (matches(n)) return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/**
 * Client for the device-side agent extension. One TCP connection carries both
 * newline-terminated JSON replies and raw JPEG frames, so all traffic is fed
 * through a FrameDemux. Requests are serialised because the device holds a
 * global lock and rejects concurrency with `Disallow concurrent use`.
 */
export class AgentClient {
  private readonly demux: FrameDemux;
  private readonly queue = new SerialQueue();
  private pending: Pending | null = null;
  private frameHandlers = new Set<(jpeg: Buffer) => void>();
  /** Frames that arrived before a consumer asked for one (bounded, newest wins). */
  private frameQueue: Buffer[] = [];
  /** Consumers blocked in `nextFrame()`; `null` ends the stream. */
  private frameWaiters: Array<(f: Buffer | null) => void> = [];
  /** Consumers blocked in `nextJson()` for unsolicited UI events. */
  private jsonWaiters: Array<(v: unknown) => void> = [];
  /** Callbacks run once when the transport dies, so one-shot waits can abort. */
  private closeHandlers = new Set<(e: unknown) => void>();
  /** The transport is unusable (dropped or closed). */
  private closed = false;
  /** `close()` was called by the owner: no reconnect, ever. */
  private disposed = false;
  private readonly requestTimeoutMs: number;
  private readonly retryOnBusy: boolean;
  private readonly maxBusyRetries: number;
  private readonly reconnect?: () => Promise<net.Socket>;
  private reconnecting: Promise<void> | null = null;

  constructor(
    private sock: net.Socket,
    opts: AgentClientOptions = {},
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.retryOnBusy = opts.retryOnBusy ?? true;
    this.maxBusyRetries = opts.maxBusyRetries ?? 40;
    this.reconnect = opts.reconnect;

    this.demux = new FrameDemux({
      onJson: (line) => this.onJson(line),
      onFrame: (jpeg) => {
        for (const h of this.frameHandlers) h(jpeg);
        const w = this.frameWaiters.shift();
        if (w) {
          w(jpeg);
          return;
        }
        // A frame can land before the consumer's next `next()` call; keep the
        // newest few so a slow consumer drops stale frames instead of growing.
        this.frameQueue.push(jpeg);
        if (this.frameQueue.length > 4) this.frameQueue.shift();
      },
    });

    this.attach(sock);
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    // A superseded socket may still emit `close` after we moved on; ignore it.
    const current = () => this.sock === sock;
    sock.on("data", (chunk: Buffer) => {
      if (this.closed || !current()) return;
      this.demux.push(chunk);
    });
    sock.on("error", (e) => {
      if (!current()) return;
      this.fail(new AgentConnectionError(`agent socket error: ${e.message}`, "ECONN", e));
    });
    sock.on("close", () => {
      if (!current()) return;
      this.fail(new AgentConnectionError("agent connection closed", "ECONN"));
    });
  }

  get connected(): boolean {
    return !this.closed && !this.sock.destroyed;
  }

  onFrame(handler: (jpeg: Buffer) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  /** Registers a one-shot-safe listener for transport loss. */
  onClose(handler: (e: unknown) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  call(method: AgentMethod, params: object): Promise<unknown> {
    if (!this.connected) {
      if (!this.reconnect || this.disposed) {
        return Promise.reject(new AgentConnectionError("agent is not connected", "ECONN"));
      }
      return this.tryReconnect().then(() => this.call(method, params));
    }
    return this.callQueued(method, params).catch((e: unknown) => {
      // A timed-out request is still in flight on the wire, and replies carry no
      // request id: the late one would be paired with whatever request comes
      // next. The connection is unusable after a timeout.
      if (e instanceof UitestError && e.code === "ETIMEDOUT") {
        this.fail(new AgentConnectionError("request timed out; connection discarded", "ECONN", e));
      }
      throw e;
    });
  }

  private callQueued(method: AgentMethod, params: object): Promise<unknown> {
    return this.queue.run(async () => {
      let delay = 0.5;
      for (let attempt = 0; ; attempt++) {
        const raw = await this.sendOnce(method, params);
        if (raw.exception == null) return raw.result;
        const text = exceptionText(raw.exception);

        // spec §4.6: a capture conflict is thrown immediately — no waiting,
        // no takeover. Only the global-lock conflict is retried.
        if (isCaptureConflict(raw.exception)) {
          throw new AgentBusyError(text, "EBUSY");
        }
        const busy = isBusyException(raw.exception);
        if (!this.retryOnBusy || !busy) {
          throw busy
            ? new AgentBusyError(text, "EBUSY")
            : new AgentProtocolError(text, "EPROTO");
        }
        if (attempt >= this.maxBusyRetries) {
          throw new AgentBusyError(
            `device stayed busy after ${attempt + 1} attempts: ${text}`,
            "EBUSY",
          );
        }
        // Jitter is required: two processes backing off in lockstep collide forever.
        await sleep(delay * (0.5 + Math.random()));
        delay = Math.min(delay * 2, 20);
      }
    }, this.requestTimeoutMs);
  }

  // ---------------------------------------------------------------- display

  async getDisplaySize(): Promise<{ width: number; height: number }> {
    const r = (await this.call("CtrlCmd", { api: "getDisplaySize", args: [] })) as {
      width: number;
      height: number;
    };
    return { width: r.width, height: r.height };
  }

  async getDisplayRotation(): Promise<number> {
    const r = (await this.call("CtrlCmd", { api: "getDisplayRotation", args: [] })) as number;
    return r;
  }

  // ------------------------------------------------------------------ touch

  // The device rejects non-integer coordinates with
  // `Illegal touch point coordination`, so every point is rounded at the edge.
  async touchDown(x: number, y: number): Promise<void> {
    await this.call("Gestures", { api: "touchDown", args: { x: Math.round(x), y: Math.round(y) } });
  }

  async touchMove(x: number, y: number): Promise<void> {
    await this.call("Gestures", { api: "touchMove", args: { x: Math.round(x), y: Math.round(y) } });
  }

  async touchUp(x: number, y: number): Promise<void> {
    await this.call("Gestures", { api: "touchUp", args: { x: Math.round(x), y: Math.round(y) } });
  }

  async click(x: number, y: number): Promise<void> {
    await this.touchDown(x, y);
    await this.touchUp(x, y);
  }

  /**
   * Drives a swipe as touchDown + N touchMove + touchUp over the Gestures
   * channel. `Driver.swipe` is deliberately not used: it takes 6.2–12.6 s on
   * the emulator against ~330 ms here, and the move stream is what keeps the
   * dirty-region capture producing frames.
   */
  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts: { steps?: number; durationMs?: number } = {},
  ): Promise<void> {
    const steps = opts.steps ?? 8;
    const durationMs = opts.durationMs ?? 300;
    const stepDelay = Math.max(1, Math.round(durationMs / steps));
    let lastX = x1;
    let lastY = y1;
    await this.touchDown(x1, y1);
    try {
      for (let i = 1; i <= steps; i++) {
        lastX = x1 + ((x2 - x1) * i) / steps;
        lastY = y1 + ((y2 - y1) * i) / steps;
        await this.touchMove(lastX, lastY);
        await sleep(stepDelay);
      }
    } catch (e) {
      // A gesture that dies mid-move would leave a finger held down, turning the
      // caller's next click into a drag. Release it, then surface the failure.
      await this.touchUp(lastX, lastY).catch(() => undefined);
      throw e;
    }
    await this.touchUp(x2, y2);
  }

  // ------------------------------------------------------------- hypium RPC

  async hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown> {
    return this.call("callHypiumApi", { api, this: thisRef, args });
  }

  async inputText(x: number, y: number, text: string): Promise<void> {
    await this.call("callHypiumApi", {
      api: "Driver.inputText",
      this: "Driver#0",
      args: [{ x, y }, text],
    });
  }

  async triggerKey(keyCode: number): Promise<void> {
    await this.call("callHypiumApi", {
      api: "Driver.triggerKey",
      this: "Driver#0",
      args: [keyCode],
    });
  }

  // -------------------------------------------------------------- captures

  async captureLayout(): Promise<UiNode> {
    return (await this.call("Captures", { api: "captureLayout", args: [] })) as UiNode;
  }

  /**
   * Starts the JPEG stream, keeps the first frame, then stops. Start/stop is
   * the fastest whole-screen path available (178 ms measured).
   */
  async captureScreen(opts: { scale?: number } = {}): Promise<Buffer> {
    const scale = opts.scale ?? 0.5;
    let cancel = (): void => undefined;
    const first = new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offFrame();
        offClose();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new AgentProtocolError("no frame received from capture stream", "ETIMEDOUT"))),
        this.requestTimeoutMs,
      );
      const offFrame = this.onFrame((f) => finish(() => resolve(f)));
      const offClose = this.onClose((e) =>
        finish(() =>
          reject(e instanceof Error ? e : new AgentConnectionError("agent connection closed", "ECONN", e)),
        ),
      );
      cancel = () => finish(() => reject(new AgentConnectionError("capture start failed", "ECONN")));
    });
    // The start call can fail before anyone awaits `first`; without this the
    // abandoned promise would surface as an unhandled rejection later.
    first.catch(() => undefined);

    let started = false;
    let failure: unknown;
    try {
      await this.call("Captures", { api: "startCaptureScreen", args: [{ displayId: 0, scale }] });
      started = true;
      return await first;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      cancel();
      if (started) {
        try {
          await this.stopStream();
        } catch (e) {
          if (failure === undefined) throw e; // never mask the primary failure
        }
      }
    }
  }

  /**
   * No capture path on the device can target a single window (spec §10.2), so
   * the whole screen is captured and cropped to the node's bounds.
   */
  async cropToWindow(opts: { windowId?: number; bundleName?: string; scale?: number }): Promise<Buffer> {
    const scale = opts.scale ?? 0.5;
    const tree = await this.captureLayout();
    const node = findNode(tree, opts);
    if (!node) {
      throw new AgentProtocolError(
        `window not found: ${opts.bundleName ?? `windowId ${opts.windowId}`}`,
        "ENOWINDOW",
      );
    }
    const bounds = parseBounds(node.attributes["bounds"] ?? "");
    if (!bounds) {
      throw new AgentProtocolError(`node has no parsable bounds: ${JSON.stringify(node.attributes)}`, "ENOBOUNDS");
    }

    // Bounds are in display coordinates; the frame is not. The device ignores
    // `scale` and returns a fixed-size frame (measured 608x1344 for 1216x2688),
    // so the factor has to come from the frame itself, never from the option.
    const display = await this.getDisplaySize();
    const frame = await this.captureScreen({ scale });
    const img = jpeg.decode(frame);
    const factor = display.width > 0 ? img.width / display.width : 1;
    const scaled: Rect = {
      x: Math.round(bounds.x * factor),
      y: Math.round(bounds.y * factor),
      width: Math.round(bounds.width * factor),
      height: Math.round(bounds.height * factor),
    };
    const rect = cropRect(scaled, { x: 0, y: 0, width: img.width, height: img.height });
    if (rect.width === 0 || rect.height === 0) {
      throw new AgentProtocolError("window bounds fall outside the captured frame", "ENOBOUNDS");
    }

    const out = Buffer.alloc(rect.width * rect.height * 4);
    for (let row = 0; row < rect.height; row++) {
      const srcStart = ((rect.y + row) * img.width + rect.x) * 4;
      img.data.copy(out, row * rect.width * 4, srcStart, srcStart + rect.width * 4);
    }
    return Buffer.from(jpeg.encode({ data: out, width: rect.width, height: rect.height }, 80).data);
  }

  // -------------------------------------------------------------- streaming

  /**
   * Streams whole-screen JPEG frames until the consumer breaks out of the loop.
   * Capture is dirty-region driven: a static screen yields one frame and then
   * nothing, which is expected, not a hang.
   */
  async *streamScreen(opts: { scale?: number } = {}): AsyncIterable<Buffer> {
    const scale = opts.scale ?? 0.5;
    await this.call("Captures", { api: "startCaptureScreen", args: [{ displayId: 0, scale }] });
    try {
      for (;;) {
        const frame = await this.nextFrame();
        if (frame === null) return;
        yield frame;
      }
    } finally {
      await this.stopStream();
    }
  }

  /** Streams device-reported UI actions (touch/key events) as JSON objects. */
  async *streamUiActions(): AsyncIterable<UiEvent> {
    await this.call("Captures", { api: "startCaptureUiAction", args: [] });
    try {
      for (;;) {
        const ev = await this.nextJson();
        if (ev === null) return;
        yield ev as UiEvent;
      }
    } finally {
      try {
        await this.call("Captures", { api: "stopCaptureUiAction", args: [] });
      } catch {
        /* already stopped by another process */
      }
    }
  }

  /**
   * Stops capture. Tolerates "not running" because another process sharing the
   * device may have stopped it first; every other failure still propagates.
   */
  async stopStream(): Promise<void> {
    try {
      // With no live connection there is no device-side session left to stop.
      if (this.connected) {
        await this.call("Captures", { api: "stopCaptureScreen", args: [] });
      }
    } catch (e) {
      if (!isNotRunning(e)) throw e;
    } finally {
      // Stopping ends the capture session: release parked consumers and drop
      // frames buffered from it, or the next stream starts on stale frames.
      this.frameQueue.length = 0;
      for (const w of this.frameWaiters.splice(0)) w(null);
    }
  }

  private nextFrame(): Promise<Buffer | null> {
    const queued = this.frameQueue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.connected) return Promise.resolve(null);
    return new Promise<Buffer | null>((resolve) => {
      this.frameWaiters.push((f) => resolve(f));
    });
  }

  private nextJson(): Promise<unknown | null> {
    if (!this.connected) return Promise.resolve(null);
    return new Promise<unknown | null>((resolve) => {
      this.jsonWaiters.push(resolve);
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    // `fail` marks the transport closed; setting `closed` first would make the
    // guard below skip both the waiter release and the close listeners.
    this.fail(new AgentConnectionError("agent client closed", "ECONN"));
    this.sock.destroy();
  }

  /**
   * Rebuilds the transport once. Concurrent callers share the same attempt;
   * the request that observed the drop still fails, since replaying a write is
   * not safe.
   */
  private tryReconnect(): Promise<void> {
    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        const sock = await this.reconnect!();
        this.pending = null;
        this.demux.reset();
        this.closed = false;
        this.attach(sock);
      })().finally(() => {
        this.reconnecting = null;
      });
    }
    return this.reconnecting;
  }

  private sendOnce(method: AgentMethod, params: object): Promise<AgentReply> {
    return new Promise<AgentReply>((resolve, reject) => {
      if (!this.connected) {
        reject(new AgentConnectionError("agent is not connected", "ECONN"));
        return;
      }
      this.pending = { resolve: resolve as (v: unknown) => void, reject };
      const envelope = JSON.stringify({ module: MODULE_ID, method, params }) + "\n";
      this.sock.write(envelope, "utf8", (err) => {
        if (err) this.fail(new AgentConnectionError(`agent write failed: ${err.message}`, "ECONN", err));
      });
    });
  }

  private onJson(line: string): void {
    let reply: AgentReply;
    try {
      reply = JSON.parse(line) as AgentReply;
    } catch (e) {
      this.fail(new AgentProtocolError(`unparsable agent reply: ${line}`, "EPROTO", e));
      return;
    }
    const p = this.pending;
    if (p) {
      this.pending = null;
      p.resolve(reply);
      return;
    }
    // No request in flight: this is an unsolicited object, i.e. a UI action
    // event from `startCaptureUiAction`. Hand it to the stream consumer.
    const w = this.jsonWaiters.shift();
    if (w) w(reply);
  }

  private fail(err: unknown): void {
    const firstFailure = !this.closed;
    this.closed = true;
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
    // Unblock stream consumers so their `finally` runs instead of hanging.
    for (const w of this.frameWaiters.splice(0)) w(null);
    for (const w of this.jsonWaiters.splice(0)) w(null);
    if (firstFailure) for (const h of this.closeHandlers) h(err);
  }
}
