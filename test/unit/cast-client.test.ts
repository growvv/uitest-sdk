import { describe, it, expect } from "vitest";
import { H264CastClient } from "../../src/cast/client.js";
import { DaemonStartError, UitestError } from "../../src/errors.js";
import type { HdcRunner } from "../../src/hdc.js";

interface FakeState {
  /** `pidof uitest`: only used now to check our daemon is still alive. */
  pidsLive: string;
  /** Output of `ps -ef`, filtered by socket name. */
  psLine: string;
  socketLine: string;
  fportThrows: boolean;
  calls: string[];
  added: number[];
  removed: number[];
}

function fakeHdc(over: Partial<FakeState> = {}): { hdc: HdcRunner; st: FakeState } {
  const st: FakeState = {
    pidsLive: "1000 2000",
    psLine: "shell  2000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name libscreen_casting.z.so -scrcpy_socket_name scrcpy_grpc_socket",
    socketLine: "0000: 00000002 00000000 00010000 0001 01 12345 @scrcpy_grpc_socket",
    fportThrows: false,
    calls: [],
    added: [],
    removed: [],
    ...over,
  };
  const hdc = {
    async shell(cmd: string): Promise<string> {
      st.calls.push(cmd);
      if (cmd.includes("pidof uitest")) return st.pidsLive;
      // `ps -ef` carries the full argv, including the socket name, so the
      // daemon that serves *this* socket can be identified even when several
      // started in the same window.
      if (cmd.includes("ps -ef")) return st.psLine;
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

  it("picks its own daemon by socket name when several started at once", async () => {
    // Two `live` pages on one device start a daemon each in the same window.
    // A pidof diff then shows two new pids, but only one of them carries our
    // socket name — the other belongs to the sibling and is not ours to kill.
    const { hdc, st } = fakeHdc({
      pidsLive: "1000 2000 3000",
      psLine:
        "shell  3000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name libscreen_casting.z.so -scrcpy_socket_name scrcpy_grpc_socket",
    });
    const client = await H264CastClient.start(hdc, { mode: "stream" });
    await client.dispose();
    expect(st.calls.filter((c) => c.startsWith("kill -9"))).toEqual(["kill -9 3000"]);
  });

  it("does not kill a daemon it cannot attribute to its socket", async () => {
    // Without a match, the fresh processes are somebody else's. Killing them
    // would make two live pages take turns killing each other's daemons, which
    // is exactly the livelock this replaces.
    const { hdc, st } = fakeHdc({
      pidsLive: "1000 2000 3000",
      psLine:
        "shell  2000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name libscreen_casting.z.so -scrcpy_socket_name someone_else",
    });
    await expect(H264CastClient.start(hdc, { mode: "stream" })).rejects.toThrow(DaemonStartError);
    expect(st.calls.filter((c) => c.startsWith("kill -9"))).toEqual([]);
  });
});
