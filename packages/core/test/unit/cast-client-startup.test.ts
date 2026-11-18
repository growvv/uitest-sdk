import { describe, it, expect, vi } from "vitest";
import type { HdcRunner } from "../../src/transport/hdc.js";

/**
 * Startup failures that happen *after* the daemon and the port forward exist.
 *
 * `H264CastClient.start` builds the gRPC stub and opens the recorder after the
 * cleanup `try` ends, so a throw there used to leave both on the device. The
 * realistic case is a package whose `dist/` lost `scrcpy.proto`: every cast
 * would then spawn a daemon, forward a port, fail, and never release either.
 *
 * The proto loader is mocked rather than the whole grpc stack: the failure is
 * exactly "the service definition cannot be loaded", and everything else in
 * the path is the real code.
 */
vi.mock("@grpc/proto-loader", () => ({
  loadSync: () => {
    throw new Error("scrcpy.proto is missing from dist/");
  },
}));

const calls: string[] = [];
const removed: number[] = [];

const hdc = {
  async shell(cmd: string): Promise<string> {
    calls.push(cmd);
    if (cmd.includes("pidof uitest")) return "1000 2000";
    if (cmd.includes("ps -ef")) {
      return "shell  2000  1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name libscreen_casting.z.so -scrcpy_socket_name scrcpy_grpc_socket";
    }
    if (cmd.includes("/proc/net/unix")) {
      return "0000: 00000002 00000000 00010000 0001 01 12345 @scrcpy_grpc_socket";
    }
    return "";
  },
  async fportAdd(port: number): Promise<number> {
    return port;
  },
  async fportRemove(port: number): Promise<void> {
    removed.push(port);
  },
} as unknown as HdcRunner;

const { H264CastClient } = await import("../../src/cast/client.js");

describe("H264CastClient.start — failure after the forward", () => {
  it("releases the daemon and the forward when the service cannot be loaded", async () => {
    await expect(H264CastClient.start(hdc, { mode: "stream" })).rejects.toThrow(/scrcpy\.proto/);
    expect(calls).toContain("kill -9 2000");
    expect(removed).toHaveLength(1);
  });
});
