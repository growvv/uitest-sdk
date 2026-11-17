import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UitestError } from "./transport/errors.js";
import { installSkill } from "./install-skill.js";
import type { InstallSkillResult } from "./install-skill.js";
import { isMcpRegistered, registerJsonMcp, registerTomlMcp } from "./mcp-register.js";
import type { McpEntry, RegisterMcpResult } from "./mcp-register.js";

/** The agents whose settings this command knows how to edit. */
export type AgentId = "claude" | "codex" | "gemini" | "copilot";

export interface AgentTarget {
  id: AgentId;
  /** How its settings file is written. */
  kind: "json" | "toml";
  /** The settings file itself. */
  file: string;
  /**
   * Skill directories this agent reads. Codex, Gemini CLI and Copilot CLI
   * read the cross-runtime `~/.agents/skills`; Claude Code reads
   * `~/.claude/skills` as well.
   */
  skillDirs: "both" | "agents";
  /**
   * Wraps the entry in fields the agent's JSON schema requires. Absent when
   * `command` and `args` are the whole entry, which is what Claude and Gemini
   * accept.
   */
  shapeJson?: (entry: McpEntry) => McpEntry;
}

export interface AgentTargetOptions {
  home?: string;
  env?: Record<string, string | undefined>;
}

/**
 * The entry Copilot CLI expects for a local server: `type` is required, and
 * a server exposes no tools until one is listed.
 */
function copilotEntry(entry: McpEntry): McpEntry {
  return { type: "local", command: entry.command, args: entry.args, env: {}, tools: ["*"] };
}

/**
 * Where an agent keeps its MCP servers and its skills.
 *
 * The paths are the ones each tool documents: Claude Code's user scope is
 * `~/.claude.json` (`$CLAUDE_CONFIG_DIR` moves it), Codex's is
 * `~/.codex/config.toml` (`$CODEX_HOME` moves it), Gemini CLI's is
 * `~/.gemini/settings.json`, and Copilot CLI's is
 * `~/.copilot/mcp-config.json` (`$COPILOT_HOME` moves the directory).
 */
export function agentTarget(agent: AgentId, opts: AgentTargetOptions = {}): AgentTarget {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  if (agent === "claude") {
    const dir = env["CLAUDE_CONFIG_DIR"] || home;
    return { id: "claude", kind: "json", file: join(dir, ".claude.json"), skillDirs: "both" };
  }
  if (agent === "codex") {
    const dir = env["CODEX_HOME"] || join(home, ".codex");
    return { id: "codex", kind: "toml", file: join(dir, "config.toml"), skillDirs: "agents" };
  }
  if (agent === "gemini") {
    return {
      id: "gemini",
      kind: "json",
      file: join(home, ".gemini", "settings.json"),
      skillDirs: "agents",
    };
  }
  if (agent === "copilot") {
    const dir = env["COPILOT_HOME"] || join(home, ".copilot");
    return {
      id: "copilot",
      kind: "json",
      file: join(dir, "mcp-config.json"),
      skillDirs: "agents",
      shapeJson: copilotEntry,
    };
  }
  throw new UitestError(
    `unknown agent "${String(agent)}"; use claude, codex, gemini or copilot`,
    "EAGENT",
  );
}

export interface McpEntryOptions {
  /** The `node` executable running this command. */
  nodePath: string;
  /** This package's `dist/bin.js`. */
  binPath: string;
  /** This package's version, for the npx fallback. */
  version?: string;
}

/**
 * The entry an agent should launch.
 *
 * An absolute path to the installed package, started by the same `node` that
 * is running this command: agents started from the Dock or the Start menu do
 * not see the terminal's `PATH`, and a bare `uitest-phone` there can resolve
 * to nothing or to another program. When the only copy is in npx's cache —
 * which npm sweeps — the entry names the package instead, so the next launch
 * reinstalls it.
 */
export function mcpEntry(opts: McpEntryOptions): McpEntry {
  const cached = /[\\/]_npx[\\/]|[\\/]npm-cache[\\/]_npx[\\/]/.test(opts.binPath);
  if (cached) {
    const version = opts.version ? `@${opts.version}` : "";
    return { command: "npx", args: ["-y", `uitest-sdk${version}`, "mcp"] };
  }
  return { command: opts.nodePath, args: [opts.binPath, "mcp"] };
}

export interface ConnectAgentOptions {
  agent: AgentId;
  entry: McpEntry;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Replace a skill that is already installed. */
  force?: boolean;
  /** Keep a copy of the settings file before changing it. */
  backup?: boolean;
}

export interface ConnectAgentResult {
  target: AgentTarget;
  registered: RegisterMcpResult;
  /** The skill install, or null when a skill was already there. */
  skill: InstallSkillResult | null;
  /** Why the skill was left alone, when it was. */
  skillKept?: string;
}

/**
 * Makes one agent ready to drive a phone: its MCP server entry, and the skill
 * that teaches it the command loop.
 *
 * Only the agent's own entry is edited, and the skill goes where that agent
 * reads skills — `~/.claude/skills` for Claude Code, `~/.agents/skills` for
 * both (the cross-runtime alias Codex, Copilot CLI and Gemini CLI share).
 */
export async function connectAgent(opts: ConnectAgentOptions): Promise<ConnectAgentResult> {
  const target = agentTarget(opts.agent, { home: opts.home, env: opts.env });
  const entry = target.shapeJson ? target.shapeJson(opts.entry) : opts.entry;
  const registered =
    target.kind === "json"
      ? await registerJsonMcp({ file: target.file, name: "uitest-phone", entry, backup: opts.backup })
      : await registerTomlMcp({ file: target.file, name: "uitest-phone", entry: opts.entry, backup: opts.backup });

  const home = opts.home ?? homedir();
  const skillDirs =
    target.skillDirs === "both"
      ? undefined
      : [join(home, ".agents", "skills", "uitest-phone")];
  let skill: InstallSkillResult | null = null;
  let skillKept: string | undefined;
  try {
    skill = await installSkill({ home, force: opts.force, dirs: skillDirs });
  } catch (e) {
    // A hand-edited skill is the person's. Registering the server is still the
    // useful half of this command, so report the kept skill instead of failing.
    if (e instanceof UitestError && e.code === "ESKILLEXISTS") skillKept = e.message;
    else throw e;
  }

  return { target, registered, skill, skillKept };
}

/** Whether an agent already has this package's MCP server. */
export async function agentConnected(
  agent: AgentId,
  opts: AgentTargetOptions = {},
): Promise<boolean> {
  const target = agentTarget(agent, opts);
  if (target.kind === "json") return isMcpRegistered({ file: target.file, name: "uitest-phone" });
  if (!existsSync(target.file)) return false;
  const { readFileSync } = await import("node:fs");
  return readFileSync(target.file, "utf8").includes("[mcp_servers.uitest-phone]");
}
