import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { buildHandshake, decodeFrames } from "uitest-sdk/cast";
import { startMirror } from "../../src/cli.js";
import type { MirrorOptions } from "../../src/cli.js";

/** A port nothing is listening on, for tests that care which one was used. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const OPTIONS: MirrorOptions = {
  transport: "grpc",
  frameRate: 30,
  control: true,
  stayAwake: false,
  windowTitle: "uitest-mirror",
  port: 0,
  stateDir: "/tmp/mirror-test",
};

/**
 * A session shaped like the one `connect()` returns, down to the parts
 * `createViewerSource` and the server touch. Anything else would be a fake of
 * a fake: the point of this test is that the product wires the real server.
 */
function fakeSession(over: { recordStarted?: string[] } = {}) {
  const casts: unknown[] = [];
  const restored: string[] = [];
  const closed: string[] = [];
  const device = {
    deviceId: "FAKE1234",
    abi: "arm64" as const,
    agent: {
      async getDisplaySize() {
        return { width: 1260, height: 2720 };
      },
    },
    hdc: {
      async shell() {
        return "";
      },
      async fportAdd() {
        return 0;
      },
      async fportRemove() {
        return undefined;
      },
    },
    hypium: {
      async setSleepTime() {
        return undefined;
      },
      async restoreSleepTime() {
        restored.push("restore");
      },
    },
    resolveCastExtension() {
      return "/tmp/fake.z.so";
    },
  };
  const session = {
    device,
    core: {
      async read() {
        throw new Error("mirror must not read the layout");
      },
      reader: { builder: { setRedact() {} }, async read() { return { elements: [] }; } },
    },
    tag: "fake1234",
    async keepAwake() {
      return {
        async restore() {
          restored.push("restore");
        },
      };
    },
    async close() {
      closed.push("close");
    },
  };
  return { session, casts, restored, sessionClosed: () => closed.length > 0 };
}

/**
 * The first `hello` a fresh tab receives, which is where the server states its
 * capabilities.
 *
 * A raw socket rather than the `WebSocket` global: that global only exists from
 * Node 21, and this package supports Node 20 — the same suite that passed here
 * on 26 failed in CI on 20 with `WebSocket is not defined`. Core exports the
 * handshake and the frame decoder for exactly this.
 */
async function firstHello(port: number): Promise<Record<string, unknown>> {
  const socket = createConnection({ host: "127.0.0.1", port });
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("socket closed before hello")));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) {
          reject(new Error(`upgrade refused: ${head.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const frame of frames) {
        if (frame.opcode !== 0x1) continue;
        const msg = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        if (msg.type !== "hello") continue;
        socket.destroy();
        resolve(msg);
        return;
      }
    });
    socket.once("connect", () => {
      socket.write(buildHandshake(`127.0.0.1:${port}`).replace("GET / HTTP/1.1", "GET /live HTTP/1.1"));
    });
  });
}

describe("startMirror", () => {
  it("serves a mirror with inspect, capture and privacy off", async () => {
    const fake = fakeSession();
    const run = await startMirror(
      OPTIONS,
      async () => fake.session as never,
      () => ({ opened: true }),
    );
    // The page ships every control and the server tells it what to hide, so
    // the contract is in `hello`, not in the HTML.
    const hello = await firstHello(run.port);
    expect(hello.canInspect).toBe(false);
    expect(hello.canShot).toBe(false);
    expect(hello.canPrivacy).toBe(false);
    expect(hello.canRecord).toBe(true);
    await run.close();
  });

  it("turns input off with --no-control", async () => {
    const fake = fakeSession();
    const run = await startMirror(
      { ...OPTIONS, control: false },
      async () => fake.session as never,
      () => ({ opened: true }),
    );
    const hello = await firstHello(run.port);
    expect(hello.mode).toBe("off");
    expect(hello.canInput).toBe(false);
    await run.close();
  });

  it("opens the window at the device's aspect ratio", async () => {
    const sizes: Array<string | undefined> = [];
    const fake = fakeSession();
    const run = await startMirror(
      OPTIONS,
      async () => fake.session as never,
      (_url, opts) => {
        sizes.push(opts?.size);
        return { opened: true };
      },
    );
    expect(sizes).toEqual(["400,900"]);
    await run.close();
  });

  it("keeps the screen awake only when asked, and restores on close", async () => {
    const off = fakeSession();
    const quiet = await startMirror({ ...OPTIONS, stayAwake: false }, async () => off.session as never, () => ({ opened: true }));
    await quiet.close();
    expect(off.restored).toEqual([]);

    const on = fakeSession();
    const run = await startMirror({ ...OPTIONS, stayAwake: true }, async () => on.session as never, () => ({ opened: true }));
    await run.close();
    expect(on.restored).toEqual(["restore"]);
  });

  /**
   * `--window-title` was parsed, defaulted, documented and unit-tested, and
   * then never passed to the page: the window kept the built-in "uitest live".
   */
  it("serves the page under the title the person asked for", async () => {
    const fake = fakeSession();
    const run = await startMirror(
      { ...OPTIONS, windowTitle: "Pixel 9 · bench" },
      async () => fake.session as never,
      () => ({ opened: true }),
    );
    const res = await fetch(run.url);
    const html = await res.text();
    expect(html).toContain("<title>Pixel 9 · bench</title>");
    expect(html).not.toContain("<title>uitest live</title>");
    await run.close();
  });

  /**
   * The README says the lease is released when the window closes, and the
   * whole point of the lease is that a person who thinks they are done with
   * the phone is done. The window is a detached child, so the product has to
   * be told when it exits.
   */
  it("reports the window's close so the command can stop", async () => {
    let onClose: (() => void) | undefined;
    let profile: boolean | undefined;
    const fake = fakeSession();
    const run = await startMirror(
      OPTIONS,
      async () => fake.session as never,
      (_url, opts) => {
        onClose = (opts as { onClose?: () => void }).onClose;
        profile = (opts as { profile?: boolean }).profile;
        return { opened: true };
      },
    );
    // Without a profile of its own the browser joins the running one and the
    // launcher exits at once — which the product reads as "the window closed".
    expect(profile).toBe(true);
    expect(onClose).toBeTypeOf("function");
    let stopped = false;
    void run.windowClosed.then(() => (stopped = true));
    onClose!();
    await run.windowClosed;
    expect(stopped).toBe(true);
    await run.close();
  });

  /**
   * Ctrl+C and a closed stdin stop the mirror without the window going away.
   * Leaving the window behind shows a page whose server is gone.
   */
  it("closes the window it opened when the product stops", async () => {
    let closedWindow = 0;
    const fake = fakeSession();
    const run = await startMirror(
      OPTIONS,
      async () => fake.session as never,
      () => ({ opened: true, close: () => (closedWindow += 1) }),
    );
    await run.close();
    expect(closedWindow).toBe(1);
  });

  /**
   * A failure after the server is listening (a busy agent on the display-size
   * read) used to close the session and leave the viewer server, its cast
   * daemon and its fport running for a command that had already failed.
   */
  it("closes the viewer server when startup fails after it started", async () => {
    const fake = fakeSession();
    const device = fake.session.device as { agent: { getDisplaySize(): Promise<unknown> } };
    device.agent.getDisplaySize = async () => {
      throw new Error("agent busy");
    };
    // A fixed port makes the leak observable: if the server was left behind,
    // it still holds the port, and nothing else can bind it.
    const port = await freePort();
    await expect(
      startMirror({ ...OPTIONS, port }, async () => fake.session as never, () => ({ opened: true })),
    ).rejects.toThrow(/agent busy/);
    expect(fake.sessionClosed()).toBe(true);
    // Binding the same port proves the abandoned server is gone.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
