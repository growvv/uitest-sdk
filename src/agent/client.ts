import type net from "node:net";
import jpeg from "jpeg-js";
import { FrameDemux } from "./demux.js";
import { SerialQueue } from "./queue.js";
import {
  AgentBusyError,
  AgentConnectionError,
  AgentProtocolError,
} from "../errors.js";
import type { Rect, UiNode } from "../model.js";
import { cropRect, parseBounds } from "../util/bounds.js";

export type AgentMethod = "Captures" | "CtrlCmd" | "Gestures" | "callHypiumApi";

export interface AgentClientOptions {
  requestTimeoutMs?: number;
  retryOnBusy?: boolean;
  maxBusyRetries?: number;
}

export const MODULE_ID = "com.ohos.devicetest.hypiumApiHelper";

const BUSY_PATTERNS = ["Disallow concurrent use", "Capture already running"];

export function isBusyException(msg: string): boolean {
  return BUSY_PATTERNS.some((p) => msg.includes(p));
}

interface AgentReply {
  result?: unknown;
  exception?: string;
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
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly retryOnBusy: boolean;
  private readonly maxBusyRetries: number;

  constructor(
    private readonly sock: net.Socket,
    opts: AgentClientOptions = {},
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.retryOnBusy = opts.retryOnBusy ?? true;
    this.maxBusyRetries = opts.maxBusyRetries ?? 40;

    this.demux = new FrameDemux({
      onJson: (line) => this.onJson(line),
      onFrame: (jpeg) => {
        for (const h of this.frameHandlers) h(jpeg);
      },
    });

    sock.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      this.demux.push(chunk);
    });
    sock.on("error", (e) => this.fail(new AgentConnectionError(`agent socket error: ${e.message}`, "ECONN", e)));
    sock.on("close", () => this.fail(new AgentConnectionError("agent connection closed", "ECONN")));
  }

  get connected(): boolean {
    return !this.closed && !this.sock.destroyed;
  }

  onFrame(handler: (jpeg: Buffer) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  call(method: AgentMethod, params: object): Promise<unknown> {
    if (!this.connected) {
      return Promise.reject(new AgentConnectionError("agent is not connected", "ECONN"));
    }
    return this.queue.run(async () => {
      let delay = 0.5;
      for (let attempt = 0; ; attempt++) {
        const raw = await this.sendOnce(method, params);
        if (raw.exception == null) return raw.result;

        const busy = isBusyException(raw.exception);
        if (!this.retryOnBusy || !busy) {
          throw busy
            ? new AgentBusyError(raw.exception, "EBUSY")
            : new AgentProtocolError(raw.exception, "EPROTO");
        }
        if (attempt >= this.maxBusyRetries) {
          throw new AgentBusyError(
            `device stayed busy after ${attempt + 1} attempts: ${raw.exception}`,
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

  async touchDown(x: number, y: number): Promise<void> {
    await this.call("Gestures", { api: "touchDown", args: { x, y } });
  }

  async touchMove(x: number, y: number): Promise<void> {
    await this.call("Gestures", { api: "touchMove", args: { x, y } });
  }

  async touchUp(x: number, y: number): Promise<void> {
    await this.call("Gestures", { api: "touchUp", args: { x, y } });
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
    await this.touchDown(x1, y1);
    for (let i = 1; i <= steps; i++) {
      await this.touchMove(Math.round(x1 + ((x2 - x1) * i) / steps), Math.round(y1 + ((y2 - y1) * i) / steps));
      await sleep(stepDelay);
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
    const first = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new AgentProtocolError("no frame received from capture stream", "ETIMEDOUT"));
      }, this.requestTimeoutMs);
      const off = this.onFrame((f) => {
        clearTimeout(timer);
        off();
        resolve(f);
      });
    });

    await this.call("Captures", { api: "startCaptureScreen", args: [{ displayId: 0, scale }] });
    try {
      return await first;
    } finally {
      await this.call("Captures", { api: "stopCaptureScreen", args: [] });
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

    const frame = await this.captureScreen({ scale });
    const img = jpeg.decode(frame);
    const scaled: Rect = {
      x: Math.round(bounds.x * scale),
      y: Math.round(bounds.y * scale),
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale),
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new AgentConnectionError("agent client closed", "ECONN"));
    this.sock.destroy();
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
    this.pending = null;
    if (!p) return; // unsolicited reply (e.g. a stream ack after timeout) — drop
    p.resolve(reply);
  }

  private fail(err: unknown): void {
    if (this.closed && this.pending === null) return;
    this.closed = true;
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
  }
}
