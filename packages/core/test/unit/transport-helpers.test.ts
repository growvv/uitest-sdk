import net from "node:net";
import { describe, expect, it } from "vitest";
import { connectTcp, pids } from "../../src/transport/helpers.js";

/**
 * `connectTcp` and `pids` were copied verbatim into two and three modules
 * respectively (`driver/device.ts`, `input/open.ts`; `cast/daemon.ts`,
 * `driver/device.ts`). A copy is a place to get the rule wrong on its own: the
 * `pids` copy is the one that decides which daemon this process owns, so a
 * divergence there is a daemon killed by the wrong client.
 */
describe("transport helpers", () => {
  it("parses pidof output, ignoring anything that is not a pid", () => {
    expect([...pids("1000 2000")]).toEqual(["1000", "2000"]);
    expect([...pids("  1000\n2000 ")]).toEqual(["1000", "2000"]);
    expect([...pids("")]).toEqual([]);
    expect([...pids("error: no such process")]).toEqual([]);
    // `pidof` prints several pids on one line; a deduplicated set is what the
    // ownership check needs.
    expect(pids("1000 1000").size).toBe(1);
  });

  it("connects to a listening port and rejects a closed one", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;

    const sock = await connectTcp(port);
    expect(sock.remotePort).toBe(port);
    sock.destroy();
    await new Promise<void>((r) => server.close(() => r()));

    await expect(connectTcp(port)).rejects.toThrow();
  });
});
