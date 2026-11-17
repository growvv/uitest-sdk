import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnection } from "node:net";

/**
 * `startLive` is the wiring between the device layer and the live server: open
 * the device, take a session (the lease), build the source, start the server.
 * Nothing else tests it — the server tests drive a fake source, and the option
 * tests stop at parsing — so a mistake here is a `live` command that leaks a
 * device lease or leaves the phone held after Ctrl-C.
 *
 * The device and session are mocked because the point is the wiring, not hdc.
 * The server is real: its port, its refusal behaviour and its close path are
 * exactly what the returned `url` and `close()` have to be right about.
 */

const calls: string[] = [];
let sessionOpenError: Error | null = null;
let serverStartError: Error | null = null;

vi.mock("../../src/driver/device.js", () => {
  class FakeDevice {
    static async connect(_opts: unknown) {
      calls.push("connect");
      return new FakeDevice();
    }
    agent = {
      async getDisplaySize() {
        calls.push("getDisplaySize");
        return { width: 1080, height: 2340 };
      },
    };
    async createCast(_opts: unknown) {
      calls.push("createCast");
      // A stream that never yields and never ends: the point here is the
      // wiring, not frame relay, and a cast that finished would make the
      // server start retrying it.
      return {
        castKind: "h264" as const,
        async *stream() {
          await new Promise(() => undefined);
        },
        async requestIDRFrame() {},
        async dispose() {
          calls.push("cast.dispose");
        },
      };
    }
    openInputLane() {
      calls.push("openInputLane");
      const noop = async () => undefined;
      return Promise.resolve({
        lane: {
          click: noop,
          touchDown: noop,
          touchMove: noop,
          touchUp: noop,
          key: noop,
          text: noop,
          pinch: noop,
          scroll: noop,
        },
        close: noop,
      });
    }
    async dispose() {
      calls.push("device.dispose");
    }
  }
  return { Device: FakeDevice };
});

vi.mock("../../src/session.js", () => {
  class FakeSession {
    static async open(_device: unknown, opts: { task: string }) {
      calls.push(`session.open:${opts.task}`);
      if (sessionOpenError) throw sessionOpenError;
      return new FakeSession();
    }
    reader = {
      builder: { setRedact: (_v: boolean) => undefined },
      read: async () => {
        calls.push("session.reader.read");
        return { width: 1080, height: 2340, elements: [] };
      },
    };
    async observe(_opts: { out: string }) {
      calls.push("session.observe");
    }
    async release() {
      calls.push("session.release");
    }
  }
  return { Session: FakeSession };
});

const { startLive } = await import("../../src/live/cli.js");
const { LiveServer } = await import("../../src/live/server.js");

function options(over: Partial<Parameters<typeof startLive>[1]> = {}) {
  return {
    httpPort: 0,
    host: "127.0.0.1",
    privacy: true,
    open: false,
    layout: true,
    cast: { scale: 1 as const, frameRate: 30 as const },
    ...over,
  };
}

const opened: { close(): Promise<void> }[] = [];
const sockets: import("node:net").Socket[] = [];

/** Opens the live page's socket; the layout poll only runs with a tab attached. */
async function attach(port: number): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (d) => {
      if (d.toString("latin1").startsWith("HTTP/1.1 101")) resolve();
    });
    socket.once("error", reject);
    socket.write(
      "GET /live HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString("base64")}\r\n` +
        "Sec-WebSocket-Version: 13\r\n" +
        `Origin: http://127.0.0.1:${port}\r\n\r\n`,
    );
  });
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const run of opened.splice(0)) await run.close().catch(() => undefined);
});

beforeEach(() => {
  calls.length = 0;
  sessionOpenError = null;
  serverStartError = null;
});

describe("startLive", () => {
  it("opens the device, takes the lease, and serves on the port it got", async () => {
    const run = await startLive({}, options());
    opened.push(run);
    expect(run.server).toBeInstanceOf(LiveServer);
    expect(run.server.port).toBeGreaterThan(0);
    expect(run.url).toBe(`http://127.0.0.1:${run.server.port}/`);
    expect(run.server.state).not.toBe("stopped");
    // The order matters: the lease is taken before anything is served, so a
    // page never appears for a device this process does not own.
    expect(calls.slice(0, 2)).toEqual(["connect", "session.open:live"]);
  });

  it("names the session `live`, so the lease is attributed in `doctor`", async () => {
    const run = await startLive({}, options());
    opened.push(run);
    expect(calls).toContain("session.open:live");
  });

  it("uses the task it was given instead of the default", async () => {
    const run = await startLive({}, options(), { task: "inspect" });
    opened.push(run);
    expect(calls).toContain("session.open:inspect");
  });

  it("releases the device when the session cannot be opened", async () => {
    sessionOpenError = new Error("another task holds the lease");
    await expect(startLive({}, options())).rejects.toThrow("another task holds the lease");
    // No lease was taken, so nothing to release — but the hdc client the device
    // opened has to go, or the process exits with a child still attached.
    expect(calls).toContain("device.dispose");
    expect(calls).not.toContain("session.release");
  });

  it("releases the lease and the device when the server cannot start", async () => {
    // A port already in use is the everyday case: the person ran `live` twice.
    const first = await startLive({}, options());
    opened.push(first);
    await expect(
      startLive({}, options({ httpPort: first.server.port })),
    ).rejects.toThrow();
    expect(calls).toContain("session.release");
    expect(calls).toContain("device.dispose");
  });

  it("closes the server before it lets go of the device", async () => {
    // A page still connected to a released lease is a page whose next click
    // fails; the sockets have to be down first.
    const run = await startLive({}, options());
    calls.length = 0;
    await run.close();
    expect(calls).toEqual(["session.release", "device.dispose"]);
    expect(run.server.state).toBe("stopped");
  });

  it("reports the loopback address for a wildcard bind", async () => {
    // `--host 0.0.0.0` means "reachable from elsewhere", but 0.0.0.0 is not a
    // URL a browser can open: the printed address has to be one it can dial.
    const v4 = await startLive({}, options({ host: "0.0.0.0" }));
    opened.push(v4);
    expect(v4.url).toBe(`http://127.0.0.1:${v4.server.port}/`);

    const v6 = await startLive({}, options({ host: "::" }));
    opened.push(v6);
    expect(v6.url).toBe(`http://127.0.0.1:${v6.server.port}/`);
  });

  it("prints the host it was given when it is not a wildcard", async () => {
    const run = await startLive({}, options({ host: "127.0.0.1" }));
    opened.push(run);
    expect(run.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("serves the page even with the layout off", async () => {
    // `--no-layout` is video only, but the display size still has to be there:
    // without it every click would be converted against a frame that may be
    // half size (`--scale 2`). A layout read is what must not happen.
    const run = await startLive({}, options({ layout: false }));
    opened.push(run);
    await attach(run.server.port);
    await new Promise((r) => setTimeout(r, 300));
    expect(run.server.state).not.toBe("stopped");
    expect(calls).not.toContain("session.reader.read");
    // The greeting still carries a display size, from the agent call rather
    // than from a layout read.
    expect(calls).toContain("getDisplaySize");
  });

  it("reads the layout when the layout is on", async () => {
    const run = await startLive({}, options({ layout: true }));
    opened.push(run);
    await attach(run.server.port);
    await until(() => calls.includes("session.reader.read"));
  });
});
