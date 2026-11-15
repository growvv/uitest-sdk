import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import jpeg from "jpeg-js";
import { AgentClient } from "../../src/agent/client.js";

let server: net.Server, client: AgentClient, received: any[] = [];
let replyFn: (req: any) => string | Buffer = () => '{"result":true}\n';

beforeEach(async () => {
  received = []; replyFn = () => '{"result":true}\n';
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let i;
      while ((i = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        const req = JSON.parse(line); received.push(req);
        sock.write(replyFn(req));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  client = new AgentClient(sock);
});
afterEach(async () => { client.close(); await new Promise<void>((r) => server.close(() => r())); });

const solidJpeg = (w: number, h: number) =>
  jpeg.encode({ data: Buffer.alloc(w * h * 4, 0x40), width: w, height: h }, 80).data;

describe("AgentClient actions", () => {
  it("touchDown sends Gestures.touchDown with x/y", async () => {
    await client.touchDown(10, 20);
    expect(received[0].method).toBe("Gestures");
    expect(received[0].params).toEqual({ api: "touchDown", args: { x: 10, y: 20 } });
  });

  it("click sends down then up", async () => {
    await client.click(5, 6);
    expect(received.map((r) => r.params.api)).toEqual(["touchDown", "touchUp"]);
  });

  it("swipe uses the Gestures channel, never Driver.swipe", async () => {
    await client.swipe(0, 0, 100, 100, { steps: 3 });
    expect(received.map((r) => r.params.api))
      .toEqual(["touchDown", "touchMove", "touchMove", "touchMove", "touchUp"]);
    // 全部走 Gestures 通道
    expect(received.every((r) => r.method === "Gestures")).toBe(true);
    // 绝不能出现 Driver.swipe（模拟器上要 6~12 秒）
    expect(received.some((r) => r.params.api === "Driver.swipe")).toBe(false);
  });

  it("swipe releases the pointer when a move fails mid-gesture", async () => {
    // A gesture that dies mid-move must not leave a finger held on the device.
    let moves = 0;
    replyFn = (req) => {
      if (req.params.api === "touchMove" && ++moves === 2) {
        return '{"result":null,"exception":"Invalid params"}\n';
      }
      return '{"result":true}\n';
    };
    await expect(client.swipe(0, 0, 100, 100, { steps: 3 })).rejects.toThrow(/Invalid params/);
    expect(received.at(-1)?.params.api).toBe("touchUp");
  });

  it("captureLayout returns the tree", async () => {
    replyFn = () => '{"result":{"attributes":{"id":"root"},"children":[]}}\n';
    const tree = await client.captureLayout();
    expect(tree.attributes.id).toBe("root");
    expect(received[0].method).toBe("Captures");
  });

  it("hypium wraps the callHypiumApi envelope", async () => {
    await client.hypium("Driver.pressBack", "Driver#0", []);
    expect(received[0].method).toBe("callHypiumApi");
    expect(received[0].params).toEqual({ api: "Driver.pressBack", this: "Driver#0", args: [] });
  });

  it("inputText goes through Driver.inputText with a Point", async () => {
    await client.inputText(10, 20, "你好 world");
    expect(received[0].method).toBe("callHypiumApi");
    expect(received[0].params.api).toBe("Driver.inputText");
    expect(received[0].params.args[0]).toEqual({ x: 10, y: 20 });
    expect(received[0].params.args[1]).toBe("你好 world");
  });

  it("triggerKey goes through Driver.triggerKey", async () => {
    await client.triggerKey(26);
    expect(received[0].params.api).toBe("Driver.triggerKey");
    expect(received[0].params.args).toEqual([26]);
  });

  it("captureScreen starts the stream, takes one frame, then stops", async () => {
    replyFn = (req) => {
      if (req.params.api === "startCaptureScreen") {
        // 设备先回一行 JSON，再把裸 JPEG 拼在同一 socket 上
        return Buffer.concat([Buffer.from('{"result":true}\n'), solidJpeg(50, 100)]);
      }
      return '{"result":true}\n';
    };
    const img = await client.captureScreen({ scale: 0.5 });
    expect(jpeg.decode(img).width).toBe(50);
    expect(received.map((r) => r.params.api))
      .toEqual(["startCaptureScreen", "stopCaptureScreen"]);
    expect(received[0].params.args[0]).toEqual({ displayId: 0, scale: 0.5 });
  });

  /** Screen 100x200, window at the lower-left quarter; capture always 50x100. */
  function cropFixture(getSize: string): (req: any) => string | Buffer {
    return (req) => {
      if (req.params.api === "captureLayout") {
        return '{"result":{"attributes":{"bounds":"[0,100][50,200]","bundleName":"com.demo"},"children":[]}}\n';
      }
      if (req.params.api === "getDisplaySize") return getSize;
      if (req.params.api === "startCaptureScreen") {
        return Buffer.concat([Buffer.from('{"result":true}\n'), solidJpeg(50, 100)]);
      }
      return '{"result":true}\n';
    };
  }

  it("cropToWindow crops to the window bounds", async () => {
    replyFn = cropFixture('{"result":{"width":100,"height":200}}\n');
    const out = await client.cropToWindow({ bundleName: "com.demo", scale: 0.5 });
    const img = jpeg.decode(out);
    expect(img.width).toBe(25);
    expect(img.height).toBe(50);
  });

  it("cropToWindow derives the crop factor from the frame, not the requested scale", async () => {
    // The device ignores `scale` and returns a fixed-size frame (measured:
    // 608x1344 for a 1216x2688 screen). Bounds are in display coordinates, so
    // the factor must come from the image itself.
    replyFn = cropFixture('{"result":{"width":100,"height":200}}\n');
    const out = await client.cropToWindow({ bundleName: "com.demo", scale: 1 });
    const img = jpeg.decode(out);
    expect(img.width).toBe(25);
    expect(img.height).toBe(50);
  });
});
