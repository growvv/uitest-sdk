import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { AgentClient } from "../../src/agent/client.js";
import { AgentProtocolError, AgentBusyError } from "../../src/errors.js";

let server: net.Server;
let client: AgentClient;
let port: number;
let received: string[] = [];
let replyFn: (req: any) => string | Buffer = () => '{"result":true}\n';

beforeEach(async () => {
  received = [];
  replyFn = () => '{"result":true}\n';
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        received.push(line);
        sock.write(replyFn(JSON.parse(line)));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
  const sock = net.createConnection(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  client = new AgentClient(sock);
});

afterEach(async () => {
  client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("AgentClient", () => {
  it("sends the documented envelope", async () => {
    await client.call("CtrlCmd", { api: "getDisplaySize", args: [] });
    const req = JSON.parse(received[0]);
    expect(req.module).toBe("com.ohos.devicetest.hypiumApiHelper");
    expect(req.method).toBe("CtrlCmd");
    expect(req.params).toEqual({ api: "getDisplaySize", args: [] });
  });

  it("returns the result field", async () => {
    replyFn = () => '{"result":{"width":1216,"height":2688},"pts":1}\n';
    await expect(client.call("CtrlCmd", { api: "getDisplaySize", args: [] }))
      .resolves.toEqual({ width: 1216, height: 2688 });
  });

  it("throws AgentProtocolError when the device returns an exception", async () => {
    replyFn = () => '{"result":null,"exception":"Invalid params"}\n';
    await expect(client.call("CtrlCmd", { api: "x", args: [] }))
      .rejects.toThrow(AgentProtocolError);
    await expect(client.call("CtrlCmd", { api: "x", args: [] }))
      .rejects.toThrow(/Invalid params/);
  });

  it("serialises concurrent calls", async () => {
    replyFn = () => '{"result":1}\n';
    await Promise.all([1, 2, 3].map(() => client.call("CtrlCmd", { api: "a", args: [] })));
    expect(received).toHaveLength(3);
  });

  it("retries on 'Disallow concurrent use' until the device is free", async () => {
    let n = 0;
    replyFn = () => (++n <= 2
      ? '{"result":null,"exception":"Disallow concurrent use"}\n'
      : '{"result":{"width":1216,"height":2688}}\n');
    await expect(client.call("CtrlCmd", { api: "getDisplaySize", args: [] }))
      .resolves.toEqual({ width: 1216, height: 2688 });
    expect(n).toBe(3); // 两次冲突 + 一次成功
  });

  it("throws AgentBusyError after exhausting busy retries", async () => {
    replyFn = () => '{"result":null,"exception":"Disallow concurrent use"}\n';
    const c = new AgentClient(connectedSocket(), { maxBusyRetries: 2 });
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentBusyError);
    c.close();
  });

  it("does NOT retry non-busy exceptions", async () => {
    let n = 0;
    replyFn = () => { n++; return '{"result":null,"exception":"Invalid params"}\n'; };
    await expect(client.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentProtocolError);
    expect(n).toBe(1);
  });

  it("fails 'Capture already running' immediately, without retrying", async () => {
    // spec §4.6: one capture channel per device; taking over another
    // process's stream is wrong behaviour, not something to wait for.
    let n = 0;
    replyFn = () => {
      n++;
      return '{"result":null,"exception":"Capture already running: copyScreen"}\n';
    };
    const t0 = Date.now();
    await expect(client.call("Captures", { api: "startCaptureScreen", args: [] }))
      .rejects.toThrow(AgentBusyError);
    expect(n).toBe(1);
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it("retryOnBusy:false surfaces the busy error immediately", async () => {
    let n = 0;
    replyFn = () => { n++; return '{"result":null,"exception":"Disallow concurrent use"}\n'; };
    const c = new AgentClient(connectedSocket(), { retryOnBusy: false });
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentBusyError);
    expect(n).toBe(1);
    c.close();
  });

  it("accepts an object exception without crashing", async () => {
    replyFn = () => '{"result":null,"exception":{"code":-1,"message":"WindowFilter cannot be empty"}}\n';
    await expect(client.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentProtocolError);
    await expect(client.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(/WindowFilter cannot be empty/);
  });

  it("recognises a busy exception delivered as an object", async () => {
    let n = 0;
    replyFn = () => {
      n++;
      return '{"result":null,"exception":{"code":1,"message":"Disallow concurrent use"}}\n';
    };
    const c = new AgentClient(connectedSocket(), { maxBusyRetries: 2 });
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentBusyError);
    expect(n).toBe(3);
    c.close();
  });
});

function connectedSocket(): net.Socket {
  return net.createConnection(port, "127.0.0.1");
}
