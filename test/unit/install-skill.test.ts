import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, skillFiles } from "../../src/install-skill.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-skill-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skillFiles", () => {
  it("returns the skill's files with their content", () => {
    const files = skillFiles();
    const names = files.map((f) => f.path);
    expect(names).toContain("SKILL.md");
    expect(names).toContain("REFERENCE.md");
    for (const file of files) {
      expect(file.content.length).toBeGreaterThan(200);
    }
  });

  it("describes the CLI the package actually ships", () => {
    const skill = skillFiles().find((f) => f.path === "SKILL.md")!;
    // `npx` resolves the *package* name; the binary is `uitest-phone`.
    expect(skill.content).toContain("npx uitest-sdk");
    expect(skill.content).toContain("uitest-phone");
    // The skill must not tell an agent to drive the SDK or raw hdc itself.
    expect(skill.content).toMatch(/do not write ad-hoc scripts/i);
  });
});

describe("installSkill", () => {
  it("writes the files into a fresh directory", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      const result = await installSkill({ dir: target });
      expect(result.written).toContain(join(target, "SKILL.md"));
      const text = await readFile(join(target, "SKILL.md"), "utf8");
      expect(text).toContain("name: uitest-phone");
    });
  });

  it("refuses to overwrite without force", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skill");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), "mine\n");
      await expect(installSkill({ dir: target })).rejects.toThrow(/already exists/);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("mine\n");
    });
  });

  it("refuses before writing any copy when one already exists", async () => {
    // Half an install is worse than none: the agent that reads the other
    // directory would get a skill whose commands the package does not have.
    await withDir(async (dir) => {
      const claude = join(dir, ".claude", "skills", "uitest-phone");
      await mkdir(claude, { recursive: true });
      await writeFile(join(claude, "SKILL.md"), "mine\n");
      await expect(installSkill({ home: dir })).rejects.toThrow(/already exists/);
      await expect(stat(join(dir, ".agents", "skills", "uitest-phone"))).rejects.toThrow();
      expect(await readFile(join(claude, "SKILL.md"), "utf8")).toBe("mine\n");
    });
  });

  it("overwrites with force", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skill");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), "mine\n");
      await installSkill({ dir: target, force: true });
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("name: uitest-phone");
    });
  });

  it("writes both the Claude Code and the cross-runtime skills directory", async () => {
    // `~/.claude/skills` is Claude Code's; `~/.agents/skills` is the alias
    // Codex, Copilot CLI and Gemini CLI read (agentskills.io). Writing only the
    // first left those runtimes without the skill the package ships.
    await withDir(async (dir) => {
      const result = await installSkill({ home: dir });
      expect(result.dir).toBe(join(dir, ".claude", "skills", "uitest-phone"));
      expect(result.dirs).toEqual([
        join(dir, ".claude", "skills", "uitest-phone"),
        join(dir, ".agents", "skills", "uitest-phone"),
      ]);
      for (const target of result.dirs) {
        expect((await stat(join(target, "SKILL.md"))).isFile()).toBe(true);
        expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("name: uitest-phone");
      }
    });
  });

  it("writes only the directory the caller named", async () => {
    // An explicit --dir is a deliberate target; adding a second copy there
    // would put files somewhere the caller did not ask for.
    await withDir(async (dir) => {
      const target = join(dir, "one");
      const result = await installSkill({ dir: target });
      expect(result.dirs).toEqual([target]);
      await expect(stat(join(dir, ".agents"))).rejects.toThrow();
    });
  });
});
