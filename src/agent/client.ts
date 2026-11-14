import type net from "node:net";
import { FrameDemux } from "./demux.js";
import { SerialQueue } from "./queue.js";
import {
  AgentBusyError,
  AgentConnectionError,
  AgentProtocolError,
} from "../errors.js";

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
