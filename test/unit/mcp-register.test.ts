import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJsonMcp, registerTomlMcp, isMcpRegistered } from "../../src/mcp-register.js";

const ENTRY = { command: "npx", args: ["-y", "uitest-sdk@0.2.0", "mcp"] };

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-mcpreg-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("registerJsonMcp", () => {
  it("creates the file when there is none", async () => {
    await withDir(async (dir) => {
      const file = join(dir, ".claude.json");
      const result = await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      expect(result).toMatchObject({ created: true, changed: true });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        mcpServers: { "uitest-phone": ENTRY },
      });
    });
  });

  it("adds its entry without touching the rest of the file", async () => {
    // The whole point of editing the file rather than printing JSON to paste:
    // the person's other servers, comments and key order must survive.
    await withDir(async (dir) => {
      const file = join(dir, "mcp.json");
      const before = `{
  // my own servers, in the order I like them
  "mcpServers": {
    "alpha": {"command": "alpha-server", "args": ["--fast"]},
    "zeta": {"command": "zeta-server", "args": []}
  },
  "theme": "dark"
}
`;
      await writeFile(file, before);
      await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      const after = await readFile(file, "utf8");
      expect(after).toContain("// my own servers, in the order I like them");
      expect(after).toContain(`"alpha": {"command": "alpha-server", "args": ["--fast"]}`);
      expect(after).toContain(`"zeta": {"command": "zeta-server", "args": []}`);
      expect(after).toContain(`"theme": "dark"`);
      // Comments, order and the inline formatting of the neighbours are intact.
      expect(after.indexOf('"alpha"')).toBeLessThan(after.indexOf('"zeta"'));
      expect(after.indexOf('"zeta"')).toBeLessThan(after.indexOf('"uitest-phone"'));
      const parsed = JSON.parse(after.replace(/^\s*\/\/.*$/gm, ""));
      expect(parsed.mcpServers["uitest-phone"]).toEqual(ENTRY);
      expect(parsed.theme).toBe("dark");
    });
  });

  it("adds the mcpServers key when the file has none", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "settings.json");
      await writeFile(file, `{\n  "editor": {"fontSize": 13}\n}\n`);
      await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      const after = await readFile(file, "utf8");
      expect(after).toContain(`"fontSize": 13`);
      expect(JSON.parse(after)).toEqual({
        editor: { fontSize: 13 },
        mcpServers: { "uitest-phone": ENTRY },
      });
    });
  });

  it("replaces only its own entry when it is already there", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "mcp.json");
      await writeFile(
        file,
        `{
  "mcpServers": {
    "uitest-phone": {"command": "uitest-phone", "args": ["mcp"]},
    "other": {"command": "keep", "args": ["me"]}
  }
}
`,
      );
      const result = await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      expect(result.changed).toBe(true);
      const after = await readFile(file, "utf8");
      expect(after).toContain(`"other": {"command": "keep", "args": ["me"]}`);
      expect(after).toContain("uitest-sdk@0.2.0");
      expect(after).not.toContain(`"args": ["mcp"]`);
    });
  });

  it("changes nothing when the entry is already right", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "mcp.json");
      await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      const first = await readFile(file, "utf8");
      const result = await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      expect(result.changed).toBe(false);
      expect(await readFile(file, "utf8")).toBe(first);
    });
  });

  it("refuses a file it cannot parse and leaves it alone", async () => {
    // Writing a repaired version would throw away whatever the person meant,
    // and a half-edited config is worse than a refusal that names the problem.
    await withDir(async (dir) => {
      const file = join(dir, "broken.json");
      const before = `{\n  "mcpServers": {oops\n}\n`;
      await writeFile(file, before);
      const err = await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY }).catch(
        (e: unknown) => e,
      );
      expect((err as Error).message).toMatch(/cannot parse/i);
      expect(await readFile(file, "utf8")).toBe(before);
    });
  });

  it("refuses when mcpServers is not an object", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "mcp.json");
      const before = `{"mcpServers": ["not", "an", "object"]}\n`;
      await writeFile(file, before);
      await expect(
        registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY }),
      ).rejects.toThrow(/not an object/);
      expect(await readFile(file, "utf8")).toBe(before);
    });
  });

  it("keeps a backup of the file it changed", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "mcp.json");
      await writeFile(file, `{"mcpServers": {}}\n`);
      const result = await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY, backup: true });
      expect(result.backup).toBeTruthy();
      expect(await readFile(result.backup!, "utf8")).toBe(`{"mcpServers": {}}\n`);
    });
  });
});

describe("registerTomlMcp", () => {
  it("appends its own section to a config with none", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "config.toml");
      const before = `model = "gpt-5"\n\n[profiles.fast]\nmodel = "o4-mini"\n`;
      await writeFile(file, before);
      await registerTomlMcp({ file, name: "uitest-phone", entry: ENTRY });
      const after = await readFile(file, "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain("[mcp_servers.uitest-phone]");
      expect(after).toContain(`command = "npx"`);
      expect(after).toContain(`args = ["-y", "uitest-sdk@0.2.0", "mcp"]`);
    });
  });

  it("replaces its own section and leaves the others byte for byte", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "config.toml");
      const before = `# my config\nmodel = "gpt-5"\n\n[mcp_servers.uitest-phone]\ncommand = "old"\nargs = []\n\n[profiles.fast]\nmodel = "o4-mini"\n`;
      await writeFile(file, before);
      await registerTomlMcp({ file, name: "uitest-phone", entry: ENTRY });
      const after = await readFile(file, "utf8");
      expect(after).toContain("# my config");
      expect(after).toContain(`[profiles.fast]\nmodel = "o4-mini"`);
      expect(after).not.toContain(`command = "old"`);
      expect(after).toContain(`command = "npx"`);
    });
  });

  it("changes nothing when the section is already right", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "config.toml");
      await registerTomlMcp({ file, name: "uitest-phone", entry: ENTRY });
      const first = await readFile(file, "utf8");
      const result = await registerTomlMcp({ file, name: "uitest-phone", entry: ENTRY });
      expect(result.changed).toBe(false);
      expect(await readFile(file, "utf8")).toBe(first);
    });
  });
});

describe("isMcpRegistered", () => {
  it("reports whether the JSON entry is present", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "mcp.json");
      expect(await isMcpRegistered({ file, name: "uitest-phone" })).toBe(false);
      await registerJsonMcp({ file, name: "uitest-phone", entry: ENTRY });
      expect(await isMcpRegistered({ file, name: "uitest-phone" })).toBe(true);
    });
  });

  it("reports false for a file that does not exist, without creating it", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "missing.json");
      expect(await isMcpRegistered({ file, name: "uitest-phone" })).toBe(false);
      await expect(stat(file)).rejects.toThrow();
    });
  });
});
