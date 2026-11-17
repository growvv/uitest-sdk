import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTarget, connectAgent, mcpEntry } from "../../src/connect.js";
import type { AgentId } from "../../src/connect.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-connect-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("agentTarget", () => {
  it("points Claude Code at its user settings file", () => {
    const target = agentTarget("claude", { home: "/home/me" });
    expect(target).toMatchObject({ id: "claude", kind: "json", file: join("/home/me", ".claude.json") });
  });

  it("honours CLAUDE_CONFIG_DIR", () => {
    const target = agentTarget("claude", { home: "/home/me", env: { CLAUDE_CONFIG_DIR: "/cfg" } });
    expect(target.file).toBe(join("/cfg", ".claude.json"));
  });

  it("points Codex at its TOML config", () => {
    const target = agentTarget("codex", { home: "/home/me" });
    expect(target).toMatchObject({
      id: "codex",
      kind: "toml",
      file: join("/home/me", ".codex", "config.toml"),
    });
    expect(agentTarget("codex", { home: "/home/me", env: { CODEX_HOME: "/codex" } }).file).toBe(
      join("/codex", "config.toml"),
    );
  });

  it("points Gemini CLI at its settings file", () => {
    // Gemini keeps its user settings in ~/.gemini/settings.json, MCP servers
    // under the same top-level mcpServers key the other JSON agents use.
    const target = agentTarget("gemini", { home: "/home/me" });
    expect(target).toMatchObject({
      id: "gemini",
      kind: "json",
      file: join("/home/me", ".gemini", "settings.json"),
      skillDirs: "agents",
    });
  });

  it("points Copilot CLI at its mcp-config.json", () => {
    // Copilot CLI stores local servers with type "local"; COPILOT_HOME moves
    // the whole ~/.copilot directory.
    const target = agentTarget("copilot", { home: "/home/me" });
    expect(target).toMatchObject({
      id: "copilot",
      kind: "json",
      file: join("/home/me", ".copilot", "mcp-config.json"),
      skillDirs: "agents",
    });
    expect(agentTarget("copilot", { home: "/home/me", env: { COPILOT_HOME: "/ch" } }).file).toBe(
      join("/ch", "mcp-config.json"),
    );
  });

  it("names every supported agent when asked for an unknown one", () => {
    expect(() => agentTarget("vscode" as unknown as AgentId, { home: "/home/me" })).toThrow(
      /claude, codex, gemini or copilot/,
    );
  });
});

describe("mcpEntry", () => {
  it("starts the installed binary by its absolute path", () => {
    // An agent started from the Dock or the Start menu does not see the
    // terminal's PATH, so a bare command can resolve to something else or to
    // nothing. A full path cannot be stood in for.
    const entry = mcpEntry({
      nodePath: "/usr/bin/node",
      binPath: "/opt/uitest-sdk/dist/bin.js",
    });
    expect(entry).toEqual({ command: "/usr/bin/node", args: ["/opt/uitest-sdk/dist/bin.js", "mcp"] });
  });

  it("falls back to npx when the package only exists in the npx cache", () => {
    // The npx cache is swept; a path into it would break the next time npm
    // clears it, so the entry names the package instead.
    const entry = mcpEntry({
      nodePath: "/usr/bin/node",
      binPath: "/home/me/.npm/_npx/abc123/node_modules/uitest-sdk/dist/bin.js",
      version: "0.2.0",
    });
    expect(entry).toEqual({ command: "npx", args: ["-y", "uitest-phone@0.2.0", "mcp"] });
  });
});

describe("connectAgent", () => {
  it("registers the server and installs the skill in both directories", async () => {
    await withDir(async (dir) => {
      const result = await connectAgent({ agent: "claude", home: dir, entry: { command: "npx", args: ["uitest-sdk", "mcp"] } });
      expect(result.registered.changed).toBe(true);
      const settings = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
      expect(settings.mcpServers["uitest-phone"]).toEqual({ command: "npx", args: ["uitest-sdk", "mcp"] });
      expect(result.skill?.dirs).toEqual([
        join(dir, ".claude", "skills", "uitest-phone"),
        join(dir, ".agents", "skills", "uitest-phone"),
      ]);
    });
  });

  it("keeps a hand-edited skill but still registers the server", async () => {
    await withDir(async (dir) => {
      const skillDir = join(dir, ".claude", "skills", "uitest-phone");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "mine\n");
      const result = await connectAgent({
        agent: "claude",
        home: dir,
        entry: { command: "npx", args: ["uitest-sdk", "mcp"] },
      });
      expect(result.skill).toBeNull();
      expect(result.skillKept).toContain("already exists");
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("mine\n");
      expect(await readFile(join(dir, ".claude.json"), "utf8")).toContain("uitest-phone");
    });
  });

  it("writes the Codex TOML table", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, ".codex"), { recursive: true });
      await writeFile(join(dir, ".codex", "config.toml"), `model = "gpt-5"\n`);
      const result = await connectAgent({
        agent: "codex",
        home: dir,
        entry: { command: "npx", args: ["uitest-sdk", "mcp"] },
      });
      expect(result.registered.changed).toBe(true);
      const toml = await readFile(join(dir, ".codex", "config.toml"), "utf8");
      expect(toml).toContain(`model = "gpt-5"`);
      expect(toml).toContain("[mcp_servers.uitest-phone]");
      expect(toml).toContain(`args = ["uitest-sdk", "mcp"]`);
      // Codex reads the cross-runtime directory, so only that copy is needed.
      expect(result.skill?.dirs).toEqual([join(dir, ".agents", "skills", "uitest-phone")]);
    });
  });

  it("registers Gemini's settings without disturbing the rest", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, ".gemini"), { recursive: true });
      await writeFile(join(dir, ".gemini", "settings.json"), `{\n  "theme": "dark"\n}\n`);
      const result = await connectAgent({
        agent: "gemini",
        home: dir,
        entry: { command: "npx", args: ["uitest-sdk", "mcp"] },
      });
      expect(result.registered.changed).toBe(true);
      const settings = JSON.parse(await readFile(join(dir, ".gemini", "settings.json"), "utf8"));
      expect(settings.theme).toBe("dark");
      expect(settings.mcpServers["uitest-phone"]).toEqual({ command: "npx", args: ["uitest-sdk", "mcp"] });
      expect(result.skill?.dirs).toEqual([join(dir, ".agents", "skills", "uitest-phone")]);
    });
  });

  it("writes the Copilot CLI local-server shape", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, ".copilot"), { recursive: true });
      await writeFile(
        join(dir, ".copilot", "mcp-config.json"),
        `${JSON.stringify({ mcpServers: { other: { type: "local", command: "other" } } }, null, 2)}\n`,
      );
      const result = await connectAgent({
        agent: "copilot",
        home: dir,
        entry: { command: "npx", args: ["uitest-sdk", "mcp"] },
      });
      expect(result.registered.changed).toBe(true);
      const config = JSON.parse(await readFile(join(dir, ".copilot", "mcp-config.json"), "utf8"));
      // Copilot requires type "local" and exposes only the listed tools.
      expect(config.mcpServers["uitest-phone"]).toEqual({
        type: "local",
        command: "npx",
        args: ["uitest-sdk", "mcp"],
        env: {},
        tools: ["*"],
      });
      expect(config.mcpServers.other).toEqual({ type: "local", command: "other" });
      expect(result.skill?.dirs).toEqual([join(dir, ".agents", "skills", "uitest-phone")]);
    });
  });

  it("reports a no-op for a second Copilot run", async () => {
    await withDir(async (dir) => {
      const opts = {
        agent: "copilot" as const,
        home: dir,
        entry: { command: "npx", args: ["uitest-sdk", "mcp"] },
      };
      await connectAgent(opts);
      const again = await connectAgent(opts);
      expect(again.registered.changed).toBe(false);
      expect(again.skillKept).toMatch(/already/);
    });
  });

  it("reports a no-op when everything is already in place", async () => {
    await withDir(async (dir) => {
      const opts = { agent: "claude" as const, home: dir, entry: { command: "npx", args: ["uitest-sdk", "mcp"] } };
      await connectAgent(opts);
      const again = await connectAgent(opts);
      expect(again.registered.changed).toBe(false);
      expect(again.skill).toBeNull();
      expect(again.skillKept).toMatch(/already/);
    });
  });
});
