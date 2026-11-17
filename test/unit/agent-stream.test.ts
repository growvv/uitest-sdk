import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { AgentClient } from "../../src/driver/agent/client.js";

const JPEG = (b: number) => Buffer.concat([Buffer.from([0xff, 0xd8, b]), Buffer.from([0xff, 0xd9])]);
let server: net.Server, client: AgentClient, received: any[] = [];
let replyFn: (req: any) => string | Buffer = () => '{"result":true}\n';

beforeEach(async () => {
  received = [];
  replyFn = () => '{"result":true}\n';
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let i;
      while ((i = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        const req = JSON.parse(line); received.push(req);
        if (req.params.api === "startCaptureScreen") {
          sock.write('{"result":true}\n');
          sock.write(JPEG(1)); sock.write(JPEG(2)); sock.write(JPEG(3));
        } else {
          sock.write(replyFn(req));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  client = new AgentClient(sock);
});
afterEach(async () => { client.close(); await new Promise<void>((r) => server.close(() => r())); });

describe("AgentClient streaming", () => {
  it("yields frames until the stream is stopped", async () => {
    const frames: Buffer[] = [];
    for await (const f of client.streamScreen({ scale: 2 })) {
      frames.push(f);
      if (frames.length === 3) break;
    }
    expect(frames).toHaveLength(3);
    expect(frames[0]![0]).toBe(0xff);
    expect(received[0].params.args[0]).toEqual({ displayId: 0, scale: 2 });
  });

  it("stopStream sends stopCaptureScreen", async () => {
    const it = client.streamScreen();
    await it[Symbol.asyncIterator]().next();
    await client.stopStream();
    expect(received.some((r) => r.params.api === "stopCaptureScreen")).toBe(true);
  });

  it("does not let frames block normal RPCs", async () => {
    // 流开着的时候发一个普通请求，应该照常返回
    replyFn = () => '{"result":{"width":1,"height":1}}\n';
    const it = client.streamScreen();
    await it[Symbol.asyncIterator]().next();
    const size = await client.getDisplaySize();
    expect(size).toEqual({ width: 1, height: 1 });
  });

  it("stopStream tolerates an already-stopped stream", async () => {
    // 多实例场景：另一个进程先停了流
    replyFn = (req) => req.params.api === "stopCaptureScreen"
      ? '{"result":null,"exception":"Capture is not running"}\n'
      : '{"result":true}\n';
    const it = client.streamScreen();
    await it[Symbol.asyncIterator]().next();
    await expect(client.stopStream()).resolves.toBeUndefined();   // 不抛
  });
});
