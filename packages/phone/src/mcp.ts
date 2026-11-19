import { createInterface } from "node:readline";
import { COMMANDS, EXIT_CODE } from "uitest-sdk/commands";
import type { RunResult } from "uitest-sdk/commands";
import { DeviceStateError } from "uitest-sdk";
import { VERSION } from "./version.js";

/** The subset of CommandRunner the server uses; keeps the tests device-free. */
export interface ToolRunner {
  run(name: string, args: Record<string, unknown>): Promise<RunResult>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

const PROTOCOL_VERSION = "2024-11-05";

/** `tap` → `uitest_tap`; a prefixed name cannot collide with another server's tools. */
export function toolName(command: string): string {
  return `uitest_${command}`;
}

/**
 * The MCP tool list, generated from `COMMANDS` so the two can never drift.
 * The command's own description is used verbatim: an agent reads these to
 * decide what to call, so they have to say what the command does.
 */
export function toolDefinitions(): ToolDefinition[] {
  return COMMANDS.map((command) => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    for (const [name, arg] of Object.entries(command.args)) {
      properties[name] = { type: arg.type, description: arg.description };
      if (arg.required) required.push(name);
    }
    return {
      name: toolName(command.name),
      description: command.description,
      inputSchema: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  });
}

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A Model Context Protocol server over stdio.
 *
 * One request per line, one response per line, JSON-RPC 2.0. Notifications get
 * no reply. A tool that returns a non-settled status is an *error result*
 * (`isError: true`) rather than a protocol error: the agent needs to see the
 * status and reason, not a transport failure.
 *
 * The runner is a factory, not an instance, because connecting a phone takes
 * seconds and the client sends `initialize` immediately. Connecting first made
 * the process exit before it answered, which a client reports as
 * "connection closed: initialize response" — with no reason the agent can act
 * on. The device is connected on the first tool call instead, and a device that
 * cannot be connected comes back as that call's error result.
 */
export class McpServer {
  private readonly runner: ToolRunner | Promise<ToolRunner>;

  constructor(runner: ToolRunner | Promise<ToolRunner> | (() => ToolRunner | Promise<ToolRunner>)) {
    this.runner = typeof runner === "function" ? runner() : runner;
  }

  /** Handles one line of input; returns the response line, or null. */
  async handle(line: string): Promise<string | null> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return error(null, -32700, "parse error");
    }
    const id = request.id ?? null;
    const isNotification = request.id === undefined;

    try {
      switch (request.method) {
        case "initialize":
          return reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "uitest-phone", version: VERSION },
          });
        case "notifications/initialized":
        case "notifications/cancelled":
          return null;
        case "tools/list":
          return reply(id, { tools: toolDefinitions() });
        case "tools/call":
          return await this.callTool(id, request.params ?? {});
        case "ping":
          return reply(id, {});
        default:
          if (isNotification) return null;
          return error(id, -32601, `method not found: ${request.method}`);
      }
    } catch (e) {
      if (isNotification) return null;
      return error(id, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  private async callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<string> {
    const name = String(params["name"] ?? "");
    if (!name.startsWith("uitest_")) {
      return error(id, -32602, `unknown tool "${name}"; tools are named uitest_<command>`);
    }
    const command = name.slice("uitest_".length);
    if (!COMMANDS.some((c) => c.name === command)) {
      return error(id, -32602, `unknown tool "${name}"; tools are named uitest_<command>`);
    }
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    let result;
    try {
      // Awaited here, not in the constructor: the handshake must not wait for
      // a phone. A connection that fails is this call's answer, so the agent
      // reads `device_offline` and stops instead of losing the server.
      result = await (await this.runner).run(command, args);
    } catch (e) {
      // A phone that is locked, unauthorized or unplugged is a task outcome,
      // not a protocol failure: the agent must see the status word and stop.
      if (e instanceof DeviceStateError) {
        const state = { status: e.state, code: EXIT_CODE[e.state] };
        return reply(id, {
          content: [
            { type: "text", text: e.message },
            { type: "text", text: JSON.stringify(state) },
          ],
          isError: true,
        });
      }
      throw e;
    }
    const payload = {
      status: result.status,
      code: result.code,
      data: result.data ?? {},
    };
    return reply(id, {
      content: [
        { type: "text", text: result.text },
        { type: "text", text: JSON.stringify(payload) },
      ],
      isError: result.status !== "settled",
    });
  }

  /** Runs the server until stdin closes. */
  async serve(input = process.stdin, output = process.stdout): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const out = await this.handle(line);
      if (out !== null) output.write(`${out}\n`);
    }
  }
}

function reply(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function error(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
