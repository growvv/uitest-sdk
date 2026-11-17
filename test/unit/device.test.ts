import { describe, it, expect, vi, beforeEach } from "vitest";
import net from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "../../src/driver/agent/client.js";
import { AgentConnectionError, DeviceNotConnectedError, ExtensionMissingError } from "../../src/transport/errors.js";

// ------------------------------------------------------------------ fixtures

const hdcState = {
  targets: ["fake-device"] as string[],
  abi: "arm64,arm",
  listening: false,
  shellCalls: [] as string[],
  pushed: [] as string[],
  removedPorts: [] as number[],
  /** Pids the code killed explicitly. */
  killed: [] as string[],
  /** `pidof uitest` before any daemon start. */
  pidof: "1000",
  /** `pidof uitest` after `start-daemon` succeeded. */
  pidofAfterStart: "1000 2000",
  extDir: "",
  /** Port the fake agent listens on; FakeHdc forwards to it. */
  agentPort: 0,
  /** Port the fake casting extension listens on; cast forwards go here. */
  castPort: 0,
  /** Extra lines for the fake `cat /proc/net/tcp`, beyond the listener. */
  sockets: [] as string[],
  /**
   * The fake agent answers "Disallow concurrent use" while this is true.
   * Killing the daemon clears it, the way a restarted daemon starts clean.
   */
  stuck: false,
  /** `cat /proc/<pid>/cmdline` output for each pid `pidof uitest` reports. */
  cmdlines: {} as Record<string, string>,
  /** `ps -ef` output; `start-daemon` appends a line for the new daemon. */
  psLines: [] as string[],
  /** Per-target hdc state; an id without an entry is Connected. */
  states: {} as Record<string, string>,
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
        if (hdcState.stuck) {
          sock.write('{"result":null,"exception":"Disallow concurrent use"}\n');
        } else {
          sock.write('{"result":{"width":1216,"height":2688}}\n');
        }
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

/** Minimal 7.0 extension: upgrades, answers start/stop, never sends frames. */
async function startFakeWsExtension(): Promise<{
  port: number;
  sawStart: boolean;
  close(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const state = { sawStart: false };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const send = (text: string) => {
      const payload = Buffer.from(text, "utf8");
      sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Protocol: scrcpy\r\n\r\n",
        );
        buf = buf.subarray(end + 4);
        upgraded = true;
      }
      for (;;) {
        if (buf.length < 2) break;
        const len = buf[1]! & 0x7f;
        const off = 2;
        if (len >= 126 || buf.length < off + 4 + len) break;
        const mask = buf.subarray(off, off + 4);
        const masked = buf.subarray(off + 4, off + 4 + len);
        const plain = Buffer.alloc(masked.length);
        for (let i = 0; i < masked.length; i++) plain[i] = masked[i]! ^ mask[i % 4]!;
        buf = buf.subarray(off + 4 + len);
        const cmd = plain.toString("utf8");
        if (cmd.includes("start")) {
          state.sawStart = true;
          send('{"type":"started"}');
          // One IDR frame so `stream()` has something to yield.
          const annexB = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(16, 0x11)]);
          const head = Buffer.alloc(4);
          head.writeUInt32BE(annexB.length);
          const payload = Buffer.concat([head, annexB]);
          sock.write(Buffer.concat([Buffer.from([0x82, 126, payload.length >> 8, payload.length & 0xff]), payload]));
        } else if (cmd.includes("stop")) send('{"type":"stopped","frameCount":1}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    get sawStart() {
      return state.sawStart;
    },
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

vi.mock("../../src/transport/hdc.js", () => {
  class FakeHdc {
    constructor(_opts?: unknown) {}
    resolveHdcPath() { return "/fake/hdc"; }
    async shell(cmd: string): Promise<string> {
      hdcState.shellCalls.push(cmd);
      if (cmd.startsWith("param get")) return hdcState.abi;
      if (cmd.includes("start-daemon")) {
        hdcState.listening = true;
        hdcState.pidof = hdcState.pidofAfterStart;
        hdcState.stuck = false;
        // Echo the argv the way a real `ps -ef` does, so the client can find
        // the daemon it started by its socket name or port.
        const socket = /-scrcpy_socket_name (\S+)/.exec(cmd)?.[1];
        const port = /-p (\d+)/.exec(cmd)?.[1];
        const marker = socket ? `-scrcpy_socket_name ${socket}` : port ? `-p ${port}` : "";
        hdcState.psLines.push(
          `shell  2000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness ${marker}`,
        );
        return "";
      }
      if (cmd.startsWith("kill -9 ")) {
        hdcState.killed.push(cmd.slice("kill -9 ".length));
        hdcState.stuck = false;
        return "";
      }
      if (cmd.startsWith("cat /proc/") && cmd.includes("/cmdline")) {
        const pid = cmd.split("/")[2] ?? "";
        return hdcState.cmdlines[pid] ?? "";
      }
      if (cmd.includes("pidof uitest")) return hdcState.pidof;
      // The daemon is identified by its argv; the port tells two apart.
      if (cmd.includes("ps -ef")) return hdcState.psLines.join("\n");
      if (cmd.includes("/proc/net/tcp")) {
        if (!hdcState.listening) return "";
        return ["  2: 00000000:1F4C 00000000:0000 0A", ...hdcState.sockets].join("\n");
      }
      if (cmd.startsWith("ls -l /data/local/tmp/agent.so")) return "-rwxr-xr-x 1 root root 123456 /data/local/tmp/agent.so";
      return "";
    }
    async push(local: string, remote: string) { hdcState.pushed.push(`${local}->${remote}`); }
    async pull() {}
    async readLocal() { return ""; }
    async fportAdd(port: number, remote?: string) {
      // The agent forward must keep going to the fake agent; a cast forward
      // (any other device TCP port) goes to the fake casting extension, so one
      // test can have both servers running.
      if (remote?.startsWith("tcp:") && remote !== "tcp:8012" && hdcState.castPort) {
        return hdcState.castPort;
      }
      return hdcState.agentPort || port;
    }
    async fportRemove(port: number) { hdcState.removedPorts.push(port); }
    async listTargets() { return hdcState.targets; }
    async listTargetDetails() {
      return hdcState.targets.map((id) => ({ id, state: hdcState.states[id] ?? "connected" }));
    }
  }
  return { HdcRunner: FakeHdc };
});

const { Device, defaultExtensionDir } = await import("../../src/driver/device.js");
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
  hdcState.psLines = [];
  hdcState.extDir = makeExtDir("arm64", true);
  hdcState.agentPort = 0;
  hdcState.castPort = 0;
  hdcState.sockets = [];
  hdcState.stuck = false;
  hdcState.killed = [];
  hdcState.cmdlines = { "1000": "/system/bin/uitest\u0000start-daemon\u0000singleness\u0000--extension-name\u0000agent.so\u0000" };
  hdcState.states = {};
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

  it("names device_offline when no target is attached", async () => {
    hdcState.targets = [];
    await expect(Device.connect()).rejects.toMatchObject({ state: "device_offline" });
  });

  it("names device_needs_setup when the phone has not authorized this computer", async () => {
    // The target is attached, but `hdc shell` cannot run anything on it until
    // the person unlocks the phone and allows USB debugging. Reporting this
    // as a generic shell failure tells the agent to retry instead of asking.
    hdcState.targets = ["fake-device"];
    hdcState.states = { "fake-device": "unauthorized" };
    await expect(Device.connect()).rejects.toMatchObject({ state: "device_needs_setup" });
  });

  it("names device_offline when the only target is offline", async () => {
    hdcState.targets = ["fake-device"];
    hdcState.states = { "fake-device": "offline" };
    await expect(Device.connect()).rejects.toMatchObject({ state: "device_offline" });
  });

  it("reuses an already-listening daemon instead of starting one", async () => {
    const agent = await startFakeAgent();
    hdcState.listening = true;
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(dev.ownsDaemon).toBe(false);
    expect(dev.files.list).toBeTypeOf("function");
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

  it("refuses the ws transport when no 7.0 extension is installed", async () => {
    // Choosing a transport is explicit. The bundled assets/ only ship the 6.8
    // build, so asking for ws without pointing at a 7.0 .so is a setup error
    // the caller must see, not a silent fallback to gRPC.
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    await expect(dev.createCast({ mode: "stream", transport: "ws" }))
      .rejects.toThrow(ExtensionMissingError);
    expect(hdcState.shellCalls.some((c) => c.includes("-p 5000"))).toBe(false);
    await dev.dispose();
    await agent.close();
  });

  it("starts the ws daemon when a 7.0 extension path is supplied", async () => {
    hdcState.listening = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;
    // `-p 5001` is 0x1389; the client waits for a LISTEN line before dialing.
    hdcState.sockets = ["  9: 00000000:1389 00000000:0000 0A"];
    const ws = await startFakeWsExtension();
    hdcState.castPort = ws.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    const wsPath = join(hdcState.extDir, "arm64", "libscreen_casting_ws.z.so");
    writeFileSync(wsPath, "fake 7.0 build");

    const cast = await dev.createCast({
      mode: "stream",
      transport: "ws",
      wsExtension: wsPath,
      port: 5001,
    });
    expect(cast.castKind).toBe("h264");

    const spawn = hdcState.shellCalls.find((c) => c.includes("start-daemon") && c.includes("-p 5001"));
    // The extension name is the local basename: that is what selects the 7.0
    // build without overwriting the bundled 6.8 file.
    expect(spawn).toContain("--extension-name libscreen_casting_ws.z.so");
    expect(hdcState.pushed.some((p) => p.endsWith("->/data/local/tmp/libscreen_casting_ws.z.so"))).toBe(true);
    // `start` goes out when the stream is iterated, not at construction.
    const it = cast.stream()[Symbol.asyncIterator]();
    const first = await it.next();
    expect(ws.sawStart).toBe(true);
    expect((first.value as { data: Buffer }).data.subarray(0, 5)).toEqual(
      Buffer.from([0, 0, 0, 1, 0x65]),
    );

    await cast.dispose();
    expect(hdcState.shellCalls).toContain("kill -9 2000");
    await dev.dispose();
    await agent.close();
    await ws.close();
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

  it("restarts a daemon whose global lock is held by a dead connection", async () => {
    // Measured on a real device: a client killed mid-request leaves a
    // CLOSE_WAIT socket on the daemon (state 08), and that dead socket keeps
    // the global lock forever — every request answers "Disallow concurrent
    // use" and waiting does not help. The daemon is alive, so `pidof` cannot
    // tell this from a healthy one.
    hdcState.listening = true;
    hdcState.sockets = [" 14: 0100007F:1F4C 0100007F:DC6E 08 00000000:00000001 00:00000000"];
    hdcState.stuck = true;
    hdcState.pidofAfterStart = "1000 4000";
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;

    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(hdcState.killed).toContain("1000");
    expect(hdcState.shellCalls.some((c) => c.includes("start-daemon"))).toBe(true);
    expect(dev.state).toBe("connected");
    await dev.dispose();
    await agent.close();
  });

  it("leaves a casting daemon alone when the agent daemon is the stuck one", async () => {
    // Both are the same binary, so `pidof uitest` cannot tell them apart. Only
    // the agent daemon's command line names agent.so.
    hdcState.listening = true;
    hdcState.sockets = [" 14: 0100007F:1F4C 0100007F:DC6E 08 00000000:00000001 00:00000000"];
    hdcState.stuck = true;
    hdcState.pidof = "1000 1001";
    hdcState.pidofAfterStart = "1000 1001 4000";
    hdcState.cmdlines = {
      "1000": "/system/bin/uitest\u0000start-daemon\u0000singleness\u0000--extension-name\u0000agent.so\u0000",
      "1001": "/system/bin/uitest\u0000start-daemon\u0000singleness\u0000--extension-name\u0000libscreen_casting.z.so\u0000",
    };
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;

    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(hdcState.killed).toEqual(["1000"]);
    expect(hdcState.killed).not.toContain("1001");
    await dev.dispose();
    await agent.close();
  });

  it("does not restart when the socket is merely in TIME_WAIT", async () => {
    // 06 is TIME_WAIT: the peer is gone and the kernel will reap it, but it is
    // not holding the lock. Restarting for it would kill a healthy daemon.
    hdcState.listening = true;
    hdcState.sockets = [" 11: 0100007F:1F4C 0100007F:A16A 06 00000000:00000000"];
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;

    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    expect(hdcState.shellCalls.some((c) => c.includes("kill"))).toBe(false);
    await dev.dispose();
    await agent.close();
  });

  it("never restarts a daemon another client is still using", async () => {
    // A live peer (01) means someone else's task owns the daemon. The busy
    // reply is theirs to finish with; killing the daemon would break it.
    hdcState.listening = true;
    hdcState.sockets = [
      " 14: 0100007F:1F4C 0100007F:DC6E 08 00000000:00000001 00:00000000",
      " 15: 0100007F:1F4C 0100007F:1234 01 00000000:00000000 00:00000000",
    ];
    hdcState.stuck = true;
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;

    await expect(Device.connect({ extensionDir: hdcState.extDir }))
      .rejects.toThrow(/busy|concurrent/i);
    expect(hdcState.killed).toEqual([]);
    await agent.close();
  });

  it("explains a stuck daemon instead of retrying forever when it cannot restart", async () => {
    hdcState.listening = true;
    hdcState.sockets = [" 14: 0100007F:1F4C 0100007F:DC6E 08 00000000:00000001 00:00000000"];
    hdcState.stuck = true;
    // No pid's command line names agent.so, so nothing can be safely killed.
    hdcState.cmdlines = {};
    const agent = await startFakeAgent();
    hdcState.agentPort = agent.port;

    // A short timeout would mask the point: the busy reply is retried inside
    // the request, so the failure that must be explained is the busy one.
    await expect(Device.connect({ extensionDir: hdcState.extDir }))
      .rejects.toThrow(/dead connection|kill -9/i);
    expect(hdcState.killed).toEqual([]);
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

  it("opens a second input lane and removes its forward on close", async () => {
    const agent = await startFakeAgent();
    hdcState.listening = true;
    hdcState.agentPort = agent.port;
    const dev = await Device.connect({ extensionDir: hdcState.extDir });
    const input = await dev.openInputLane();
    await expect(input.lane.click(10, 20)).resolves.toBeUndefined();
    expect(hdcState.shellCalls.filter((c) => c.includes("start-daemon"))).toHaveLength(0);
    await input.close();
    expect(hdcState.removedPorts).toContain(hdcState.agentPort);
    await dev.dispose();
    await agent.close();
  });
});
