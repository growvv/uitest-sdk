import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { HdcRunner } from "../hdc.js";
import { DaemonStartError, UitestError } from "../errors.js";
import type { H264Chunk } from "../model.js";
import type { CastClient, CastOptions, JpegFrame } from "./types.js";
import { ownDaemon, pids } from "./daemon.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadScrcpyService(): grpc.ServiceClientConstructor {
  const def = protoLoader.loadSync(join(HERE, "scrcpy.proto"), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as Record<string, grpc.ServiceClientConstructor>;
  // No package declaration in the proto, so the service sits at the top level.
  return pkg["ScrcpyService"]!;
}

const EXTENSION_NAME = "libscreen_casting.z.so";
const STREAM_SOCKET = "scrcpy_grpc_socket";
const RECORD_SOCKET = "screen_record_grpc_socket";
/** Hardcoded in the extension binary; there is no CLI flag to change it. */
const DEVICE_RECORD_PATH = "/data/local/tmp/mytest.mp4";
/**
 * How long `dispose()` waits for the device to acknowledge `onEnd`.
 *
 * A recording is flushed by then, or the daemon is gone and no acknowledgement
 * is coming; either way the caller must not wait longer than this.
 */
const ON_END_TIMEOUT_MS = 8000;

interface ReplyMessage {
  data: string;
  reply_type: number;
  payload: Record<string, { val_int?: string; val_bytes?: Buffer }>;
}

/** Asks the OS for a free loopback port. hdc cannot do `tcp:0`. */
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
 * H.264 client for the 6.8 casting extension, over gRPC on an abstract unix
 * socket forwarded through hdc fport.
 *
 * Two hard rules from measurement: `onEnd` is sticky (a daemon that has served
 * it never emits again), and `onStart` cannot be called twice in one process.
 * One client therefore owns exactly one daemon process, and is unusable after
 * `dispose()`.
 */
export class H264CastClient implements CastClient {
  readonly castKind = "h264" as const;

  private disposed = false;
  /** True once `stream()` opened the gRPC call. */
  private started = false;
  /** Open `onStart` call in record mode, cancelled after `onEnd`. */
  private recordCall: { cancel(): void } | null = null;
  /** In-flight `dispose()`, so a second caller waits instead of repeating it. */
  private disposePromise: Promise<void> | null = null;
  /** The `durationMs` stop timer, cleared when the caller disposes first. */
  private durationTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly hdc: HdcRunner,
    private readonly stub: grpc.Client,
    private readonly socketName: string,
    private readonly ownPid: string,
    private readonly localPort: number,
    private readonly opts: CastOptions,
  ) {}

  static async start(hdc: HdcRunner, opts: CastOptions): Promise<H264CastClient> {
    const socketName =
      opts.socketName ?? (opts.mode === "record" ? RECORD_SOCKET : STREAM_SOCKET);
    if (opts.scale !== undefined && (opts.scale < 1 || opts.scale > 5)) {
      throw new UitestError(`scale must be 1..5, got ${opts.scale}`, "EBADARG");
    }
    // The device path is hardcoded in the extension. Without a pull destination
    // the recording would be closed and then silently left on the device.
    if (opts.mode === "record" && !opts.outputPath) {
      throw new UitestError(
        "record mode needs outputPath: the device-side file is pulled there on dispose()",
        "EBADARG",
      );
    }

    const args = [
      "start-daemon",
      "singleness",
      "--extension-name",
      EXTENSION_NAME,
      "-m",
      opts.mode === "record" ? "1" : "0",
      "-screenId",
      String(opts.screenId ?? 0),
      "-scrcpy_socket_name",
      socketName,
      "-record_socket_name",
      socketName,
      "-scale",
      String(opts.scale ?? 1),
      "-frameRate",
      String(opts.frameRate ?? 30),
      "-bitRate",
      String(opts.bitRate ?? 8_000_000),
      "-iFrameInterval",
      String(opts.iFrameInterval ?? 2000),
    ];
    await hdc.shell(`/system/bin/uitest ${args.join(" ")}`);

    // Identify our daemon by the socket name in its argv, not by the timing of
    // its arrival: `pidof` returns every uitest process, so a sibling starting
    // in the same window would otherwise be indistinguishable from ours.
    // Nothing is killed here — a fresh pid that does not carry our socket name
    // belongs to somebody else, and killing it would make two clients take
    // turns killing each other's daemons.
    const ownPid = await ownDaemon(hdc, `-scrcpy_socket_name ${socketName}`);
    if (!ownPid) {
      throw new DaemonStartError(
        `casting daemon did not start (no process carries -scrcpy_socket_name ${socketName}; extension ${EXTENSION_NAME})`,
        "ENODAEMON",
      );
    }

    let localPort = 0;
    try {
      await waitForSocket(hdc, socketName);
      // The socket name is fixed per mode, so a name match may belong to an
      // older daemon. Only our own process being alive proves it is serving us.
      if (!pids(await hdc.shell("pidof uitest")).has(ownPid)) {
        throw new DaemonStartError(
          `casting daemon ${ownPid} exited before serving ${socketName}`,
          "ENODAEMON",
        );
      }
      localPort = await hdc.fportAdd(await freePort(), `localabstract:${socketName}`);
    } catch (e) {
      // Never leak the process we spawned, nor a half-made forward.
      if (localPort !== 0) await hdc.fportRemove(localPort).catch(() => undefined);
      await hdc.shell(`kill -9 ${ownPid}`).catch(() => undefined);
      throw e;
    }

    const Service = loadScrcpyService();
    const stub = new Service(`127.0.0.1:${localPort}`, grpc.credentials.createInsecure());
    const client = new H264CastClient(hdc, stub, socketName, ownPid, localPort, opts);

    // Record mode must be started here: `onEnd` only closes a muxer that
    // `onStart` opened, and a client that never opened one records zero frames.
    if (opts.mode === "record") {
      client.beginRecording();
      client.armDuration();
    }
    return client;
  }

  /**
   * Ends the recording after `durationMs`, if it was given.
   *
   * The timer calls `dispose()`, which is what closes the muxer and pulls the
   * file — the same path a caller takes. A rejection here would be unhandled
   * and invisible, so it is swallowed: the file either appears or the caller's
   * own `dispose()` reports why not.
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

  /** Opens the recording stream. Frames go to the muxer, not to us. */
  private beginRecording(): void {
    const call = (this.stub as unknown as {
      onStart(req: object): { on(e: string, f: (err: Error) => void): void; cancel(): void };
    }).onStart({});
    call.on("error", () => undefined);
    this.started = true;
    this.recordCall = call;
  }

  async *stream(): AsyncIterable<H264Chunk> {
    if (this.disposed) {
      throw new UitestError("cast client has been disposed", "EDISPOSED");
    }
    this.started = true;
    const call = (this.stub as unknown as {
      onStart(req: object): grpc.ClientReadableStream<ReplyMessage>;
    }).onStart({});

    for await (const msg of call as AsyncIterable<ReplyMessage>) {
      const p = msg.payload ?? {};
      const data = p["data"]?.val_bytes;
      if (!data) continue;
      const flags = Number(p["flags"]?.val_int ?? 0);
      yield {
        data: Buffer.from(data),
        pts: Number(p["pts"]?.val_int ?? 0),
        flags,
        isKeyFrame: flags === 2 || flags === 8,
      };
    }
  }

  async requestIDRFrame(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      (this.stub as unknown as {
        onRequestIDRFrame(req: object, cb: (e: Error | null, r: unknown) => void): void;
      }).onRequestIDRFrame({}, (err) => (err ? reject(err) : resolve()));
    });
  }

  async dispose(): Promise<void> {
    // A `durationMs` timer can fire while the caller is already disposing, so
    // the second call must wait for the first rather than run beside it: two
    // `onEnd` calls are two pulls of the same file.
    if (this.disposePromise) return this.disposePromise;
    if (this.disposed) return;
    this.disposed = true;
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  private async finishDispose(): Promise<void> {
    clearTimeout(this.durationTimer);
    this.durationTimer = undefined;

    // In record mode the encoder is start/stop driven: `onStart` runs the muxer
    // and `onEnd` closes it, writing the file. `start()` already opened the
    // recording, so `onEnd` alone completes it.
    //
    // The wait is bounded: a unary gRPC call on a channel that is stuck
    // mid-handshake is never timed out, and after a long stream the daemon can
    // be gone. Waiting for that callback with no end hung `LiveServer.close()`
    // for half an hour, leaving the live HTTP port listening. A stop that
    // cannot complete is a recording that cannot be collected either — the
    // cleanup below (kill, pull) still runs, and `stub.close()` cancels the
    // call.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ON_END_TIMEOUT_MS);
      (this.stub as unknown as {
        onEnd(req: object, cb: (e: Error | null) => void): void;
      }).onEnd({}, () => {
        clearTimeout(timer);
        resolve();
      });
    }).catch(() => undefined);

    this.recordCall?.cancel();
    this.recordCall = null;
    this.stub.close();

    // Pull before killing: `onEnd` only closes the muxer, and the file is
    // flushed by the daemon as it winds down. Killing first leaves nothing.
    // The cleanup below runs even when the pull throws — a failed transfer is
    // exactly when a stray daemon and forward are easiest to leave behind.
    try {
      if (this.opts.mode === "record" && this.opts.outputPath) {
        await waitForFile(this.hdc, DEVICE_RECORD_PATH);
        await this.hdc.pull(DEVICE_RECORD_PATH, this.opts.outputPath);
      }
    } finally {
      // Kill only our own daemon: agent.so lives in a sibling uitest process.
      await this.hdc.shell(`kill -9 ${this.ownPid}`).catch(() => undefined);
      await this.hdc.fportRemove(this.localPort).catch(() => undefined);
    }
  }
}

/** Waits for the recorder to finish flushing its MP4. */
async function waitForFile(hdc: HdcRunner, path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await hdc.shell(`ls -l ${path}`).catch(() => "");
    const m = /\s(\d+)\s+\d{4}-/.exec(out) ?? /\s(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+/.exec(out);
    if (m && Number(m[1]) > 0) return;
    if (Date.now() > deadline) {
      throw new DaemonStartError(`recorded file ${path} never appeared`, "ENORECORD");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForSocket(hdc: HdcRunner, name: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await hdc.shell(`cat /proc/net/unix | grep ${name}`);
    if (out.includes(name)) return;
    if (Date.now() > deadline) {
      throw new DaemonStartError(`socket ${name} never appeared within ${timeoutMs} ms`, "ENOSOCKET");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export type { CastClient, CastOptions, JpegFrame };
