import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer, toolDefinitions } from "../../src/mcp.js";
import { COMMANDS } from "../../src/operations/commands.js";

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
