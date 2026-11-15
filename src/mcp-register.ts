import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { findNodeAtLocation, parse, parseTree, printParseErrorCode } from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";
import { UitestError } from "./errors.js";

/** One MCP server entry: what the agent launches and with which arguments. */
export interface McpEntry {
  command: string;
  args: string[];
}

export interface RegisterMcpOptions {
  /** Settings file to edit. */
  file: string;
  /** The server's key. Only this entry is touched. */
  name: string;
  entry: McpEntry;
  /** Keep a copy of the previous file next to it. */
  backup?: boolean;
}

export interface RegisterMcpResult {
  file: string;
  /** The file did not exist and was created. */
  created: boolean;
  /** The file's bytes changed. */
  changed: boolean;
  /** Where the previous version was copied, when `backup` was asked for. */
  backup?: string;
}

/**
 * Adds an MCP server entry to a JSON/JSONC settings file.
 *
 * The file is edited in place, not regenerated: only the bytes of our own
 * entry are inserted or replaced, so the person's other servers, comments, key
 * order and the neighbours' inline formatting survive untouched. (A generic
 * `modify`-style edit reformats the sibling property it appends after, which
 * is why the insertion is done on the text directly.)
 *
 * A file that does not parse is refused and left as it was: rewriting it
 * would discard whatever the person meant, and a half-repaired config is worse
 * than an error naming the file and the offset.
 */
export async function registerJsonMcp(opts: RegisterMcpOptions): Promise<RegisterMcpResult> {
  const { file, name, entry } = opts;

  if (!existsSync(file)) {
    await writeFile(file, `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`);
    return { file, created: true, changed: true };
  }

  const before = readFileSync(file, "utf8");
  const errors: ParseError[] = [];
  const root = parseTree(before, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !root) {
    const first = errors[0];
    throw new UitestError(
      `cannot parse ${file}${first ? `: ${printParseErrorCode(first.error)} at offset ${first.offset}` : ""}; ` +
        `fix the file by hand and run this again`,
      "EMCPPARSE",
    );
  }
  if (root.type !== "object") {
    throw new UitestError(`cannot parse ${file}: the document is not an object`, "EMCPPARSE");
  }

  const serversNode = findNodeAtLocation(root, ["mcpServers"]);
  if (serversNode && serversNode.type !== "object") {
    throw new UitestError(
      `${file}: "mcpServers" is not an object; fix it by hand and run this again`,
      "EMCPSHAPE",
    );
  }

  let after: string;
  const existing = serversNode ? findNodeAtLocation(root, ["mcpServers", name]) : undefined;
  if (existing) {
    const current = parse(before.slice(existing.offset, existing.offset + existing.length), [], {
      allowTrailingComma: true,
    });
    if (sameJson(current, entry)) return { file, created: false, changed: false };
    const indent = lineIndentAt(before, existing.offset);
    after =
      before.slice(0, existing.offset) +
      indentJson(JSON.stringify(entry, null, 2), indent) +
      before.slice(existing.offset + existing.length);
  } else if (serversNode) {
    after = insertProperty(before, serversNode, name, entry);
  } else {
    after = insertProperty(before, root, "mcpServers", { [name]: entry });
  }

  if (after === before) return { file, created: false, changed: false };

  const backup = opts.backup ? await writeBackup(file, before) : undefined;
  await writeFile(file, after);
  return { file, created: false, changed: true, backup };
}

/**
 * Adds an MCP server entry to a Codex-style TOML file.
 *
 * TOML has no parser here on purpose: the edit is one table, and a table is a
 * header plus the lines before the next header. Replacing exactly that range
 * keeps every other byte — comments between tables included — as it was.
 */
export async function registerTomlMcp(opts: RegisterMcpOptions): Promise<RegisterMcpResult> {
  const { file, name, entry } = opts;
  const section = `[mcp_servers.${name}]`;
  const body = [
    section,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
  ];

  if (!existsSync(file)) {
    await writeFile(file, `${body.join("\n")}\n`);
    return { file, created: true, changed: true };
  }

  const before = readFileSync(file, "utf8");
  const lines = before.split("\n");
  const start = lines.findIndex((line) => line.trim() === section);
  let after: string;
  if (start < 0) {
    const sep = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    after = `${before}${sep}${body.join("\n")}\n`;
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    // A blank line between this table and the next one is the file's, not
    // ours: keep it so a second run changes nothing.
    const keepBlank = end < lines.length && lines[end - 1]!.trim() === "";
    const replaced = [
      ...lines.slice(0, start),
      ...body,
      ...(keepBlank ? [""] : []),
      ...lines.slice(end),
    ];
    after = replaced.join("\n");
    if (before.endsWith("\n") && !after.endsWith("\n")) after += "\n";
  }

  if (after === before) return { file, created: false, changed: false };

  const backup = opts.backup ? await writeBackup(file, before) : undefined;
  await writeFile(file, after);
  return { file, created: false, changed: true, backup };
}

/** Whether the JSON settings file already names this server. */
export async function isMcpRegistered(opts: { file: string; name: string }): Promise<boolean> {
  if (!existsSync(opts.file)) return false;
  const errors: ParseError[] = [];
  const doc = parse(readFileSync(opts.file, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0 || doc === undefined || doc === null || typeof doc !== "object") return false;
  const servers = (doc as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined || servers === null || typeof servers !== "object") return false;
  return Object.prototype.hasOwnProperty.call(servers, opts.name);
}

/** The leading whitespace of the line `offset` sits on. */
function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

/** The file's indent unit, guessed from its first indented line. */
function indentUnit(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return "  ";
  return match[1]!.includes("\t") ? "\t" : " ".repeat(Math.min(match[1]!.length, 8));
}

/** Re-indents a pretty-printed JSON document so its lines line up under `indent`. */
function indentJson(json: string, indent: string): string {
  return json.split("\n").join(`\n${indent}`);
}

/**
 * Inserts `key: value` as the last property of `objectNode`, editing the text
 * and nothing else. A single-line object gets an inline property so its shape
 * does not change; a multi-line one gets a properly indented line and a comma
 * on its neighbour only when the neighbour lacks one.
 */
function insertProperty(
  text: string,
  objectNode: Node,
  key: string,
  value: unknown,
): string {
  const open = objectNode.offset;
  const close = objectNode.offset + objectNode.length - 1;
  const props = (objectNode.children ?? []).filter((child) => child.type === "property");
  const multiLine = text.slice(open + 1, close).includes("\n");

  if (!multiLine) {
    const prefix = props.length > 0 ? ", " : "";
    return (
      text.slice(0, close) +
      `${prefix}${JSON.stringify(key)}: ${JSON.stringify(value)}` +
      text.slice(close)
    );
  }

  const propIndent = props.length
    ? lineIndentAt(text, props[0]!.offset)
    : lineIndentAt(text, open) + indentUnit(text);
  const insertAt = text.lastIndexOf("\n", close) + 1;
  let head = text.slice(0, insertAt);
  if (props.length > 0 && !/,\s*$/.test(head.slice(0, -1))) {
    head = head.replace(/[ \t]*\n$/, ",\n");
  }
  const line = `${propIndent}${JSON.stringify(key)}: ${indentJson(JSON.stringify(value, null, 2), propIndent)}\n`;
  return head + line + text.slice(insertAt);
}

/** Compares two parsed JSON values without caring about key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = Object.entries(a as Record<string, unknown>);
    const right = b as Record<string, unknown>;
    if (left.length !== Object.keys(right).length) return false;
    return left.every(([key, value]) => key in right && sameJson(value, right[key]));
  }
  return false;
}

async function writeBackup(file: string, content: string): Promise<string> {
  const path = `${file}.uitest-phone.bak`;
  await writeFile(path, content);
  return path;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
