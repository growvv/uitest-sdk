import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Screen } from "uitest-sdk";

/**
 * `uitest-console --record <file>` must actually record.
 *
 * The console passed `recordPath` into its source and never told the server to
 * start: `recordOnStart` stayed unset, so the page came up with a file name, a
 * Record button nobody pressed, and no recording when the window closed. The
 * mirror had the same flag and wired it; the console only looked wired.
 *
 * The server is stubbed rather than run: what this asserts is the option the
 * console hands it, which is the whole defect. `createViewerSource` is stubbed
 * too so the test needs no device.
 */
const captured: Record<string, unknown>[] = [];
const sourceStub = { createCast: () => ({}) };

vi.mock("uitest-sdk/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("uitest-sdk/viewer")>();
  return {
    ...actual,
    createViewerSource: () => sourceStub,
    startViewerServer: async (opts: Record<string, unknown>) => {
      captured.push(opts);
      return {
        port: 1234,
        close: async () => undefined,
      };
    },
  };
});

const { startConsole } = await import("../../src/cli.js");
const { createConsoleServer } = await import("../../src/server.js");

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

function session() {
  return {
    core: {
      reader: { builder: { setRedact: () => undefined }, read: async () => screen },
      observe: async () => ({ status: "settled" }),
    },
    device: { agent: { getDisplaySize: async () => ({ width: 400, height: 800 }) } },
    tag: "7544d645",
    close: async () => undefined,
  };
}

function options(over: Record<string, unknown> = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    privacy: true,
    open: false,
    stateDir: mkdtempSync(join(tmpdir(), "console-record-")),
    task: "console",
    layout: true,
    scale: 1 as const,
    frameRate: 30 as const,
    ...over,
  };
}

describe("--record wiring", () => {
  it("starts the recording on the server when --record is given", async () => {
    captured.length = 0;
    const run = await startConsole(options({ record: "demo.mp4" }) as never, (async () => session()) as never);
    try {
      expect(captured).toHaveLength(1);
      expect(captured[0]!["recordOnStart"]).toBe(true);
    } finally {
      await run.close();
    }
  });

  it("does not start a recording when --record is absent", async () => {
    captured.length = 0;
    const run = await startConsole(options() as never, (async () => session()) as never);
    try {
      expect(captured).toHaveLength(1);
      expect(captured[0]!["recordOnStart"]).toBeUndefined();
    } finally {
      await run.close();
    }
  });

  it("passes the flag through createConsoleServer", async () => {
    captured.length = 0;
    const server = await createConsoleServer({
      source: sourceStub as never,
      approvals: { pending: () => [], decide: () => ({ kind: "ok" }) as never },
      stateDir: "/tmp/state",
      tag: "7544d645",
      hold: async () => ({}) as never,
      resume: async () => true,
      isHeld: async () => false,
      activity: async () => [],
      recordOnStart: true,
    });
    expect(captured[0]!["recordOnStart"]).toBe(true);
    await server.close();
  });
});
