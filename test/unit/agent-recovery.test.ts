import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { AgentClient } from "../../src/agent/client.js";
import { AgentBusyError, AgentConnectionError } from "../../src/transport/errors.js";

const JPEG = (b: number) => Buffer.concat([Buffer.from([0xff, 0xd8, b]), Buffer.from([0xff, 0xd9])]);

let server: net.Server;
let client: AgentClient | undefined;
let received: any[] = [];
/** Per-test reply script; tests override it before connecting. */
let onRequest: (req: any, sock: net.Socket) => void = (_r, s) => s.write('{"result":true}\n');

beforeEach(async () => {
  received = [];
  onRequest = (_req, sock) => sock.write('{"result":true}\n');
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let i;
      while ((i = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        const req = JSON.parse(line);
        received.push(req);
        onRequest(req, sock);
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await new Promise<void>((r) => server.close(() => r()));
});

async function connect(opts: ConstructorParameters<typeof AgentClient>[1] = {}): Promise<AgentClient> {
  const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", r));
  client = new AgentClient(sock, opts);
  return client;
}

/** Replies to the capture start with one frame, then goes silent. */
function oneFrameServer(): void {
  onRequest = (req, sock) => {
    if (req.params.api === "startCaptureScreen") {
      sock.write('{"result":true}\n');
      sock.write(JPEG(1));
    } else {
      sock.write('{"result":true}\n');
    }
  };
}

async function settled(p: Promise<unknown>, ms = 500): Promise<string> {
  return Promise.race([
    p.then(() => "settled", () => "settled"),
    new Promise<string>((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

describe("captureScreen failure paths", () => {
  it("leaves no orphan rejection when the capture start fails", async () => {
    onRequest = (req, sock) => {
      const api = req.params.api;
      sock.write(
        api === "startCaptureScreen"
          ? '{"result":null,"exception":"Capture already running: copyScreen"}\n'
          : '{"result":true}\n',
      );
    };
    const c = await connect({ requestTimeoutMs: 150 });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(c.captureScreen()).rejects.toThrow(AgentBusyError);
      // The abandoned first-frame timer would fire somewhere in this window.
      await new Promise((r) => setTimeout(r, 400));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects promptly instead of waiting out the timeout when the connection drops", async () => {
    onRequest = (req, sock) => {
      if (req.params.api === "startCaptureScreen") {
        sock.write('{"result":true}\n');
        setTimeout(() => sock.destroy(), 30); // daemon dies before any frame
      } else {
        sock.write('{"result":true}\n');
      }
    };
    const c = await connect({ requestTimeoutMs: 3000 });
    const t0 = Date.now();
    await expect(c.captureScreen()).rejects.toThrow(AgentConnectionError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("stream teardown", () => {
  it("close() ends a consumer parked waiting for a frame", async () => {
    oneFrameServer();
    const c = await connect({ requestTimeoutMs: 2000 });
    const it = c.streamScreen()[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    const parked = it.next();
    c.close();
    expect(await settled(parked)).toBe("settled");
  });

  it("stopStream() ends a consumer parked waiting for a frame", async () => {
    oneFrameServer();
    const c = await connect({ requestTimeoutMs: 2000 });
    const it = c.streamScreen()[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    const parked = it.next();
    await c.stopStream();
    expect(await settled(parked)).toBe("settled");
  });
});

describe("request timeout", () => {
  it("discards the connection so a late reply cannot be mispaired", async () => {
    onRequest = (req, sock) => {
      if (req.params.api === "slow") {
        // Reply long after the client gave up on it.
        setTimeout(() => {
          try {
            sock.write('{"result":"stale"}\n');
          } catch {
            /* socket already gone */
          }
        }, 120);
        return;
      }
      sock.write('{"result":"fresh"}\n');
    };
    const c = await connect({ requestTimeoutMs: 60 });
    await expect(c.call("CtrlCmd", { api: "slow", args: [] })).rejects.toThrow(/timeout/);
    await new Promise((r) => setTimeout(r, 150));
    // The stale reply must not be handed to this request.
    await expect(c.call("CtrlCmd", { api: "second", args: [] })).rejects.toThrow(
      AgentConnectionError,
    );
  });
});
