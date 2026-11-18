import { createServer, createConnection, type Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { HdcRunner } from "../transport/hdc.js";
import { DaemonStartError, ExtensionMissingError, UitestError } from "../transport/errors.js";
import type { H264Chunk } from "../transport/model.js";
import type { CastClient, CastOptions } from "./types.js";
import { ownDaemon, pids } from "./daemon.js";
import {
  buildHandshake,
  decodeFrames,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  handshakeStatus,
  isKeyFrame,
  WS_OPCODE_BINARY,
  WS_OPCODE_CLOSE,
  WS_OPCODE_PING,
  WS_OPCODE_TEXT,
} from "./ws.js";

/** Hardcoded in the 7.0 extension; `-m 1` always writes here. */
const DEVICE_RECORD_PATH = "/data/local/tmp/mytest.mp4";
const DEFAULT_PORT = 5000;
const DEFAULT_EXTENSION = "libscreen_casting.z.so";

/**
 * Pushes the extension when the device copy is not already the same file.
 * Size alone is the check `Device.connect` uses; here the file is user-supplied
 * so a stale same-size copy would be indistinguishable — push only on mismatch.
 */
async function pushExtension(hdc: HdcRunner, local: string, remote: string): Promise<void> {
  const localSize = statSync(local).size;
  const listing = await hdc.shell(`ls -l ${remote}`).catch(() => "");
  const m = /^\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/.exec(listing.trim());
  if (m && Number(m[1]) === localSize) return;
  // `hdc file send` onto an existing path can silently keep the old file, so
  // remove first — measured, not assumed.
  await hdc.shell(`rm -f ${remote}`).catch(() => undefined);
  await hdc.push(local, remote);
  await hdc.shell(`chmod 755 ${remote}`);
}

interface Pending {
  match: string;
  resolve: (msg: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * H.264 client for the 7.0 casting extension, over RFC6455 on TCP.
 *
 * Lifecycle measured on a real device, and it is stricter than it looks:
 * `stop` is process-wide (one client stopping silences every other client),
 * and after `stop` the listening socket is closed for good — the process stays
 * alive but nothing can connect again. A client that disconnects without
 * `stop` leaves a daemon that accepts connections and answers `started` but
 * never emits a frame. So one client owns exactly one daemon, exactly like the
 * 6.8 gRPC path, and `dispose()` always kills it.
 */
export class WsCastClient implements CastClient {
  readonly castKind = "h264" as const;

  private disposed = false;
  /** In-flight `dispose()`, so a second caller waits instead of repeating it. */
  private disposePromise: Promise<void> | null = null;
  /** The `durationMs` stop timer, cleared when the caller disposes first. */
  private durationTimer: NodeJS.Timeout | undefined;
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  /** Commands awaiting a reply, matched by a substring of the reply's `type`. */
  private readonly pending: Pending[] = [];
  /** Frames decoded but not yet pulled by the iterator. */
  private readonly queue: H264Chunk[] = [];
  /** Resolver of the iterator currently waiting for a frame. */
  private waiting: ((chunk: H264Chunk | null) => void) | null = null;
  private closed = false;

  private constructor(
    private readonly hdc: HdcRunner,
    private readonly ownPid: string,
    private readonly localPort: number,
    private readonly opts: CastOptions,
  ) {}

  static async start(hdc: HdcRunner, opts: CastOptions): Promise<WsCastClient> {
    if (opts.mode === "record" && !opts.outputPath) {
      throw new UitestError(
        "record mode needs outputPath: the device-side file is pulled there on dispose()",
        "EBADARG",
      );
    }
    const port = opts.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new UitestError(`port must be 1..65535, got ${port}`, "EBADARG");
    }
    // Same range as the 6.8 client. `CastOptions.scale` is a plain number now
    // that `maxSize` resolves per transport, so this check is the only thing
    // between a caller and `-scale 2.5` on the device.
    if (opts.scale !== undefined && (!Number.isInteger(opts.scale) || opts.scale < 1 || opts.scale > 5)) {
      throw new UitestError(`scale must be 1..5, got ${opts.scale}`, "EBADARG");
    }
    // `--extension-name` is a filename lookup in /data/local/tmp, not a path.
    if (!opts.wsExtension) {
      throw new ExtensionMissingError(
        "ws transport needs wsExtension: the SDK bundles the 6.8 build, not the 7.0 one",
        "ENOEXT",
      );
    }
    if (!existsSync(opts.wsExtension)) {
      throw new ExtensionMissingError(`wsExtension ${opts.wsExtension} does not exist`, "ENOEXT");
    }
    const extensionName = basename(opts.wsExtension);
    await pushExtension(hdc, opts.wsExtension, `/data/local/tmp/${extensionName}`);

    const args = [
      "start-daemon",
      "singleness",
      "--extension-name",
      extensionName,
      "-m",
      opts.mode === "record" ? "1" : "0",
      "-screenId",
      String(opts.screenId ?? 0),
      "-scale",
      String(opts.scale ?? 1),
      "-frameRate",
      String(opts.frameRate ?? 30),
      "-bitRate",
      String(opts.bitRate ?? 8_000_000),
      "-iFrameInterval",
      String(opts.iFrameInterval ?? 2000),
      "-p",
      String(port),
    ];
    // The pidof difference is the only identity left when the marker lookup
    // below misses; without it a daemon that started is abandoned.
    const beforeStart = pids(await hdc.shell("pidof uitest"));
    await hdc.shell(`/system/bin/uitest ${args.join(" ")}`);

    // Identify our daemon by its `-p <port>` in the argv, not by pid timing:
    // two clients starting in the same window each see the other's daemon as a
    // new pid, and killing that one is how two pages take turns killing each
    // other's daemons.
    const ownPid = await ownDaemon(hdc, `-p ${port}`);
    if (!ownPid) {
      // A daemon that launched but has not shown up in `ps -ef` yet is still
      // this call's process. Exactly one new pid is attributable to it.
      const fresh = [...pids(await hdc.shell("pidof uitest"))].filter((p) => !beforeStart.has(p));
      if (fresh.length === 1) {
        await hdc.shell(`kill -9 ${fresh[0]!}`).catch(() => undefined);
      }
      throw new DaemonStartError(
        `casting daemon did not start (no process carries -p ${port}; ` +
          `port ${port} may already be in use by another daemon)`,
        "ENODAEMON",
      );
    }

    let localPort = 0;
    let socket: Socket | null = null;
    try {
      await waitForListen(hdc, port);
      if (!pids(await hdc.shell("pidof uitest")).has(ownPid)) {
        throw new DaemonStartError(`casting daemon ${ownPid} exited before listening on ${port}`, "ENODAEMON");
      }
      localPort = await hdc.fportAdd(await freePort(), `tcp:${port}`);
      socket = await connect(localPort);
      await upgrade(socket, `127.0.0.1:${port}`);
    } catch (e) {
      socket?.destroy();
      if (localPort !== 0) await hdc.fportRemove(localPort).catch(() => undefined);
      await hdc.shell(`kill -9 ${ownPid}`).catch(() => undefined);
      throw e;
    }

    const client = new WsCastClient(hdc, ownPid, localPort, opts);
    client.attach(socket);
    // Record mode never iterates `stream()`, and `start` is what opens the
    // muxer — without this the recording is empty and `stop` writes nothing.
    //
    // This runs after the forward and the socket, so a refusal here must
    // release them: the client is not returned to any caller, and its own
    // `dispose()` would send `stop` to an extension that never started.
    if (opts.mode === "record") {
      try {
        await client.command({ type: "start" }, "started");
      } catch (e) {
        socket.destroy();
        await hdc.fportRemove(localPort).catch(() => undefined);
        await hdc.shell(`kill -9 ${ownPid}`).catch(() => undefined);
        throw e;
      }
      client.armDuration();
    }
    return client;
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.on("data", (d) => this.onData(d));
    socket.on("error", () => this.onClosed());
    socket.on("close", () => this.onClosed());
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting?.(null);
    this.waiting = null;
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(new UitestError("cast connection closed before the reply arrived", "ECASTCLOSED"));
    }
  }

  private onData(d: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, d]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === WS_OPCODE_BINARY) {
        // The 4-byte big-endian length prefix is the payload length minus the
        // prefix itself; verified on the real daemon for every frame seen.
        if (frame.payload.length < 4) continue;
        const data = frame.payload.subarray(4);
        const chunk: H264Chunk = {
          data,
          pts: Date.now(),
          flags: 0,
          isKeyFrame: isKeyFrame(data),
        };
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w(chunk);
        } else {
          this.queue.push(chunk);
        }
      } else if (frame.opcode === WS_OPCODE_TEXT) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(msg["type"] ?? "");
        const idx = this.pending.findIndex((p) => type === p.match);
        if (idx >= 0) {
          const [p] = this.pending.splice(idx, 1);
          clearTimeout(p!.timer);
          p!.resolve(msg);
        }
      } else if (frame.opcode === WS_OPCODE_PING) {
        this.socket?.write(encodePongFrame(frame.payload));
      } else if (frame.opcode === WS_OPCODE_CLOSE) {
        this.socket?.write(encodeCloseFrame());
        this.socket?.end();
        this.onClosed();
      }
    }
  }

  /** Sends a command and resolves with the reply whose `type` equals `expect`. */
  private command(payload: Record<string, unknown>, expect: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new UitestError("cast client has been disposed", "EDISPOSED"));
      if (this.closed) return reject(new UitestError("cast connection is closed", "ECASTCLOSED"));
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new UitestError(`no ${expect} reply within ${timeoutMs} ms`, "ECASTTIMEOUT"));
      }, timeoutMs);
      this.pending.push({ match: expect, resolve, reject, timer });
      this.socket?.write(encodeTextFrame(JSON.stringify(payload)));
    });
  }

  async *stream(): AsyncIterable<H264Chunk> {
    if (this.disposed) throw new UitestError("cast client has been disposed", "EDISPOSED");
    await this.command({ type: "start" }, "started");

    for (;;) {
      if (this.disposed || this.closed) return;
      const queued = this.queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      const next = await new Promise<H264Chunk | null>((resolve) => {
        this.waiting = resolve;
      });
      if (!next) return;
      yield next;
    }
  }

  async requestIDRFrame(): Promise<void> {
    await this.command({ type: "requestIDR" }, "idrResponse");
  }

  async dispose(): Promise<void> {
    // A `durationMs` timer can fire while the caller is already disposing, so
    // the second call must wait for the first rather than run beside it: two
    // `stop` commands are two pulls of the same file.
    if (this.disposePromise) return this.disposePromise;
    if (this.disposed) return;
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  /**
   * Ends the recording after `durationMs`, if it was given.
   *
   * The timer calls `dispose()`, which is what closes the muxer and pulls the
   * file — the same path a caller takes.
   */
  private armDuration(): void {
    const ms = this.opts.durationMs;
    if (ms === undefined || ms <= 0) return;
    this.durationTimer = setTimeout(() => {
      this.durationTimer = undefined;
      void this.dispose().catch(() => undefined);
    }, ms);
    // Never keep the process alive just for a recording deadline.
    this.durationTimer.unref?.();
  }

  private async finishDispose(): Promise<void> {
    clearTimeout(this.durationTimer);
    this.durationTimer = undefined;

    // `stop` is what closes the muxer in record mode, so it must go out before
    // the socket dies — and before `disposed` is set, because `command()`
    // refuses to send on a disposed client.
    if (!this.closed) {
      await this.command({ type: "stop" }, "stopped", 8000).catch(() => undefined);
    }
    this.disposed = true;
    this.socket?.write(encodeCloseFrame());
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
    this.onClosed();

    // The cleanup below runs even when the pull throws: a failed transfer is
    // exactly when a stray daemon and forward are easiest to leave behind.
    try {
      if (this.opts.mode === "record" && this.opts.outputPath) {
        await waitForFile(this.hdc, DEVICE_RECORD_PATH);
        await this.hdc.pull(DEVICE_RECORD_PATH, this.opts.outputPath);
      }
    } finally {
      // The daemon cannot serve anyone after `stop` (its listening socket is
      // gone), so leaving it would only strand a process.
      await this.hdc.shell(`kill -9 ${this.ownPid}`).catch(() => undefined);
      await this.hdc.fportRemove(this.localPort).catch(() => undefined);
    }
  }
}

function connect(port: number, timeoutMs = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new UitestError(`connect to the forwarded cast port timed out after ${timeoutMs} ms`, "ECASTCONNECT"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.off("error", onError);
      resolve(sock);
    });
    const onError = (e: Error) => {
      clearTimeout(timer);
      reject(new UitestError(`connect to the forwarded cast port failed: ${e.message}`, "ECASTCONNECT", e));
    };
    sock.once("error", onError);
  });
}

function upgrade(socket: Socket, host: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new UitestError(`WebSocket upgrade timed out after ${timeoutMs} ms`, "ECASTUPGRADE"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      const status = handshakeStatus(head);
      cleanup();
      if (status !== 101) {
        reject(
          new UitestError(
            `the casting extension refused the WebSocket upgrade (${status ?? "no status line"}); ` +
              "is this the 7.0 build, and is the daemon really listening on this port?",
            "ECASTUPGRADE",
          ),
        );
        return;
      }
      // Anything after the header block belongs to the frame stream.
      if (buf.length > end + 4) socket.unshift(buf.subarray(end + 4));
      resolve();
    };
    const onError = (e: Error) => {
      cleanup();
      reject(new UitestError(`WebSocket upgrade failed: ${e.message}`, "ECASTUPGRADE", e));
    };
    const onClose = () => {
      cleanup();
      reject(new UitestError("the casting extension closed the connection during the upgrade", "ECASTUPGRADE"));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(buildHandshake(host));
  });
}

/** Waits for the daemon to listen on `port`, per /proc/net/tcp. */
async function waitForListen(hdc: HdcRunner, port: number, timeoutMs = 5000): Promise<void> {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await hdc.shell("cat /proc/net/tcp").catch(() => "");
    const listening = out.split(/\r?\n/).some((line) => {
      const f = line.trim().split(/\s+/);
      return f.length >= 4 && (f[1] ?? "").endsWith(`:${hex}`) && f[3] === "0A";
    });
    if (listening) return;
    if (Date.now() > deadline) {
      throw new DaemonStartError(`nothing is listening on device port ${port} after ${timeoutMs} ms`, "ENOSOCKET");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Waits until the recorder has stopped writing, then returns the final size.
 *
 * A non-zero size is not enough: the 7.0 muxer creates the MP4 as a 259-byte
 * header as soon as it opens and appends the samples at `stop`. Pulling on the
 * first non-zero size yields a header-only file (measured: 259 B pulled while
 * 140 KB had been recorded). So poll until the size is unchanged across two
 * reads *and* big enough to be more than a header.
 */
async function waitForFile(hdc: HdcRunner, path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  for (;;) {
    const out = await hdc.shell(`ls -l ${path}`).catch(() => "");
    const m = /\s(\d+)\s+\d{4}-/.exec(out) ?? /\s(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+/.exec(out);
    const size = m ? Number(m[1]) : -1;
    if (size > 1024 && size === previous) return;
    if (Date.now() > deadline) {
      throw new DaemonStartError(
        `recorded file ${path} never settled (last size ${size} B) — the recorder wrote nothing`,
        "ENORECORD",
      );
    }
    previous = size;
    await new Promise((r) => setTimeout(r, 300));
  }
}
