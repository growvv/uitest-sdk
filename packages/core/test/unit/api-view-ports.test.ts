import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Screen } from "../../src/driver/agent/screen.js";

/**
 * Two `session.view.open()` calls in one process.
 *
 * Both used to default to HTTP port 7000 and to the same cast socket suffix
 * (`process.pid`), so the documented second viewer either failed with
 * EADDRINUSE or, with an explicit port, fought the first one over
 * `uitest_live_<pid>` on the device.
 *
 * The viewer modules are stubbed: what this asserts is the options the session
 * hands them, which is the whole defect.
 */
const sources: Record<string, unknown>[] = [];
const servers: Record<string, unknown>[] = [];

vi.mock("../../src/viewer/source.js", () => ({
  createViewerSource: (_session: unknown, _device: unknown, opts: Record<string, unknown>) => {
    sources.push(opts);
    return {};
  },
}));

vi.mock("../../src/viewer/server.js", () => ({
  startViewerServer: async (opts: Record<string, unknown>) => {
    servers.push(opts);
    return { port: opts["port"] === 0 ? 5555 : opts["port"], close: async () => undefined };
  },
}));

const { Session } = await import("../../src/api.js");

const screen: Screen = {
  header: "",
  bundle: "com.demo",
  display: { width: 400, height: 800 },
  rotation: 0,
  elements: [],
  lines: [],
  hash: "h",
  signatures: new Set(),
  tree: { attributes: {}, children: [] },
  at: 0,
};

function fakeSession(): InstanceType<typeof Session> {
  const core = {
    stateDir: mkdtempSync(join(tmpdir(), "uitest-view-")),
    task: "t",
    tag: "7544d645",
    reader: { builder: { setRedact: () => undefined }, read: async () => screen },
    screen: async () => screen,
    release: async () => undefined,
  };
  return new Session({ agent: {}, dispose: async () => undefined } as never, core as never);
}

describe("session.view.open", () => {
  it("gives a second view its own port and its own cast socket", async () => {
    sources.length = 0;
    servers.length = 0;
    const session = fakeSession();

    const first = await session.view.open({ open: false });
    const second = await session.view.open({ open: false });

    // The first keeps the documented 7000; the second must not ask for it.
    expect(servers[0]!["port"]).toBe(7000);
    expect(servers[1]!["port"]).not.toBe(7000);
    expect(first.port).toBe(7000);
    expect(second.port).toBe(5555);

    // The socket suffix is what keeps the two device-side daemons apart.
    expect(sources[0]!["socketSuffix"]).not.toBe(sources[1]!["socketSuffix"]);
    expect(String(sources[0]!["socketSuffix"])).toContain(String(process.pid));
    expect(String(sources[1]!["socketSuffix"])).toContain(String(process.pid));

    await session.close();
  });

  it("keeps an explicit port", async () => {
    servers.length = 0;
    const session = fakeSession();
    const view = await session.view.open({ port: 8123, open: false });
    expect(servers[0]!["port"]).toBe(8123);
    expect(view.port).toBe(8123);
    await session.close();
  });
});
