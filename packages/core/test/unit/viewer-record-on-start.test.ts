import { describe, expect, it, afterEach } from "vitest";
import { createConnection, type Socket } from "node:net";
import { startViewerServer, type ViewerServer } from "../../src/viewer/server.js";
import { decodeFrames, buildHandshake } from "../../src/cast/ws.js";
import type { H264Chunk } from "../../src/transport/model.js";
import type { CastClient } from "../../src/cast/types.js";
import type { Screen } from "../../src/driver/agent/screen.js";

const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78]);
const PPS = Buffer.from([0x68, 0xee, 0x3c, 0xb0]);
const IDR = Buffer.from([0x65, 0x88, 0x84, 0x00]);
const annexB = (...units: Buffer[]): Buffer =>
  Buffer.concat(units.map((u) => Buffer.concat([Buffer.from([0, 0, 0, 1]), u])));
const keyframe = (): H264Chunk => ({
  data: annexB(SPS, PPS, IDR),
  pts: 1000,
  flags: 0,
  isKeyFrame: true,
});

/** A cast the test pushes frames into, so "live" is reached on demand. */
class FakeCast implements CastClient {
  readonly castKind = "h264" as const;
  // Frames pushed before `stream()` is iterated must wait, not vanish: the
  // server opens the cast asynchronously, and a test that pushes immediately
  // after connecting would otherwise drop its only keyframe.
  private readonly queued: H264Chunk[] = [];
  private waiter: ((c: H264Chunk | null) => void) | null = null;
  push(chunk: H264Chunk): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(chunk);
    } else this.queued.push(chunk);
  }
  async *stream(): AsyncIterable<H264Chunk> {
    for (;;) {
      const next = this.queued.length
        ? this.queued.shift()!
        : await new Promise<H264Chunk | null>((resolve) => (this.waiter = resolve));
      if (next === null) return;
      yield next;
    }
  }
  async requestIDRFrame(): Promise<void> {}
  async dispose(): Promise<void> {
    this.waiter?.(null);
  }
}

const fakeScreen = (): Screen =>
  ({
    bundle: "com.example",
    display: { width: 1260, height: 2720 },
    elements: [],
    hash: "h",
    locked: false,
    ts: 1,
  }) as unknown as Screen;

const running: ViewerServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => undefined);
});

async function start(
  opts: { recordOnStart?: boolean; startGate?: Promise<void>; startFails?: Error } = {},
) {
  const cast = new FakeCast();
  const started: string[] = [];
  const stopped: string[] = [];
  const server = await startViewerServer({
    port: 0,
    host: "127.0.0.1",
    graceMs: 200,
    layoutMs: 30,
    ...(opts.recordOnStart ? { recordOnStart: true } : {}),
    source: {
      async createCast() {
        return cast;
      },
      async readScreen() {
        return fakeScreen();
      },
      async startRecording() {
        started.push("start");
        if (opts.startGate) await opts.startGate;
        if (opts.startFails) throw opts.startFails;
        return "/tmp/x.mp4";
      },
      async stopRecording() {
        stopped.push("stop");
        return "/tmp/x.mp4";
      },
    },
  });
  running.push(server);
  return { server, cast, started, stopped, port: server.port };
}

async function connect(port: number): Promise<{ socket: Socket; close(): void }> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    buildHandshake(`127.0.0.1:${port}`).replace("GET / HTTP/1.1", "GET /live HTTP/1.1"),
  );
  socket.on("data", () => undefined);
  return { socket, close: () => socket.destroy() };
}

/** Waits for the first text frame the server sends that `match` accepts. */
function readText(
  socket: Socket,
  match: (message: Record<string, unknown>) => boolean,
  ms = 4000,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("no matching text frame arrived"));
    }, ms);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        buf = buf.subarray(end + 4);
        upgraded = true;
      }
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode !== 0x1) continue;
        const message = JSON.parse(f.payload.toString()) as Record<string, unknown>;
        if (!match(message)) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(message);
        return;
      }
    };
    socket.on("data", onData);
  });
}

const until = async (fn: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * `--record <file>` names a file on the command line, so the person expects a
 * file when the window closes. The page's record button was the only way to
 * start one, which meant a mirror could run for an hour and write nothing.
 */
describe("recordOnStart", () => {
  // The record daemon runs beside the stream, not on it: it needs no decoded
  // frame and no tab. Waiting for `live` meant `--record` wrote nothing when
  // the browser failed to open, or when nobody was looking — a mirror left
  // running for an hour produced no file.
  it("starts recording at startup, before any tab connects", async () => {
    const h = await start({ recordOnStart: true });
    await until(() => h.started.length > 0);
    expect(h.started).toEqual(["start"]);
  });

  it("starts recording when the stream goes live", async () => {
    const h = await start({ recordOnStart: true });
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => h.started.length > 0);
    expect(h.started).toEqual(["start"]);
    c.close();
  });

  it("does not record unless asked", async () => {
    const h = await start();
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await new Promise((r) => setTimeout(r, 150));
    expect(h.started).toEqual([]);
    c.close();
  });

  // Closing while the start is still in flight used to leave a recording that
  // nobody would stop: `close()` only stops what `this.recording` names.
  it("waits for a recording it is starting before it returns from close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await start({ recordOnStart: true, startGate: gate });
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => h.started.length > 0);
    c.close();
    let closed = false;
    const closing = h.server.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(h.stopped).toEqual(["stop"]);
  });

  /**
   * `--record` can fail for a reason the person can act on — mjpeg, an
   * emulator without the extension, a device that refuses the second daemon.
   * Swallowing it left a live picture, a lit Record button and no file, with
   * nobody told. The reason belongs in the page's own record status.
   */
  it("reports a startup recording that failed instead of swallowing it", async () => {
    const h = await start({
      recordOnStart: true,
      startFails: new Error("record mode needs an H.264 extension; mjpeg cannot record"),
    });
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => h.started.length > 0);
    // The tab that was already attached learns about it from the broadcast.
    const text = await readText(c.socket, (m) => m.type === "record" && "error" in m);
    expect(String(text.error)).toMatch(/H\.264 extension/);
    c.close();
  });
});
