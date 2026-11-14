import { Device } from "../../src/device.js";

type Cmd =
  | { op: "connect"; target: string }
  | { op: "hammer"; calls: number }
  | { op: "startStream" }
  | { op: "captureLayout" }
  | { op: "startCaptureScreen" }
  | { op: "dispose" }
  | { op: "ping" };

let dev: Device | null = null;

process.on("message", async (m: Cmd) => {
  try {
    switch (m.op) {
      case "connect":
        dev = await Device.connect({ deviceId: m.target });
        process.send!({ ok: true, ownsDaemon: dev.ownsDaemon });
        break;
      case "hammer": {
        const t0 = Date.now();
        const rs = await Promise.all(
          Array.from({ length: m.calls }, () => dev!.agent.getDisplaySize()),
        );
        process.send!({ ok: true, n: rs.length, ms: Date.now() - t0 });
        break;
      }
      case "startStream": {
        const it = dev!.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
        const f = await it.next();
        process.send!({ ok: true, frameBytes: f.value?.length ?? 0 });
        break;
      }
      case "captureLayout": {
        const tree = await dev!.agent.captureLayout();
        process.send!({ ok: true, hasAttrs: !!tree.attributes });
        break;
      }
      case "startCaptureScreen":
        try {
          await dev!.agent.captureScreen({ scale: 2 });
          process.send!({ ok: true });
        } catch (e) {
          const err = e as Error;
          process.send!({ ok: false, name: err.name, message: err.message });
        }
        break;
      case "ping":
        process.send!({ ok: true, size: await dev!.agent.getDisplaySize() });
        break;
      case "dispose":
        await dev?.dispose();
        process.send!({ ok: true });
        break;
    }
  } catch (e) {
    const err = e as Error;
    process.send!({ ok: false, name: err.name, message: err.message });
  }
});
