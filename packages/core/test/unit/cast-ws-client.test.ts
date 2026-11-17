import { describe, it, expect } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsCastClient } from "../../src/cast/ws-client.js";
import { DaemonStartError, UitestError } from "../../src/transport/errors.js";
import type { HdcRunner } from "../../src/transport/hdc.js";

/** A tiny stand-in for the 7.0 extension: handshake, then scripted replies. */
interface FakeServer {
  server: Server;
  port: number;
  /** Text commands received, in order. */
  commands: string[];
  close(): Promise<void>;
}

function startFakeExtension(
  opts: { script?: (cmd: string, send: (s: string) => void, bin: (b: Buffer) => void) => void } = {},
): Promise<FakeServer> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const send = (text: string) => {
      const payload = Buffer.from(text, "utf8");
      sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    const bin = (data: Buffer) => {
      const head = Buffer.from([0x82, 126, data.length >> 8, data.length & 0xff]);
      sock.write(Buffer.concat([head, data]));
    };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: x\r\nSec-WebSocket-Protocol: scrcpy\r\n\r\n",
        );
        buf = buf.subarray(end + 4);
        upgraded = true;
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + 4 + len) break;
        const mask = buf.subarray(off, off + 4);
        const masked = buf.subarray(off + 4, off + 4 + len);
        const plain = Buffer.alloc(masked.length);
        for (let i = 0; i < masked.length; i++) plain[i] = masked[i]! ^ mask[i % 4]!;
        buf = buf.subarray(off + 4 + len);
        const cmd = plain.toString("utf8");
        commands.push(cmd);
        if (opts.script) opts.script(cmd, send, bin);
        else if (cmd.includes("requestIDR")) send('{"type":"idrResponse","result":0}');
        else if (cmd.includes("start")) send('{"type":"started"}');
        else if (cmd.includes("stop")) send('{"type":"stopped","frameCount":3}');
      }
    });
    sock.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        commands,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

/** Fake hdc whose `fportAdd` points at the fake extension's port. */
function fakeHdc(
  port: number,
  over: { pidsLive?: string; psLine?: string; fportThrows?: boolean } = {},
): {
  hdc: HdcRunner;
  calls: string[];
  added: number[];
  removed: number[];
  pushed: string[];
} {
  const calls: string[] = [];
  const added: number[] = [];
  const removed: number[] = [];
  const pushed: string[] = [];
  const hdc = {
    async shell(cmd: string): Promise<string> {
      calls.push(cmd);
      if (cmd.includes("pidof uitest")) return over.pidsLive ?? "1000 2000";
      // The daemon is identified by `-p <port>` in its argv; the port is what
      // tells two daemons on one device apart.
      if (cmd.includes("ps -ef")) {
        return (
          over.psLine ??
          "shell  2000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness -p 5000"
        );
      }
      if (cmd.includes("/proc/net/tcp")) return " 8: 00000000:1388 00000000:0000 0A";
      // Record mode pulls this file on dispose; report it as written.
      if (cmd.includes("ls -l /data/local/tmp/mytest.mp4")) {
        return "-rw-r--r-- 1 shell shell 4096 2026-11-16 14:00 /data/local/tmp/mytest.mp4";
      }
      return "";
    },
    async fportAdd(port2: number): Promise<number> {
      if (over.fportThrows) throw new Error("TCP Port listen failed at 1024");
      added.push(port2);
      return port; // hand the client the fake extension's real port
    },
    async fportRemove(p: number): Promise<void> {
      removed.push(p);
    },
    async pull(): Promise<void> {},
    async push(local: string, remote: string): Promise<void> {
      pushed.push(`${local}->${remote}`);
    },
  };
  return { hdc: hdc as unknown as HdcRunner, calls, added, removed, pushed };
}

/** A real file on disk: WsCastClient pushes it and loads it by basename. */
const wsExtension = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ws-ext-"));
  const p = join(dir, "libscreen_casting_ws.z.so");
  writeFileSync(p, "fake 7.0 build");
  return p;
})();

describe("WsCastClient", () => {
  it("sends start, yields frames with the 4-byte prefix stripped", async () => {
    const annexB = Buffer.concat([
      Buffer.from([0, 0, 0, 1, 0x65]),
      Buffer.alloc(50, 0x11), // IDR slice
    ]);
    const fake = await startFakeExtension({
      script: (cmd, send, bin) => {
        if (cmd.includes("start")) {
          send('{"type":"started"}');
          bin(Buffer.concat([Buffer.from([0, 0, 0, annexB.length]), annexB]));
        } else if (cmd.includes("stop")) send('{"type":"stopped","frameCount":1}');
      },
    });
    const { hdc } = fakeHdc(fake.port);
    const cast = await WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension });
    try {
      expect(cast.castKind).toBe("h264");
      const it = cast.stream()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.done).toBe(false);
      const chunk = first.value as { data: Buffer; isKeyFrame: boolean };
      expect(chunk.data.equals(annexB)).toBe(true);
      expect(chunk.isKeyFrame).toBe(true);
    } finally {
      await cast.dispose();
      await fake.close();
    }
  });

  it("maps text replies to the pending command", async () => {
    const fake = await startFakeExtension();
    const { hdc } = fakeHdc(fake.port);
    const cast = await WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension });
    try {
      await cast.requestIDRFrame();
      expect(fake.commands.some((c) => c.includes("requestIDR"))).toBe(true);
    } finally {
      await cast.dispose();
      await fake.close();
    }
  });

  it("kills the daemon and removes the forward on dispose", async () => {
    // The daemon's listening socket dies after `stop`, so it is never reusable;
    // leaving it behind would strand a process that can no longer serve anyone.
    const fake = await startFakeExtension();
    const { hdc, calls, removed } = fakeHdc(fake.port);
    const cast = await WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension });
    await cast.dispose();
    expect(calls.some((c) => c === "kill -9 2000")).toBe(true);
    expect(removed.length).toBe(1);
    await fake.close();
  });

  it("picks its own daemon by port when another started in the same window", async () => {
    // Two pages on one device start a daemon each; a pidof diff cannot tell
    // them apart, but the argv can.
    const fake = await startFakeExtension();
    const { hdc, calls } = fakeHdc(fake.port, {
      pidsLive: "1000 2000 3000",
      psLine:
        "shell  3000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness -p 5000",
    });
    const cast = await WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension });
    await cast.dispose();
    expect(calls.filter((c) => c.startsWith("kill -9"))).toEqual(["kill -9 3000"]);
    await fake.close();
  });

  it("does not kill a daemon serving another port", async () => {
    const fake = await startFakeExtension();
    const { hdc, calls } = fakeHdc(fake.port, {
      psLine: "shell  2000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness -p 5001",
    });
    await expect(WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension })).rejects.toThrow(
      DaemonStartError,
    );
    expect(calls.filter((c) => c.startsWith("kill -9"))).toEqual([]);
    await fake.close();
  });

  it("rejects a daemon that never appears", async () => {
    const fake = await startFakeExtension();
    const { hdc } = fakeHdc(fake.port, { psLine: "" });
    await expect(WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension })).rejects.toThrow(DaemonStartError);
    await fake.close();
  });

  it("cleans up the process it started when the forward fails", async () => {
    const fake = await startFakeExtension();
    const { hdc, calls } = fakeHdc(fake.port, { fportThrows: true });
    await expect(WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension })).rejects.toThrow();
    expect(calls).toContain("kill -9 2000");
    await fake.close();
  });

  it("refuses to start after dispose", async () => {
    const fake = await startFakeExtension();
    const { hdc } = fakeHdc(fake.port);
    const cast = await WsCastClient.start(hdc, { mode: "stream", port: 5000, wsExtension });
    await cast.dispose();
    await expect(async () => {
      for await (const _ of cast.stream()) void _;
    }).rejects.toThrow(UitestError);
    await fake.close();
  });

  it("opens the recorder at construction, without a stream() call", async () => {
    // `start` is what opens the muxer. A record-mode caller never iterates
    // stream(), so if start only went out there the recording would be empty.
    const fake = await startFakeExtension();
    const { hdc } = fakeHdc(fake.port);
    const cast = await WsCastClient.start(hdc, {
      mode: "record",
      port: 5000,
      wsExtension,
      outputPath: join(tmpdir(), "rec-ws.mp4"),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.commands).toContain('{"type":"start"}');
    // dispose sends stop, which is what closes the muxer and writes the file.
    await cast.dispose();
    expect(fake.commands.some((c) => c.includes("stop"))).toBe(true);
    await fake.close();
  });

  it("does not stop twice when dispose is called while it is already stopping", async () => {
    // The `durationMs` timer and the caller can both dispose at once. Two
    // `stop` commands are two pulls of the same file, so the second caller has
    // to wait for the first instead of starting a second stop.
    const fake = await startFakeExtension();
    const { hdc } = fakeHdc(fake.port);
    const pulled: string[] = [];
    (hdc as unknown as { pull: (a: string, b: string) => Promise<void> }).pull = async (a: string, b: string) => {
      pulled.push(`${a}->${b}`);
    };

    const cast = await WsCastClient.start(hdc, {
      mode: "record",
      port: 5000,
      wsExtension,
      outputPath: join(tmpdir(), "rec-twice.mp4"),
    });
    await Promise.all([cast.dispose(), cast.dispose()]);
    await cast.dispose();

    expect(fake.commands.filter((c) => c.includes("stop"))).toHaveLength(1);
    expect(pulled).toHaveLength(1);
    await fake.close();
  });

  it("stops recording on its own after durationMs", async () => {
    // `durationMs` is documented as "how long to keep recording": without it
    // the parameter is a promise the code never keeps.
    const fake = await startFakeExtension();
    const { hdc } = fakeHdc(fake.port);
    const pulled: string[] = [];
    (hdc as unknown as { pull: (a: string, b: string) => Promise<void> }).pull = async (a: string, b: string) => {
      pulled.push(`${a}->${b}`);
    };

    const cast = await WsCastClient.start(hdc, {
      mode: "record",
      port: 5000,
      wsExtension,
      outputPath: join(tmpdir(), "rec-timed.mp4"),
      durationMs: 150,
    });
    await new Promise((r) => setTimeout(r, 500));

    // The timer ends the recording the same way a caller's dispose() does.
    expect(fake.commands.some((c) => c.includes("stop"))).toBe(true);
    expect(pulled).toHaveLength(1);
    // And the caller's own dispose() afterwards is a no-op, not a second pull.
    await cast.dispose();
    expect(pulled).toHaveLength(1);
    await fake.close();
  });

  it("waits for the recorder to stop growing before pulling", async () => {
    // The 7.0 muxer creates the file early and keeps appending, so a non-zero
    // size proves nothing: pulling then yields a header-only MP4 (measured:
    // 259 B pulled, 140 KB actually recorded).
    const fake = await startFakeExtension();
    const sizes = ["259", "259", "40960", "140293", "140293"];
    let lsCalls = 0;
    const { hdc } = fakeHdc(fake.port);
    const shell = hdc.shell.bind(hdc);
    (hdc as unknown as { shell: (c: string) => Promise<string> }).shell = async (cmd: string) => {
      if (cmd.includes("ls -l /data/local/tmp/mytest.mp4")) {
        const size = sizes[Math.min(lsCalls++, sizes.length - 1)];
        return `-rw-r--r-- 1 shell shell ${size} 2026-11-16 14:00 /data/local/tmp/mytest.mp4`;
      }
      return shell(cmd);
    };
    const pulled: string[] = [];
    (hdc as unknown as { pull: (a: string, b: string) => Promise<void> }).pull = async (a: string, b: string) => {
      pulled.push(`${a}->${b}`);
    };

    const cast = await WsCastClient.start(hdc, {
      mode: "record",
      port: 5000,
      wsExtension,
      outputPath: join(tmpdir(), "rec-ws.mp4"),
    });
    await cast.dispose();

    expect(pulled).toHaveLength(1);
    // 259 -> 259 is stable but too small to be a recording; the loop must keep
    // polling until the size settles at a real value.
    expect(lsCalls).toBeGreaterThanOrEqual(5);
    await fake.close();
  });

  it("refuses record mode without an outputPath", async () => {
    const fake = await startFakeExtension();
    const { hdc, calls } = fakeHdc(fake.port);
    await expect(WsCastClient.start(hdc, { mode: "record", port: 5000, wsExtension })).rejects.toThrow(UitestError);
    expect(calls.some((c) => c.includes("start-daemon"))).toBe(false);
    await fake.close();
  });
});
