import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The session API must not carry its own copies of things core already has.
 *
 * Two findings from the cross-check in `docs/reviews/cross-check-findings.md`:
 *
 * - `session.view.open()` opened a browser with a private `openBrowser`
 *   (`cmd /c start` / `open` / `xdg-open`) instead of core's `openWindow`,
 *   which opens an app window and reports when it cannot. A library caller got
 *   a browser tab and no fallback message.
 * - `session.cast.record()` re-implemented `Recording.start()` — the mkdir, the
 *   ws port offset and the gRPC socket name. A change to the rule in one place
 *   would leave the other silently starting a second daemon on the stream's own
 *   socket, which is exactly what `Recording` exists to prevent.
 *
 * Both are asserted structurally: the shared module must be the one called.
 */
const windowCalls: string[] = [];
vi.mock("../../src/viewer/window.js", () => ({
  openWindow: (url: string) => {
    windowCalls.push(url);
    return { opened: true };
  },
}));

interface RecordOpts {
  outputPath?: string;
  socketName: string;
  streamCast: { transport?: string; port?: number };
}
const recordOpts: RecordOpts[] = [];
const recordStops: string[] = [];
vi.mock("../../src/cast/record.js", () => ({
  Recording: class {
    constructor(opts: RecordOpts) {
      recordOpts.push(opts);
    }
    async start(): Promise<string> {
      return this.path!;
    }
    async stop(): Promise<string> {
      recordStops.push(this.path!);
      return this.path!;
    }
    private path = "/tmp/from-recording.mp4";
  },
}));

vi.mock("../../src/viewer/source.js", () => ({ createViewerSource: () => ({}) }));
vi.mock("../../src/viewer/server.js", () => ({
  startViewerServer: async (opts: Record<string, unknown>) => ({
    port: opts["port"] ?? 7000,
    close: async () => undefined,
  }),
}));
vi.mock("../../src/cast/create.js", () => ({ createCast: async () => ({}) }));

const { Session } = await import("../../src/api.js");

function session(): InstanceType<typeof Session> {
  const core = {
    stateDir: mkdtempSync(join(tmpdir(), "uitest-shared-")),
    task: "t",
    tag: "7544d645",
    release: async () => undefined,
  };
  return new Session({ agent: {}, dispose: async () => undefined } as never, core as never);
}

describe("session API uses core's shared implementations", () => {
  it("opens a view with core's openWindow, not a private launcher", async () => {
    windowCalls.length = 0;
    const s = session();
    const view = await s.view.open({ open: true });
    expect(windowCalls).toEqual([view.url]);
    await s.close();
  });

  it("records through Recording, so the socket/port rule exists once", async () => {
    recordOpts.length = 0;
    recordStops.length = 0;
    const s = session();
    const rec = await s.cast.record({ out: join(tmpdir(), "shared-rec.mp4"), transport: "grpc" });
    expect(recordOpts).toHaveLength(1);
    expect(recordOpts[0]!.outputPath).toBe(join(tmpdir(), "shared-rec.mp4"));
    // The record daemon must not take the stream's socket; Recording owns that
    // rule, and this call must be the one using it.
    expect(recordOpts[0]!.socketName).not.toBe("scrcpy_grpc_socket");
    await rec.stop();
    expect(recordStops).toHaveLength(1);
  });

  it("returns the path the caller asked for even if stop reports another", async () => {
    recordOpts.length = 0;
    const s = session();
    const out = join(tmpdir(), "shared-rec-2.mp4");
    const rec = await s.cast.record({ out });
    expect(rec.path).toBe(out);
    await expect(rec.stop()).resolves.toBe(out);
  });
});
