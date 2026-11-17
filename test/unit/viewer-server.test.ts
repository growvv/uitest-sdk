import { describe, it, expect, afterEach } from "vitest";
import { createConnection, type Socket } from "node:net";
import {
  ViewerServer,
  startViewerServer,
  type ViewerHooks,
  type ViewerInputMode,
} from "../../src/viewer/server.js";
import { renderPlayerPage } from "../../src/viewer/player.js";
import { buildHandshake, decodeFrames, encodeTextFrame } from "../../src/cast/ws.js";
import type { H264Chunk } from "../../src/transport/model.js";
import type { JpegFrame } from "../../src/cast/types.js";
import type { Screen } from "../../src/driver/agent/screen.js";
import type { CastClient } from "../../src/cast/types.js";
import type { InputLane, InputSession } from "../../src/input/lane.js";

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

const delta = (n = 1, size = 4): H264Chunk => ({
  data: annexB(Buffer.alloc(size, 0x41)),
  pts: 1000 + n,
  flags: 0,
  isKeyFrame: false,
});

/** The second agent connection, faked at the lane boundary. */
class FakeInputLane implements InputLane {
  calls: Array<[string, ...unknown[]]> = [];
  fail = false;
  closed = false;
  private go(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push([name, ...args]);
    if (this.fail) return Promise.reject(new Error("lane failed"));
    return Promise.resolve();
  }
  click(...a: [number, number]) { return this.go("click", ...a); }
  touchDown(x: number, y: number) { return this.go("touchDown", x, y); }
  touchMove(x: number, y: number) { return this.go("touchMove", x, y); }
  touchUp(x: number, y: number) { return this.go("touchUp", x, y); }
  key(code: number) { return this.go("key", code); }
  text(x: number, y: number, text: string, mode: string) { return this.go("text", x, y, text, mode); }
  pinch(cx: number, cy: number, from: number, to: number, ms: number) { return this.go("pinch", cx, cy, from, to, ms); }
  scroll(x: number, y: number, down: boolean, steps: number) { return this.go("scroll", x, y, down, steps); }
  async close() { this.closed = true; }
  ops(name: string) { return this.calls.filter((c) => c[0] === name).map((c) => c.slice(1)); }
}

/** A cast whose frames are pushed by the test. */
class FakeCast implements CastClient {
  readonly castKind = "h264" as const;
  readonly queued: H264Chunk[] = [];
  private waiter: ((c: H264Chunk | null) => void) | null = null;
  disposed = false;
  idrRequests = 0;

  push(chunk: H264Chunk): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(chunk);
    } else this.queued.push(chunk);
  }

  async *stream(): AsyncIterable<H264Chunk> {
    for (;;) {
      if (this.disposed) return;
      const queued = this.queued.shift();
      if (queued) {
        yield queued;
        continue;
      }
      const next = await new Promise<H264Chunk | null>((resolve) => {
        this.waiter = resolve;
      });
      if (!next) return;
      yield next;
    }
  }

  async requestIDRFrame(): Promise<void> {
    this.idrRequests++;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.waiter?.(null);
  }
}

/** An MJPEG cast, which is what x86_64 devices have instead of H.264. */
class FakeMjpegCast implements CastClient {
  readonly castKind = "mjpeg" as const;
  readonly queued: JpegFrame[] = [];
  private waiter: ((c: JpegFrame | null) => void) | null = null;
  disposed = false;

  push(frame: JpegFrame): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(frame);
    } else this.queued.push(frame);
  }

  async *stream(): AsyncIterable<JpegFrame> {
    for (;;) {
      if (this.disposed) return;
      const queued = this.queued.shift();
      if (queued) {
        yield queued;
        continue;
      }
      const next = await new Promise<JpegFrame | null>((resolve) => {
        this.waiter = resolve;
      });
      if (!next) return;
      yield next;
    }
  }

  async requestIDRFrame(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
    this.waiter?.(null);
  }
}

const element = (ref: number, label: string, masked = false) => ({
  ref,
  role: "button" as const,
  label,
  rect: { x: ref * 10, y: ref * 20, width: 100, height: 40 },
  center: { x: ref * 10 + 50, y: ref * 20 + 20 },
  state: [] as string[],
  clickable: true,
  input: false,
  scrollable: false,
  focused: false,
  signature: `sig-${ref}`,
  node: { attributes: {}, children: [] },
  ...(masked ? { masked: true } : {}),
});

function fakeScreen(label = "Save"): Screen {
  const elements = [element(1, label), element(2, "hunter2", true)];
  return {
    header: "screen 400x800 · app: com.demo",
    bundle: "com.demo",
    display: { width: 400, height: 800 },
    rotation: 0,
    elements,
    lines: elements.map((e) => `[${e.ref}] button "${e.label}"`),
    hash: "h-" + label,
    signatures: new Set(elements.map((e) => e.signature)),
    tree: { attributes: {}, children: [] },
    at: Date.now(),
  };
}

interface Harness {
  server: ViewerServer;
  cast: FakeCast;
  port: number;
  setScreen(s: Screen): void;
  screenReads(): number;
  /** Redaction flags the server asked the layout source for, in order. */
  redactions(): boolean[];
  /** Screenshots the server asked the source to save. */
  shots(): number;
  /** Recordings started. */
  recordings(): number;
  /** Recordings stopped, including the one `close()` stops. */
  recordStops(): number;
  /** Lets a `stopRecording` held by `holdStop` finish. */
  releaseStop(): void;
  /** Input lanes opened so far, in order. */
  lanes(): FakeInputLane[];
  /** How many times the source was asked for an input lane. */
  openInputs(): number;
}

const running: ViewerServer[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => undefined);
});

async function start(
  over: {
    privacy?: boolean;
    graceMs?: number;
    layoutMs?: number;
    captureError?: string;
    /** Keeps `stopRecording` pending until the returned function is called. */
    holdStop?: boolean;
    watchdogMs?: number;
    /** Makes `openInput` reject with this message. */
    inputOpenError?: string;
    /** Makes `openInput` throw synchronously, before returning a promise. */
    inputOpenThrows?: string;
    /** Omit `readScreen`, as `--no-layout` does, and report this display size. */
    displayOnly?: { width: number; height: number } | null;
    /** Override the input arbitration for this server. */
    inputMode?: ViewerInputMode;
    /** Product hooks under test. */
    hooks?: ViewerHooks;
    /** A page to serve instead of the built-in player. */
    page?: string;
  } = {},
): Promise<Harness> {
  const cast = new FakeCast();
  let screen = fakeScreen();
  let reads = 0;
  let shots = 0;
  let recordings = 0;
  let recordStops = 0;
  let recording = false;
  let releaseStop: (() => void) | null = null;
  let stopGate = over.holdStop ? new Promise<void>((r) => (releaseStop = r)) : null;
  const redactions: boolean[] = [];
  const lanes: FakeInputLane[] = [];
  let openInputs = 0;
  const server = await startViewerServer({
    port: 0,
    host: "127.0.0.1",
    privacy: over.privacy ?? true,
    graceMs: over.graceMs ?? 200,
    layoutMs: over.layoutMs ?? 30,
    ...(over.watchdogMs !== undefined ? { watchdogMs: over.watchdogMs } : {}),
    ...(over.hooks ? { hooks: over.hooks } : {}),
    ...(over.page ? { page: over.page } : {}),
    ...(over.inputMode
      ? {
          input: {
            mode: over.inputMode,
            open() {
              openInputs++;
              const lane = new FakeInputLane();
              lanes.push(lane);
              return Promise.resolve({
                lane,
                close: async () => {
                  lane.closed = true;
                },
              });
            },
          },
        }
      : {}),
    source: {
      async createCast() {
        return cast;
      },
      ...(over.displayOnly
        ? { async displaySize() { return over.displayOnly!; } }
        : {
            async readScreen(redact: boolean) {
              reads++;
              redactions.push(redact);
              return redact ? screen : { ...screen, elements: screen.elements.map(({ masked: _m, ...e }) => e) };
            },
          }),
      async capture() {
        if (over.captureError) throw new Error(over.captureError);
        shots++;
        return `/tmp/shot-${shots}.jpg`;
      },
      async startRecording() {
        recordings++;
        recording = true;
        return "/tmp/rec.mp4";
      },
      async stopRecording() {
        recordStops++;
        // A stop in flight is not a stop that happened: while the gate is up,
        // the recording is still active from the caller's point of view.
        if (stopGate) await stopGate;
        recording = false;
        return "/tmp/rec.mp4";
      },
      openInput() {
        openInputs++;
        // Not `async`: a synchronous throw is the case under test.
        if (over.inputOpenThrows) throw new Error(over.inputOpenThrows);
        if (over.inputOpenError) return Promise.reject(new Error(over.inputOpenError));
        const lane = new FakeInputLane();
        lanes.push(lane);
        const session: InputSession = {
          lane,
          close: async () => {
            lane.closed = true;
          },
        };
        return Promise.resolve(session);
      },
    },
  });
  running.push(server);
  return {
    server,
    cast,
    port: server.port,
    setScreen(s) {
      screen = s;
    },
    screenReads: () => reads,
    redactions: () => [...redactions],
    shots: () => shots,
    recordings: () => recordings,
    recordStops: () => recordStops,
    releaseStop: () => releaseStop?.(),
    lanes: () => lanes,
    openInputs: () => openInputs,
  };
}

interface Client {
  socket: Socket;
  texts: Record<string, unknown>[];
  binaries: Buffer[];
  /** The server answered with something other than 101. */
  refused: boolean;
  send(message: Record<string, unknown>): void;
  close(): void;
}

/** A minimal browser: handshake, then collect frames until `predicate` holds. */
async function connect(port: number, query = "", headers: Record<string, string> = {}): Promise<Client> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const texts: Record<string, unknown>[] = [];
  const binaries: Buffer[] = [];
  let buf: Buffer = Buffer.alloc(0);
  let upgraded = false;
  let refused = false;
  let onUpgrade: (() => void) | null = null;
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      if (!head.startsWith("HTTP/1.1 101")) {
        refused = true;
        upgraded = true;
        buf = Buffer.alloc(0);
        onUpgrade?.();
        onUpgrade = null;
        return;
      }
      upgraded = true;
      buf = buf.subarray(end + 4);
      onUpgrade?.();
      onUpgrade = null;
    }
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x1) texts.push(JSON.parse(f.payload.toString()) as Record<string, unknown>);
      else if (f.opcode === 0x2) binaries.push(Buffer.from(f.payload));
    }
  });
  // A browser does not consider itself connected until the 101 arrives; waiting
  // for it keeps "connect then push a frame" from racing the server's attach.
  const upgradedP = new Promise<void>((resolve) => (onUpgrade = resolve));
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  socket.write(
    buildHandshake(`127.0.0.1:${port}`)
      .replace("GET / HTTP/1.1", `GET /live${query} HTTP/1.1`)
      .replace("Upgrade: websocket\r\n", `Upgrade: websocket\r\n${extra}`),
  );
  await upgradedP;
  return {
    socket,
    texts,
    binaries,
    refused,
    send(message) {
      socket.write(encodeTextFrame(JSON.stringify(message)));
    },
    close() {
      socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      socket.destroy();
    },
  };
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    let raw = "";
    sock.on("data", (d) => (raw += d.toString("latin1")));
    sock.on("end", () => {
      const [head = "", ...rest] = raw.split("\r\n\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ status, body: rest.join("\r\n\r\n") });
    });
    sock.on("error", reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      resolve({ status: 0, body: raw });
    });
  });
}

/** Sends a raw upgrade request and returns the status line's code. */
async function upgradeStatus(port: number, request: string): Promise<number> {
  const sock = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  let raw = "";
  sock.on("data", (d) => (raw += d.toString("latin1")));
  sock.write(request);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    sock.once("close", done);
    sock.once("end", done);
  });
  sock.destroy();
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
}

describe("ViewerServer", () => {
  it("serves the player page", async () => {
    const h = await start();
    const res = await http(h.port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("VideoDecoder");
    expect(res.body).toContain("uitest live");
  });

  it("answers 404 for anything else", async () => {
    const h = await start();
    expect((await http(h.port, "/nope")).status).toBe(404);
  });

  it("sends hello with the codec, avcC and frame size once the format is known", async () => {
    const h = await start();
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => c.binaries.length > 0);
    // The greeting at attach cannot name a codec — nothing has arrived yet — so
    // the server greets again as soon as the first parameter sets do.
    const hellos = c.texts.filter((t) => t.type === "hello");
    expect(hellos.length).toBeGreaterThan(1);
    const hello = hellos[hellos.length - 1]!;
    expect(hello.codec).toBe("avc1.640028");
    expect(hello.state).toBe("live");
    const desc = Buffer.from(String(hello.description), "base64");
    expect(desc[0]).toBe(1); // avcC configurationVersion
    expect(hello.privacy).toBe(true);
    c.close();
  });

  it("forwards frames as flag byte + pts + AVCC", async () => {
    const h = await start();
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => c.binaries.length > 0);
    const frame = c.binaries[0]!;
    expect(frame[0]).toBe(1); // keyframe flag
    expect(frame.readUInt32BE(1)).toBe(1000);
    // AVCC: SPS, PPS and IDR, each length-prefixed.
    const body = frame.subarray(5);
    expect(body.readUInt32BE(0)).toBe(SPS.length);
    expect(body.subarray(4, 4 + SPS.length).equals(SPS)).toBe(true);
    const atPps = 4 + SPS.length;
    expect(body.readUInt32BE(atPps)).toBe(PPS.length);
    const atIdr = atPps + 4 + PPS.length;
    expect(body.readUInt32BE(atIdr)).toBe(IDR.length);
    expect(body.subarray(atIdr + 4).equals(IDR)).toBe(true);
    c.close();
  });

  it("does not send parameter sets as a decodable key frame", async () => {
    // The 6.8 extension opens a stream with a frame that carries only SPS and
    // PPS and marks it `isKeyFrame`. WebCodecs rejects such a chunk outright
    // ("marked as type key but wasn't a key frame"), so the flag the browser
    // sees must mean "carries an IDR slice", and a frame with no slice at all
    // must not be sent.
    const h = await start();
    const c = await connect(h.port);
    h.cast.push({ data: annexB(SPS, PPS), pts: 1, flags: 2, isKeyFrame: true });
    await until(() => c.texts.some((t) => t.type === "hello" && t.codec === `avc1.${SPS.subarray(1, 4).toString("hex")}`));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.binaries).toHaveLength(0);
    h.cast.push(keyframe());
    await until(() => c.binaries.length > 0);
    expect(c.binaries[0]![0]).toBe(1);
    c.close();
  });

  it("marks delta frames with a clear flag byte", async () => {
    const h = await start();
    const c = await connect(h.port);
    h.cast.push(keyframe());
    h.cast.push(delta(7));
    await until(() => c.binaries.length >= 2);
    expect(c.binaries[1]![0]).toBe(0);
    c.close();
  });

  it("pushes the node table as text, redacted by default", async () => {
    const h = await start();
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "nodes"));
    const nodes = c.texts.find((t) => t.type === "nodes")!;
    const list = nodes.nodes as { ref: number; label: string; masked?: boolean }[];
    expect(list).toHaveLength(2);
    expect(list[0]!.label).toBe("Save");
    expect(list[1]!.label).toBe("hunter2");
    expect(list[1]!.masked).toBe(true);
    expect(nodes.privacy).toBe(true);
    c.close();
  });

  it("asks the layout source for an unredacted view when privacy is off", async () => {
    // Masking is decided where the screen is built, not here: the server can
    // only report what it was given. So the flag has to travel down to the
    // source, and the honest report is the flag itself.
    const h = await start({ privacy: false });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "nodes"));
    const nodes = c.texts.find((t) => t.type === "nodes")!;
    expect(nodes.privacy).toBe(false);
    expect(h.redactions().every((r) => r === false)).toBe(true);
    const list = nodes.nodes as { label: string; masked?: boolean }[];
    expect(list[1]!.label).toBe("hunter2");
    expect(list[1]!.masked).toBeUndefined();
    c.close();
  });

  it("re-reads the layout when a page turns privacy off", async () => {
    const h = await start({ layoutMs: 1000 });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "nodes"));
    const before = h.screenReads();
    c.send({ type: "privacy", value: false });
    await until(() => h.redactions().includes(false), 2000);
    expect(h.screenReads()).toBeGreaterThan(before);
    // And the page is told what it is now looking at.
    await until(() => c.texts.some((t) => t.type === "privacy" && t.value === false), 2000);
    c.close();
  });

  it("masks again when a second page opens after one unmasked itself", async () => {
    // Two tabs share one screen model, so "unmasked" cannot be per tab: the
    // person who unmasked would leave the next person's tab showing passwords.
    // Masking wins unless every attached tab has opted out.
    const h = await start({ layoutMs: 1000 });
    const first = await connect(h.port);
    await until(() => first.texts.some((t) => t.type === "nodes"));
    first.send({ type: "privacy", value: false });
    await until(() => h.redactions().includes(false), 2000);

    const second = await connect(h.port);
    // The new tab starts masked, and the screen is re-read masked for both.
    await until(() => second.texts.some((t) => t.type === "nodes" && t.privacy === true), 2000);
    await until(() => h.redactions()[h.redactions().length - 1] === true, 2000);
    // The tab that asked for no masking is told it no longer has it.
    await until(() => first.texts.some((t) => t.type === "privacy" && t.value === true), 2000);
    first.close();
    second.close();
  });

  it("unmasks only once every attached page asks for it", async () => {
    const h = await start({ layoutMs: 1000 });
    const first = await connect(h.port);
    const second = await connect(h.port);
    await until(() => first.texts.some((t) => t.type === "nodes"), 2000);
    first.send({ type: "privacy", value: false });
    await new Promise((r) => setTimeout(r, 300));
    // One page still wants masking, so the shared model stays masked.
    expect(h.redactions().includes(false)).toBe(false);
    second.send({ type: "privacy", value: false });
    await until(() => h.redactions().includes(false), 2000);
    first.close();
    second.close();
  });

  it("drops frames and asks for an IDR when the client cannot keep up", async () => {
    const h = await start();
    const c = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => c.binaries.length > 0);
    // Attaching already asks for one keyframe; only a rise past that baseline
    // can prove the backpressure path ran.
    const before = h.cast.idrRequests;
    // Stop reading: the socket's write queue grows past the watermark.
    c.socket.pause();
    for (let i = 0; i < 40; i++) h.cast.push(delta(i, 100_000));
    await until(() => h.cast.idrRequests > before, 5000);
    expect(h.cast.idrRequests).toBeGreaterThan(before);
    c.socket.destroy();
  });

  it("keeps the cast through a short reconnect and stops it after the grace", async () => {
    const h = await start({ graceMs: 150 });
    const first = await connect(h.port);
    h.cast.push(keyframe());
    await until(() => first.binaries.length > 0);
    first.close();
    // A second tab attaches while the first one's grace has not expired.
    const second = await connect(h.port);
    h.cast.push(delta(3));
    await until(() => second.binaries.length > 0);
    expect(h.cast.disposed).toBe(false);
    second.close();
    await until(() => h.cast.disposed, 3000);
  });

  it("disposes a cast whose stream ended before it opens the replacement", async () => {
    // `dispose()` is what kills the device daemon. When the stream ended or
    // errored, the server dropped its reference and retried — but never
    // disposed the dead cast, so every stream loss left an orphaned cast
    // daemon on the phone. Each orphan competes for the encoder, and a
    // ten-minute acceptance run dropped from ~18 fps to 13 fps because of the
    // ones earlier runs had left behind.
    let made = 0;
    const casts: FakeCast[] = [];
    /** A cast whose stream returns on its own, as a dying daemon's would. */
    class EndingCast extends FakeCast {
      async *stream(): AsyncIterable<H264Chunk> {
        yield keyframe();
        // Ends without dispose(): the server must collect it.
      }
    }
    const server = await ViewerServer.start({
      port: 0,
      host: "127.0.0.1",
      graceMs: 200,
      layoutMs: 1000,
      source: {
        async createCast() {
          const cast = made === 0 ? new EndingCast() : new FakeCast();
          casts.push(cast);
          made++;
          return cast;
        },
        async readScreen() {
          return fakeScreen();
        },
      },
    });
    running.push(server);
    const c = await connect(server.port);
    await until(() => made === 2, 8000);
    // The server, not this test, must have handed the ended cast to dispose().
    expect(casts[0]!.disposed).toBe(true);
    expect(casts[1]!.disposed).toBe(false);
    c.close();
  });

  it("opens the replacement only after the dead cast has been disposed", async () => {
    // MJPEG's `dispose()` stops the shared agent's capture, so a replacement
    // opened while the old client is still winding down would be stopped by
    // its predecessor's disposal. The order is what makes the leak fix safe.
    const events: string[] = [];
    let made = 0;
    class SlowEndingCast extends FakeCast {
      async *stream(): AsyncIterable<H264Chunk> {
        yield keyframe();
      }
      async dispose(): Promise<void> {
        events.push("dispose:start");
        // Longer than the first retry backoff (500 ms): without the wait the
        // replacement opens before this finishes.
        await new Promise((r) => setTimeout(r, 900));
        events.push("dispose:end");
        this.disposed = true;
      }
    }
    const server = await ViewerServer.start({
      port: 0,
      host: "127.0.0.1",
      graceMs: 200,
      layoutMs: 1000,
      source: {
        async createCast() {
          events.push(`create:${made}`);
          const cast = made === 0 ? new SlowEndingCast() : new FakeCast();
          made++;
          return cast;
        },
        async readScreen() {
          return fakeScreen();
        },
      },
    });
    running.push(server);
    const c = await connect(server.port);
    await until(() => made === 2, 8000);
    expect(events).toEqual(["create:0", "dispose:start", "dispose:end", "create:1"]);
    c.close();
  });

  it("waits for a dead cast's disposal before it finishes closing", async () => {
    // The acceptance script exits the process right after `close()`. A cast
    // that died mid-run is disposed beside the retry, so `close()` has to wait
    // for that disposal too — otherwise the process exits before the device
    // daemon is killed, and the run leaves one behind (measured: every run
    // left exactly one cast daemon until this was awaited).
    let disposed = false;
    class SlowEndingCast extends FakeCast {
      async *stream(): AsyncIterable<H264Chunk> {
        yield keyframe();
      }
      async dispose(): Promise<void> {
        await new Promise((r) => setTimeout(r, 500));
        disposed = true;
        this.disposed = true;
      }
    }
    const server = await ViewerServer.start({
      port: 0,
      host: "127.0.0.1",
      graceMs: 200,
      layoutMs: 1000,
      source: {
        async createCast() {
          return new SlowEndingCast();
        },
        async readScreen() {
          return fakeScreen();
        },
      },
    });
    const c = await connect(server.port);
    // Wait until the stream has ended and its disposal is in flight.
    await new Promise((r) => setTimeout(r, 200));
    await server.close();
    expect(disposed).toBe(true);
    c.close();
  });

  it("reports its state in every hello", async () => {
    const h = await start();
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    // The greeting sent at attach cannot claim to be streaming yet.
    expect(c.texts.find((t) => t.type === "hello")!.state).toBe("starting");
    h.cast.push(keyframe());
    await until(() => c.texts.filter((t) => t.type === "hello").some((t) => t.state === "live"));
    expect(h.server.state).toBe("live");
    c.close();
  });

  it("serves an MJPEG source as JPEG frames, not as a broken H.264 stream", async () => {
    // x86_64 devices have no casting extension, so `createCast` hands back an
    // MJPEG client. Treating its JPEGs as NAL units would produce a page that
    // connects and never paints — the one failure mode a person cannot tell
    // from a broken phone.
    const cast = new FakeMjpegCast();
    const server = await ViewerServer.start({
      port: 0,
      host: "127.0.0.1",
      graceMs: 200,
      layoutMs: 1000,
      source: { async createCast() { return cast; }, async readScreen() { return fakeScreen(); } },
    });
    running.push(server);
    const c = await connect(server.port);
    cast.push({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), pts: 42 });
    await until(() => c.texts.some((t) => t.type === "hello" && t.codec === "mjpeg"));
    await until(() => c.binaries.length > 0);
    // Same envelope as H.264: a flag byte and a pts, then the picture.
    const frame = c.binaries[0]!;
    expect(frame[0]).toBe(1); // every JPEG is independently decodable
    expect(frame.readUInt32BE(1)).toBe(42);
    expect(frame.subarray(5).equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    c.close();
  });

  it("does not read the layout on every frame", async () => {
    const h = await start({ layoutMs: 1000 });
    const c = await connect(h.port);
    for (let i = 0; i < 50; i++) h.cast.push(delta(i));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.screenReads()).toBeLessThan(5);
    c.close();
  });
});

describe("ViewerServer: capture and record", () => {
  it("saves a screenshot and tells every tab where it went", async () => {
    const h = await start();
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    c.send({ type: "shot" });
    await until(() => c.texts.some((t) => t.type === "saved"));
    const saved = c.texts.find((t) => t.type === "saved")!;
    expect(saved.path).toBe("/tmp/shot-1.jpg");
    expect(h.shots()).toBe(1);
    c.close();
  });

  it("reports a capture failure to the tab that asked", async () => {
    const h = await start({ captureError: "device_locked" });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    c.send({ type: "shot" });
    await until(() => c.texts.some((t) => t.type === "saved" && t.error));
    expect(c.texts.find((t) => t.type === "saved")!.error).toBe("device_locked");
    c.close();
  });

  it("starts and stops a recording, and reports the finished file", async () => {
    const h = await start();
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));

    c.send({ type: "record", action: "start" });
    await until(() => c.texts.some((t) => t.type === "record" && t.recording === true));
    expect(h.recordings()).toBe(1);

    c.send({ type: "record", action: "stop" });
    await until(() => c.texts.some((t) => t.type === "saved" && t.path === "/tmp/rec.mp4"));
    c.close();
  });

  it("refuses a second recording while one is running", async () => {
    const h = await start();
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));

    c.send({ type: "record", action: "start" });
    await until(() => c.texts.some((t) => t.type === "record" && t.recording === true));

    c.send({ type: "record", action: "start" });
    await until(() => c.texts.some((t) => t.type === "record" && t.error));
    expect(c.texts.filter((t) => t.type === "record" && t.recording === true)).toHaveLength(1);
    c.close();
  });

  it("does not stop a recording twice when close lands mid-stop", async () => {
    const h = await start({ holdStop: true });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    c.send({ type: "record", action: "start" });
    await until(() => c.texts.some((t) => t.type === "record" && t.recording === true));

    c.send({ type: "record", action: "stop" });
    await until(() => h.recordStops() === 1);
    // The stop is still in flight — on a device that is an `onEnd` plus a pull
    // of the MP4. Closing now must not issue a second one. `close()` waits for
    // the in-flight stop, so it is not awaited until the gate opens.
    const closing = h.server.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.recordStops()).toBe(1);

    h.releaseStop();
    await closing;
    c.close();
  });

  it("stops a recording when the server closes", async () => {
    const h = await start();
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    c.send({ type: "record", action: "start" });
    await until(() => c.texts.some((t) => t.type === "record" && t.recording === true));

    await h.server.close();
    // A recording left running would keep the device encoder busy with no one
    // to collect the file.
    expect(h.recordStops()).toBe(1);
  });
});

describe("ViewerServer: takeover", () => {
  it("lets one tab take control and tells every tab", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    await until(() => a.texts.some((t) => t.type === "hello"));
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    await until(() => b.texts.some((t) => t.type === "control" && t.state === "controlled"));
    const hello = a.texts.find((t) => t.type === "hello")!;
    const ctrl = a.texts.find((t) => t.type === "control" && t.state === "controlled")!;
    expect(ctrl.clientId).toBe(hello.clientId);
    expect(hello.clientId).toBeTypeOf("string");
    // The greeting was sent at attach, before this tab took control.
    expect(hello.control).toEqual({ state: "readonly" });
  });

  it("refuses a second takeover while one tab controls", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    b.send({ type: "control", action: "take" });
    await until(() => b.texts.some((t) => t.type === "control" && t.reason === "busy"));
    // b receives the controlled broadcast — every tab has to know — but it is
    // never the tab named as the controller.
    const helloB = b.texts.find((t) => t.type === "hello")!;
    expect(
      b.texts.some(
        (t) => t.type === "control" && t.state === "controlled" && t.clientId === helloB.clientId,
      ),
    ).toBe(false);
  });

  it("keeps the controlling tab in control when it asks again", async () => {
    // A double-click on 接管, or a second click while the first take is still
    // opening, sends `take` again from the tab that already controls. Answering
    // `busy` there told that tab it was read-only, and the page believes every
    // control message: it cleared its own control and the server kept it as the
    // controller, so every later take from every tab got `busy` and the device
    // could not be operated until the tab was closed.
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "control", action: "take" });
    await new Promise((r) => setTimeout(r, 300));
    const mine = a.texts.filter(
      (t) => t.type === "control" && t.state === "controlled" && t.clientId !== undefined,
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(a.texts.some((t) => t.type === "control" && t.reason === "busy")).toBe(false);
    // And it can still drive the device.
    const lane = h.lanes()[0]!;
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    a.send({ type: "input", action: "up", x: 10, y: 20 });
    await until(() => lane.ops("touchUp").length === 1);
  });

  it("does not tell a tab it is read-only while its own take is opening", async () => {
    // The 接管 button is not disabled during the round trip, so a double-click
    // sends two takes from the same tab before the first answers. The second
    // used to be refused as `busy`, which the page shows as "另一个页面正在操作"
    // and which clears its control state until the real answer arrives.
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    await new Promise((r) => setTimeout(r, 200));
    expect(a.texts.some((t) => t.type === "control" && t.reason === "busy")).toBe(false);
  });

  it("arbitrates two take requests sent in the same tick", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    b.send({ type: "control", action: "take" });
    const all = () => [...a.texts, ...b.texts];
    await until(() => all().some((t) => t.type === "control" && t.reason === "busy"));
    await until(() => all().some((t) => t.type === "control" && t.state === "controlled"));
    const controlled = all().filter((t) => t.type === "control" && t.state === "controlled");
    expect(new Set(controlled.map((t) => t.clientId)).size).toBe(1);
    expect(all().filter((t) => t.type === "control" && t.reason === "busy")).toHaveLength(1);
  });

  it("refuses takeover when the input lane cannot open", async () => {
    const h = await start({ inputOpenError: "no free port" });
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.reason === "error"));
    expect(a.texts.some((t) => t.type === "control" && t.state === "controlled")).toBe(false);
  });

  it("retries the lane when opening throws before it returns a promise", async () => {
    // `openInput` is a caller-supplied function. One that throws synchronously
    // — a missing extension name, a bad path — used to leave the shared
    // "opening" promise holding the rejection: the finally that clears it had
    // already run, so the field was assigned afterwards and never reset. Every
    // later takeover returned that same rejected promise, and the lane could
    // not be opened again for the life of the process.
    const h = await start({ inputOpenThrows: "no extension named agent.so" });
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.reason === "error"));
    expect(h.openInputs()).toBe(1);

    // Past the five-second cooldown, a second attempt must reach the source.
    await sleep(5100);
    a.send({ type: "control", action: "take" });
    await until(() => h.openInputs() === 2, 4000);
    expect(h.openInputs()).toBe(2);
  }, 15_000);

  it("advertises the display size and clamps input against it without layout", async () => {
    // `--no-layout` is the documented emulator workflow: the emulator has no
    // H.264 extension, so its cast is MJPEG at half size. With no `readScreen`
    // the greeting said 0x0, the page converted clicks against the 608-wide
    // frame instead of the 1216-wide display, and every tap landed in the
    // top-left quadrant — while the picture and the ripple looked right.
    const h = await start({ displayOnly: { width: 400, height: 800 } });
    const a = await connect(h.port);
    await until(() => a.texts.some((t) => t.type === "hello"));
    const hello = a.texts.find((t) => t.type === "hello")!;
    expect([hello.width, hello.height]).toEqual([400, 800]);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 9000, y: 9000 });
    a.send({ type: "input", action: "up", x: 9000, y: 9000 });
    const lane = h.lanes()[0]!;
    await until(() => lane.ops("touchUp").length === 1);
    expect(lane.ops("touchDown")).toEqual([[399, 799]]);
  });

  it("routes pointer, key, text and matrix input from the controller", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    a.send({ type: "input", action: "move", x: 11, y: 21 });
    a.send({ type: "input", action: "up", x: 11, y: 21 });
    a.send({ type: "input", action: "key", key: "back" });
    a.send({ type: "input", action: "text", text: "abc", x: 5, y: 6 });
    a.send({ type: "input", action: "pinch", cx: 100, cy: 200, half: 60 });
    a.send({ type: "input", action: "wheel", x: 10, y: 20, dy: 100 });
    const lane = h.lanes()[0]!;
    await until(() => lane.ops("scroll").length === 1);
    expect(lane.ops("touchDown")).toEqual([[10, 20]]);
    expect(lane.ops("touchMove")).toEqual([[11, 21]]);
    expect(lane.ops("touchUp")).toEqual([[11, 21]]);
    expect(lane.ops("key")).toEqual([[2]]);
    expect(lane.ops("text")).toEqual([[5, 6, "abc", "typing"]]);
    expect(lane.ops("pinch")).toEqual([]); // first pinch is the baseline
    expect(lane.ops("scroll")).toEqual([[10, 20, true, 1]]);
  });

  it("ignores input from a tab that does not control", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    b.send({ type: "input", action: "down", x: 1, y: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.lanes()[0]!.ops("touchDown")).toEqual([]);
  });

  it("releases control and lifts the pointer when the controller disconnects", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]!.ops("touchDown").length === 1);
    a.close();
    await until(() => b.texts.some((t) => t.type === "control" && t.state === "readonly"));
    expect(h.lanes()[0]!.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("returns to read-only when the input lane fails", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    h.lanes()[0]!.fail = true;
    a.send({ type: "input", action: "down", x: 1, y: 1 });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "readonly" && t.reason === "error"));
  });

  it("re-opens the input lane on the next takeover", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    h.lanes()[0]!.fail = true;
    a.send({ type: "input", action: "down", x: 1, y: 1 });
    await until(() => a.texts.some((t) => t.type === "control" && t.reason === "error"));
    // The failed lane is retried after a short backoff.
    await new Promise((r) => setTimeout(r, 520));
    a.send({ type: "control", action: "take" });
    await until(() => h.openInputs() === 2);
    await until(() => a.texts.filter((t) => t.type === "control" && t.state === "controlled").length >= 2);
  });

  it("lifts a held pointer after the watchdog timeout", async () => {
    const h = await start({ watchdogMs: 40 });
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]!.ops("touchUp").length === 1);
  });

  it("cancels and closes the input lane when the server closes", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]!.ops("touchDown").length === 1);
    await h.server.close();
    expect(h.lanes()[0]!.ops("touchUp").length).toBeGreaterThan(0);
    expect(h.lanes()[0]!.closed).toBe(true);
  });

  // ---- Origin and control authority -------------------------------------
  //
  // A WebSocket ignores the same-origin policy, so without these checks any
  // page the person happens to have open can open a socket to the fixed port,
  // take control, and drive the phone. Each test below is one step of that
  // attack, asserted to fail.

  it("refuses a WebSocket from another site's origin", async () => {
    const h = await start();
    const c = await connect(h.port, "", { Origin: "https://evil.example" });
    expect(c.refused).toBe(true);
    expect(c.texts).toEqual([]);
    c.socket.destroy();
  });

  it("refuses a null origin, which is a sandboxed frame or a file:// page", async () => {
    const h = await start();
    const c = await connect(h.port, "", { Origin: "null" });
    expect(c.refused).toBe(true);
    c.socket.destroy();
  });

  it("accepts the page's own origin", async () => {
    const h = await start();
    const c = await connect(h.port, "", { Origin: `http://127.0.0.1:${h.port}` });
    expect(c.refused).toBe(false);
    await until(() => c.texts.some((t) => t.type === "hello"));
    c.close();
  });

  it("refuses a same-origin request made under a domain name", async () => {
    // DNS rebinding: the attacker's domain resolves to 127.0.0.1, so Host and
    // Origin agree on a name this server was never reachable under.
    const h = await start();
    const c = await connect(h.port, "", {
      Host: `attacker.example:${h.port}`,
      Origin: `http://attacker.example:${h.port}`,
    });
    expect(c.refused).toBe(true);
    c.socket.destroy();
  });

  it("refuses a takeover from a page that was not served by this server", async () => {
    // The end-to-end shape of the attack: a visited site opens the socket and
    // asks for control. The handshake is refused, so nothing it sends — a
    // takeover, a gesture — can reach the device. The write lane is opened at
    // startup, so "no lane" is not the signal; "nothing on it" is.
    const h = await start();
    const a = await connect(h.port, "", { Origin: "https://evil.example" });
    expect(a.refused).toBe(true);
    a.send({ type: "control", action: "take" });
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await sleep(200);
    expect(a.texts).toEqual([]);
    expect(h.lanes().flatMap((l) => l.calls)).toEqual([]);
    a.socket.destroy();
  });
});
describe("ViewerServer: features, hooks and page", () => {
  it("advertises what the source can do and hides the rest", async () => {
    const h = await start({ displayOnly: { width: 400, height: 800 } });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    const hello = c.texts.find((t) => t.type === "hello")!;
    expect(hello.canInspect).toBe(false);
    expect(hello.canInput).toBe(true);
    expect(hello.mode).toBe("takeover");
    c.close();
  });

  it("lets a product handle its own message types", async () => {
    const seen: string[] = [];
    const h = await start({
      hooks: {
        onMessage: (_c, m) => {
          if (m.type === "console:list") {
            seen.push("list");
            return true;
          }
          return false;
        },
      },
    });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    c.send({ type: "console:list" });
    await until(() => seen.length === 1);
    expect(seen).toEqual(["list"]);
    c.close();
  });

  it("tells a product when a tab arrives and leaves", async () => {
    const events: string[] = [];
    const h = await start({
      hooks: {
        onClient: (c) => events.push(`join:${c.id}`),
        onClientGone: (id) => events.push(`gone:${id}`),
      },
    });
    const c = await connect(h.port);
    await until(() => events.length === 1);
    const id = c.texts.find((t) => t.type === "hello")?.clientId;
    c.close();
    await until(() => events.length === 2);
    expect(events[0]).toBe(`join:${id}`);
    expect(events[1]).toBe(`gone:${id}`);
  });

  it("accepts input from every tab in always mode", async () => {
    const h = await start({ inputMode: "always" });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    expect(c.texts.find((t) => t.type === "hello")?.mode).toBe("always");
    c.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]?.ops("touchDown").length === 1);
    c.send({ type: "input", action: "up", x: 10, y: 20 });
    c.close();
  });

  it("sends no input and offers no control in off mode", async () => {
    const h = await start({ inputMode: "off" });
    const c = await connect(h.port);
    await until(() => c.texts.some((t) => t.type === "hello"));
    const hello = c.texts.find((t) => t.type === "hello")!;
    expect(hello.canInput).toBe(false);
    expect(hello.mode).toBe("off");
    c.send({ type: "input", action: "down", x: 10, y: 20 });
    await sleep(150);
    expect(h.openInputs()).toBe(0);
    expect(h.lanes()).toEqual([]);
    c.close();
  });

  it("refuses an upgrade without Sec-WebSocket-Key with 400", async () => {
    const h = await start();
    const status = await upgradeStatus(
      h.port,
      "GET /live HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${h.port}\r\n` +
        "Origin: http://127.0.0.1:" + h.port + "\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    expect(status).toBe(400);
  });

  it("refuses an upgrade to the wrong path with 404", async () => {
    const h = await start();
    const status = await upgradeStatus(
      h.port,
      "GET /nope HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${h.port}\r\n` +
        "Origin: http://127.0.0.1:" + h.port + "\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + Buffer.alloc(16, 7).toString("base64") + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    expect(status).toBe(404);
  });

  it("serves an injected page and escapes the title", async () => {
    const h = await start({
      page: renderPlayerPage({
        title: "<b>x</b>",
        extraHtml: '<div id="inbox"></div>',
        extraScript: "window.uitestViewer.on('hello', function () {});",
      }),
    });
    const res = await http(h.port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(res.body).toContain('id="inbox"');
    expect(res.body).toContain("window.uitestViewer.on");
    // The built-in page is still the document around the extension.
    expect(res.body).toContain("VideoDecoder");
  });
});
