import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { HdcRunner } from "../hdc.js";
import { DaemonStartError, UitestError } from "../errors.js";
import type { H264Chunk } from "../model.js";
import type { CastClient, CastOptions, JpegFrame } from "./types.js";

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

/** Parses `pidof` output. Multiple pids come back space-separated on one line. */
function pids(output: string): Set<string> {
  return new Set(output.split(/\s+/).filter((t) => /^\d+$/.test(t)));
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

    const before = pids(await hdc.shell("pidof uitest"));

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

    // The only way to find our own daemon: pidof returns every uitest process,
    // and neither /proc/<pid>/fd nor `netstat -p` is readable from shell.
    const after = pids(await hdc.shell("pidof uitest"));
    const fresh = [...after].filter((p) => !before.has(p));
    if (fresh.length === 0) {
      throw new DaemonStartError(
        `casting daemon did not start (pidof uitest unchanged; extension ${EXTENSION_NAME})`,
        "ENODAEMON",
      );
    }
    const ownPid = fresh[fresh.length - 1]!;

    await waitForSocket(hdc, socketName);
    const localPort = await hdc.fportAdd(await freePort(), `localabstract:${socketName}`);

    const Service = loadScrcpyService();
    const stub = new Service(`127.0.0.1:${localPort}`, grpc.credentials.createInsecure());
    return new H264CastClient(hdc, stub, socketName, ownPid, localPort, opts);
  }

  async *stream(): AsyncIterable<H264Chunk> {
    if (this.disposed) {
      throw new UitestError("cast client has been disposed", "EDISPOSED");
    }
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
    if (this.disposed) return;
    this.disposed = true;

    await new Promise<void>((resolve) => {
      (this.stub as unknown as {
        onEnd(req: object, cb: (e: Error | null) => void): void;
      }).onEnd({}, () => resolve());
    }).catch(() => undefined);

    this.stub.close();

    // Kill only our own daemon: agent.so lives in a sibling uitest process.
    await this.hdc.shell(`kill -9 ${this.ownPid}`).catch(() => undefined);
    await this.hdc.fportRemove(this.localPort).catch(() => undefined);

    if (this.opts.mode === "record" && this.opts.outputPath) {
      await this.hdc.pull(DEVICE_RECORD_PATH, this.opts.outputPath);
    }
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
