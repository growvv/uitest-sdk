import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Two `session.view.open()` calls over the ws transport.
 *
 * I2 gave each view its own gRPC socket name and its own HTTP port. The ws
 * transport has neither: the extension listens on a TCP port and the client
 * defaults it to 5000, so a second view in the same process asks the device
 * for a daemon on the port the first one is already serving. The second
 * `start-daemon` then either fails or `ownDaemon("-p 5000")` matches the
 * first view's process — and disposing the second view kills the first's
 * stream.
 *
 * The port must therefore be distinct per view, and two ports apart: the
 * record daemon runs beside the stream at `port + 1`, so consecutive views
 * one port apart would make view 1's stream take view 0's record port.
 */
const sources: Record<string, unknown>[] = [];

vi.mock("../../src/viewer/source.js", () => ({
  createViewerSource: (_session: unknown, _device: unknown, opts: Record<string, unknown>) => {
    sources.push(opts);
    return {};
  },
}));

vi.mock("../../src/viewer/server.js", () => ({
  startViewerServer: async (opts: Record<string, unknown>) => ({
    port: opts["port"] === 0 ? 5555 : opts["port"],
    close: async () => undefined,
  }),
}));

const { Session } = await import("../../src/api.js");

function fakeSession(cast: Record<string, unknown>): InstanceType<typeof Session> {
  const stateDir = mkdtempSync(join(tmpdir(), "uitest-view-ws-"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "cast.json"), JSON.stringify(cast), "utf8");
  const core = {
    stateDir,
    task: "t",
    tag: "7544d645",
    release: async () => undefined,
  };
  return new Session({ agent: {}, dispose: async () => undefined } as never, core as never);
}

describe("session.view.open over ws", () => {
  it("gives each view its own device-side port", async () => {
    sources.length = 0;
    const session = fakeSession({ transport: "ws", wsExtension: "C:/ext/casting.so" });

    await session.view.open({ open: false });
    await session.view.open({ open: false });

    const first = (sources[0]!["cast"] as Record<string, unknown>)["port"];
    const second = (sources[1]!["cast"] as Record<string, unknown>)["port"];
    expect(typeof first).toBe("number");
    expect(typeof second).toBe("number");
    expect(second).not.toBe(first);
    // The record daemon of the first view sits at `first + 1`; a second view
    // one port away would take it.
    expect(Number(second) - Number(first)).toBeGreaterThanOrEqual(2);

    await session.close();
  });

  it("keeps a port the person configured", async () => {
    sources.length = 0;
    const session = fakeSession({ transport: "ws", wsExtension: "C:/ext/casting.so", port: 6100 });
    await session.view.open({ open: false });
    expect((sources[0]!["cast"] as Record<string, unknown>)["port"]).toBe(6100);
    await session.close();
  });

  it("does not invent a port for the grpc transport", async () => {
    sources.length = 0;
    const session = fakeSession({ transport: "grpc" });
    await session.view.open({ open: false });
    // gRPC isolates views by socket name, not by port; a port here would be
    // meaningless to that transport.
    expect((sources[0]!["cast"] as Record<string, unknown>)["port"]).toBeUndefined();
    await session.close();
  });
});
