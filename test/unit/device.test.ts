import { describe, it, expect, vi, beforeEach } from "vitest";
import net from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "../../src/agent/client.js";
import { AgentConnectionError, DeviceNotConnectedError, ExtensionMissingError } from "../../src/errors.js";

// ------------------------------------------------------------------ fixtures

const hdcState = {
  targets: ["fake-device"] as string[],
  abi: "arm64,arm",
  listening: false,
  shellCalls: [] as string[],
  pushed: [] as string[],
  removedPorts: [] as number[],
  /** `pidof uitest` before any daemon start. */
  pidof: "1000",
  /** `pidof uitest` after `start-daemon` succeeded. */
  pidofAfterStart: "1000 2000",
  extDir: "",
  /** Port the fake agent listens on; FakeHdc forwards to it. */
  agentPort: 0,
};

/** Fake agent server that answers the connect-time health check. */
async function startFakeAgent(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let i;
      while ((i = buf.indexOf(0x0a)) >= 0) {
        buf = buf.subarray(i + 1);
        sock.write('{"result":{"width":1216,"height":2688}}\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Accepts the TCP connection but never answers: the health check must time out. */
async function startSilentAgent(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

function makeExtDir(abi: "arm64" | "x86_64", withCasting: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-"));
  mkdirSync(join(dir, abi));
  writeFileSync(join(dir, abi, "agent.so"), "");
  if (withCasting) writeFileSync(join(dir, abi, "libscreen_casting.z.so"), "");
  return dir;
}

vi.mock("../../src/hdc.js", () => {
  class FakeHdc {
    constructor(_opts?: unknown) {}
    resolveHdcPath() { return "/fake/hdc"; }
    async shell(cmd: string): Promise<string> {
      hdcState.shellCalls.push(cmd);
      if (cmd.startsWith("param get")) return hdcState.abi;
      if (cmd.includes("start-daemon")) {
        hdcState.listening = true;
        hdcState.pidof = hdcState.pidofAfterStart;
        return "";
      }
      if (cmd.includes("pidof uitest")) return hdcState.pidof;
      if (cmd.includes("/proc/net/tcp")) {
        return hdcState.listening ? "  2: 00000000:1F4C 00000000:0000 0A" : "";
      }
      if (cmd.startsWith("ls -l /data/local/tmp/agent.so")) return "-rwxr-xr-x 1 root root 123456 /data/local/tmp/agent.so";
      return "";
    }
    async push(local: string, remote: string) { hdcState.pushed.push(`${local}->${remote}`); }
    async pull() {}
    async readLocal() { return ""; }
    async fportAdd(port: number) { return hdcState.agentPort || port; }
    async fportRemove(port: number) { hdcState.removedPorts.push(port); }
    async listTargets() { return hdcState.targets; }
  }
  return { HdcRunner: FakeHdc };
});

const { Device, defaultExtensionDir } = await import("../../src/device.js");
const ROOT = join(import.meta.dirname, "../..");

beforeEach(() => {
  hdcState.targets = ["fake-device"];
  hdcState.abi = "arm64,arm";
  hdcState.listening = false;
  hdcState.shellCalls = [];
  hdcState.pushed = [];
  hdcState.removedPorts = [];
  hdcState.pidof = "1000";
  hdcState.pidofAfterStart = "1000 2000";
  hdcState.extDir = makeExtDir("arm64", true);
  hdcState.agentPort = 0;
});

// --------------------------------------------------------------------- tests

describe("connection loss", () => {
  it("rejects in-flight requests with AgentConnectionError", async () => {
    const server = net.createServer((s) => { s.on("data", () => s.destroy()); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    const c = new AgentClient(sock);
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentConnectionError);
    c.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("Device.connect", () => {
  it("throws DeviceNotConnectedError when no target is attached", async () => {
    hdcState.targets = [];
    await expect(Device.connect()).rejects.toThrow(DeviceNotConnectedError);
  });

  it("reuses an already-listening daemon instead of starting one", async () => {
    const agent = await startFakeAgent();
    hdcState.listening = true;
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(dev.ownsDaemon).toBe(false);
    expect(hdcState.shellCalls.some((c) => c.includes("start-daemon"))).toBe(false);
    await dev.dispose();
    await agent.close();
  });

  it("never kills a daemon it does not own on dispose", async () => {
    const agent = await startFakeAgent();
    hdcState.listening = true;
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    await dev.dispose();
    expect(hdcState.shellCalls.some((c) => c.includes("kill"))).toBe(false);
    expect(dev.state).toBe("disconnected");
    await agent.close();
  });

  it("resolves the default extension dir from the module, not the cwd", () => {
    // An installed package lives in node_modules/<pkg>/dist: a cwd-relative
    // default would look for <cwd>/assets and throw. The default must hang off
    // the module's own location, which is the repository's assets/ here.
    expect(defaultExtensionDir()).toBe(join(ROOT, "assets"));
    expect(existsSync(join(defaultExtensionDir(), "arm64", "agent.so"))).toBe(true);
  });

  it("throws ExtensionMissingError when agent.so is not on disk for the ABI", async () => {
    await expect(Device.connect({ extensionDir: "/definitely/not/here" }))
      .rejects.toThrow(ExtensionMissingError);
  });

  it("picks the MJPEG cast path on x86_64", async () => {
    hdcState.abi = "x86_64";
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: makeExtDir("x86_64", false) });
    const cast = await dev.createCast({ mode: "stream", frameRate: 15 });
    expect(cast.castKind).toBe("mjpeg");
    await cast.dispose();
    await dev.dispose();
    await agent.close();
  });

  it("picks the H.264 cast path when the arm64 extension exists", async () => {
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    // H264CastClient.start spawns its own daemon, so this path is only asserted
    // through the resolver here; the real start is covered by Task 13.
    expect(dev.resolveCastExtension()).toBe(join(hdcState.extDir, "arm64", "libscreen_casting.z.so"));
    await dev.dispose();
    await agent.close();
  });

  it("pushes agent.so when the device copy is missing", async () => {
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(hdcState.pushed.some((p) => p.endsWith("->/data/local/tmp/agent.so"))).toBe(true);
    await dev.dispose();
    await agent.close();
  });

  it("pushes the casting extension along with agent.so", async () => {
    // createCast picks H.264 from a local file, but the daemon loads the .so
    // from /data/local/tmp — a device that never got the push cannot cast.
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(hdcState.pushed.some((p) => p.endsWith("->/data/local/tmp/libscreen_casting.z.so"))).toBe(true);
    await dev.dispose();
    await agent.close();
  });

  it("removes the tunnel and kills its daemon when the health check fails", async () => {
    const agent = await startSilentAgent();
    hdcState.agentPort = agent.port;
    await expect(
      Device.connect({ extensionDir: hdcState.extDir, requestTimeoutMs: 60 }),
    ).rejects.toThrow();
    expect(hdcState.removedPorts).toContain(agent.port);
    expect(hdcState.shellCalls).toContain("kill -9 2000");
    await agent.close();
  });

  it("does not claim ownership when several fresh pids appear at once", async () => {
    hdcState.pidofAfterStart = "1000 2000 3000"; // a sibling started one too
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir, ownDaemon: true });
    expect(dev.ownsDaemon).toBe(false);
    await dev.dispose();
    expect(hdcState.shellCalls.some((c) => c.includes("kill"))).toBe(false);
    await agent.close();
  });

  it("does not claim ownership when no fresh pid appears", async () => {
    hdcState.pidofAfterStart = "1000";
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir, ownDaemon: true });
    expect(dev.ownsDaemon).toBe(false);
    await dev.dispose();
    expect(hdcState.shellCalls.some((c) => c.includes("kill"))).toBe(false);
    await agent.close();
  });

  it("refuses record mode on a device without a casting extension", async () => {
    hdcState.abi = "x86_64";
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: makeExtDir("x86_64", false) });
    await expect(dev.createCast({ mode: "record", outputPath: "/tmp/out.mp4" }))
      .rejects.toThrow(ExtensionMissingError);
    await dev.dispose();
    await agent.close();
  });

  it("reconnects before the next call by default", async () => {
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });

    // Kill the transport the way a daemon crash would.
    const sock = (dev.agent as unknown as { sock: net.Socket }).sock;
    sock.destroy();
    await new Promise((r) => setTimeout(r, 20));

    // A request already in flight is never replayed; the next call reconnects.
    await expect(dev.agent.call("CtrlCmd", { api: "y", args: [] }))
      .resolves.toEqual({ width: 1216, height: 2688 });

    await dev.dispose();
    await agent.close();
  });

  it("stays failed when autoRestart is explicitly off", async () => {
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir, autoRestart: false });

    const sock = (dev.agent as unknown as { sock: net.Socket }).sock;
    sock.destroy();
    await new Promise((r) => setTimeout(r, 20));

    await expect(dev.agent.call("CtrlCmd", { api: "x", args: [] }))
      .rejects.toThrow(AgentConnectionError);
    await expect(dev.agent.call("CtrlCmd", { api: "y", args: [] }))
      .rejects.toThrow(AgentConnectionError);

    await dev.dispose();
    await agent.close();
  });

  it("refuses to run after dispose", async () => {
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    await dev.dispose();
    expect(dev.state).toBe("disconnected");
    await expect(dev.agent.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow();
    await agent.close();
  });
});
