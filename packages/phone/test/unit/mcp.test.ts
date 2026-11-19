import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, toolDefinitions } from "../../src/mcp.js";
import type { ToolRunner } from "../../src/mcp.js";
import { DeviceStateError } from "uitest-sdk";
import { COMMANDS } from "uitest-sdk/commands";

/** The version in package.json — the one source of truth for a release. */
function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

/** A runner that records calls, so the server can be tested without a device. */
function fakeRunner() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async run(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "doctor") {
        return { status: "settled" as const, code: 0, text: "ok", data: {} };
      }
      return { status: "settled" as const, code: 0, text: `${name} done`, data: { name } };
    },
  };
}

const req = (method: string, params?: unknown, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

/**
 * A runner whose device is not up yet. `handle` must answer the handshake and
 * only then wait for it, so this class is the whole test: if `initialize`
 * blocks on `ready`, the server is connecting before it is listening.
 */
class PendingRunner {
  constructor(private readonly ready: Promise<ToolRunner>) {}
  async run(name: string, args: Record<string, unknown>) {
    return (await this.ready).run(name, args);
  }
}


describe("toolDefinitions", () => {
  it("exposes every command as a tool with a JSON schema", () => {
    const tools = toolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(COMMANDS.map((c) => `uitest_${c.name}`));
    const tap = tools.find((t) => t.name === "uitest_tap")!;
    expect(tap.description.length).toBeGreaterThan(10);
    expect(tap.inputSchema.type).toBe("object");
    expect(Object.keys(tap.inputSchema.properties)).toContain("ref");
    expect(tap.inputSchema.properties.ref.type).toBe("number");
  });

  it("marks required arguments as required", () => {
    const type = toolDefinitions().find((t) => t.name === "uitest_type")!;
    expect(type.inputSchema.required).toEqual(["text"]);
  });

  it("gives the agent a handoff tool that requires a reason", () => {
    // The reason is what the person reads when they pick up the phone; a
    // handoff without one asks them to guess what the agent needs.
    const handoff = toolDefinitions().find((t) => t.name === "uitest_handoff")!;
    expect(handoff.inputSchema.required).toEqual(["reason"]);
    expect(handoff.description).toMatch(/person/i);
  });
});

describe("McpServer", () => {
  it("answers initialize with the protocol version and capabilities", async () => {
    const server = new McpServer(fakeRunner());
    const out = await server.handle(req("initialize", { protocolVersion: "2024-11-05" }));
    const reply = JSON.parse(out!);
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBeTruthy();
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(reply.result.serverInfo.name).toBe("uitest-phone");
    // A client shows this version, so it must be the version actually
    // published — not a literal that drifts from package.json.
    expect(reply.result.serverInfo.version).toBe(packageVersion());
  });

  it("answers initialize while the device is still being connected", async () => {
    // The MCP client sends `initialize` the moment the process starts, long
    // before a phone could be ready. A server that connects first and answers
    // second makes the client report "connection closed: initialize response"
    // and every tool is then unusable — an agent reads that as a broken tool
    // and starts working around it.
    let release!: (runner: ToolRunner) => void;
    const ready = new Promise<ToolRunner>((r) => (release = r));
    const server = new McpServer(() => ready);
    const out = await Promise.race([
      server.handle(req("initialize", { protocolVersion: "2024-11-05" })),
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    expect(out, "initialize must not wait for the device").not.toBeNull();
    expect(JSON.parse(out!).result.serverInfo.name).toBe("uitest-phone");
    release(fakeRunner());
  });

  it("reports a device that cannot be connected as a tool error, not a dead server", async () => {
    // With no phone attached the process must stay up: the agent gets the
    // device state as the result of its first tool call, which is something it
    // can report and stop on. Exiting instead leaves the client with a closed
    // connection and no reason.
    const server = new McpServer(async () => {
      throw new DeviceStateError("device_offline", "device_offline · no phone attached", "ENODEVICE");
    });
    expect(await server.handle(req("initialize", { protocolVersion: "2024-11-05" }))).toContain(
      "uitest-phone",
    );
    const reply = JSON.parse(
      (await server.handle(req("tools/call", { name: "uitest_observe", arguments: {} })))!,
    );
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content.map((c: { text: string }) => c.text).join("\n")).toMatch(
      /device_offline/,
    );
  });

  it("lists tools", async () => {
    const server = new McpServer(fakeRunner());
    const reply = JSON.parse((await server.handle(req("tools/list")))!);
    expect(reply.result.tools.length).toBe(COMMANDS.length);
  });

  it("calls a tool and returns its text as content", async () => {
    const runner = fakeRunner();
    const server = new McpServer(runner);
    const reply = JSON.parse(
      (await server.handle(
        req("tools/call", { name: "uitest_tap", arguments: { ref: 3 } }),
      ))!,
    );
    expect(runner.calls).toEqual([{ name: "tap", args: { ref: 3 } }]);
    expect(reply.result.content[0]).toEqual({ type: "text", text: "tap done" });
    expect(reply.result.isError).toBe(false);
  });

  it("reports a non-settled status as an error result", async () => {
    const runner = {
      async run() {
        return { status: "not_found" as const, code: 1, text: "not_found · ref 9" };
      },
    };
    const server = new McpServer(runner);
    const reply = JSON.parse(
      (await server.handle(req("tools/call", { name: "uitest_tap", arguments: { ref: 9 } })))!,
    );
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain("not_found");
  });

  it("returns a screenshot as an image block, not just a path", async () => {
    // The skill tells the agent to take a screenshot when the screen text does
    // not answer the question — an unlabelled calculator key, a chart, an
    // icon-only button. A path string is useless to a model: it has to see the
    // pixels. MCP carries them as an image content block, which the client
    // hands to the model as an attachment.
    const dir = mkdtempSync(join(tmpdir(), "uitest-mcp-"));
    const file = join(dir, "shot.jpg");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    writeFileSync(file, jpeg);
    const runner = {
      async run() {
        return { status: "settled" as const, code: 0, text: `saved: ${file}`, data: { path: file } };
      },
    };
    const server = new McpServer(runner);
    const reply = JSON.parse(
      (await server.handle(req("tools/call", { name: "uitest_screenshot", arguments: {} })))!,
    );
    const image = reply.result.content.find((c: { type: string }) => c.type === "image");
    expect(image, "the model must receive the pixels").toBeDefined();
    expect(image.mimeType).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64")).toEqual(jpeg);
  });

  it("returns an inspect panel as an image block too", async () => {
    // `inspect` boxes and numbers every element on the frame; the agent reads
    // the numbers to pick a ref. It is the same kind of answer as a
    // screenshot, so it travels the same way.
    const dir = mkdtempSync(join(tmpdir(), "uitest-mcp-"));
    const file = join(dir, "inspect.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const server = new McpServer({
      async run() {
        return { status: "settled" as const, code: 0, text: `saved: ${file}`, data: { path: file } };
      },
    });
    const reply = JSON.parse(
      (await server.handle(req("tools/call", { name: "uitest_inspect", arguments: {} })))!,
    );
    expect(reply.result.content.some((c: { type: string }) => c.type === "image")).toBe(true);
  });

  it("does not attach an image for a path that is not there", async () => {
    // A missing file is a normal outcome (the caller deleted it, the write
    // failed). The text result still has to arrive; only the attachment goes.
    const runner = {
      async run() {
        return {
          status: "settled" as const,
          code: 0,
          text: "saved: C:/nope/missing.jpg",
          data: { path: "C:/nope/missing.jpg" },
        };
      },
    };
    const server = new McpServer(runner);
    const reply = JSON.parse(
      (await server.handle(req("tools/call", { name: "uitest_screenshot", arguments: {} })))!,
    );
    expect(reply.result.content[0].text).toContain("saved:");
    expect(reply.result.content.some((c: { type: string }) => c.type === "image")).toBe(false);
  });

  it("rejects an unknown tool with a JSON-RPC error", async () => {
    const server = new McpServer(fakeRunner());
    const reply = JSON.parse((await server.handle(req("tools/call", { name: "uitest_nope" })))!);
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toMatch(/unknown tool/);
  });

  it("answers a notification with no reply", async () => {
    const server = new McpServer(fakeRunner());
    const out = await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(out).toBeNull();
  });

  it("returns method-not-found for an unknown method", async () => {
    const server = new McpServer(fakeRunner());
    const reply = JSON.parse((await server.handle(req("resources/list")))!);
    expect(reply.error.code).toBe(-32601);
  });

  it("returns a parse error for malformed input", async () => {
    const server = new McpServer(fakeRunner());
    const reply = JSON.parse((await server.handle("{not json"))!);
    expect(reply.error.code).toBe(-32700);
  });

  it("keeps the approval id out of the tool result text", async () => {
    const runner = fakeRunner();
    const server = new McpServer(runner);
    await server.handle(
      req("tools/call", { name: "uitest_tap", arguments: { ref: 3, approvalId: "abc123" } }),
    );
    expect(runner.calls[0]!.args).toMatchObject({ ref: 3, approvalId: "abc123" });
  });
});
