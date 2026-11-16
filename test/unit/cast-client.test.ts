import { describe, it, expect } from "vitest";
import { H264CastClient } from "../../src/cast/client.js";
import { DaemonStartError, UitestError } from "../../src/errors.js";
import type { HdcRunner } from "../../src/hdc.js";

interface FakeState {
  pidsBefore: string;
  pidsAfter: string;
  /** Third and later `pidof` calls; defaults to `pidsAfter`. */
  pidsLive: string;
  socketLine: string;
  fportThrows: boolean;
  calls: string[];
  added: number[];
  removed: number[];
}

function fakeHdc(over: Partial<FakeState> = {}): { hdc: HdcRunner; st: FakeState } {
  const st: FakeState = {
    pidsBefore: "1000",
    pidsAfter: "1000 2000",
    pidsLive: "1000 2000",
    socketLine: "0000: 00000002 00000000 00010000 0001 01 12345 @scrcpy_grpc_socket",
    fportThrows: false,
    calls: [],
    added: [],
    removed: [],
    ...over,
  };
  let pidofCalls = 0;
  const hdc = {
    async shell(cmd: string): Promise<string> {
      st.calls.push(cmd);
      if (cmd.includes("pidof uitest")) {
        pidofCalls++;
        return pidofCalls === 1 ? st.pidsBefore : pidofCalls === 2 ? st.pidsAfter : st.pidsLive;
      }
      if (cmd.includes("/proc/net/unix")) return st.socketLine;
      return "";
    },
    async fportAdd(port: number): Promise<number> {
      if (st.fportThrows) throw new Error("TCP Port listen failed at 1024");
      st.added.push(port);
      return port;
    },
    async fportRemove(port: number): Promise<void> {
      st.removed.push(port);
    },
    async pull(): Promise<void> {},
  };
  return { hdc: hdc as unknown as HdcRunner, st };
}

describe("H264CastClient.start", () => {
  it("refuses record mode without an outputPath", async () => {
    // The device path is hardcoded; without a pull destination the recording is
    // discarded silently, which is exactly the fallback this SDK forbids.
    const { hdc, st } = fakeHdc();
    await expect(H264CastClient.start(hdc, { mode: "record" })).rejects.toThrow(UitestError);
    expect(st.calls.some((c) => c.includes("start-daemon"))).toBe(false);
  });

  it("kills the daemon it started when startup fails after the spawn", async () => {
    const { hdc, st } = fakeHdc({ fportThrows: true });
    await expect(H264CastClient.start(hdc, { mode: "stream" })).rejects.toThrow();
    expect(st.calls).toContain("kill -9 2000");
  });

  it("fails when its own daemon is gone even though the socket name exists", async () => {
    // Another daemon may already own the default socket name, so a visible
    // socket does not prove the process we spawned is serving it.
    const { hdc, st } = fakeHdc({ pidsLive: "1000" });
    await expect(H264CastClient.start(hdc, { mode: "stream" })).rejects.toThrow(DaemonStartError);
    expect(st.added).toEqual([]);
  });

  it("refuses to claim a daemon when several fresh pids appear at once", async () => {
    const { hdc } = fakeHdc({ pidsAfter: "1000 2000 3000" });
    await expect(H264CastClient.start(hdc, { mode: "stream" })).rejects.toThrow(DaemonStartError);
  });

  it("kills the fresh daemons it cannot attribute before giving up", async () => {
    // A second daemon starting in the same window is not always an error we can
    // walk away from: the ones that did start are ours to clean up. Leaving
    // them behind leaks a device process per failed start — measured as four
    // orphaned xdevice_scrcpy processes after a few failed recordings.
    const { hdc, st } = fakeHdc({ pidsAfter: "1000 2000 3000" });
    await expect(H264CastClient.start(hdc, { mode: "stream" })).rejects.toThrow(DaemonStartError);
    expect(st.calls).toContain("kill -9 2000");
    expect(st.calls).toContain("kill -9 3000");
  });
});
