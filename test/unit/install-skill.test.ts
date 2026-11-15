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

  it("overwrites with force", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skill");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), "mine\n");
      await installSkill({ dir: target, force: true });
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("name: uitest-phone");
    });
  });

  it("defaults to the agent skills directory", async () => {
    await withDir(async (dir) => {
      const result = await installSkill({ home: dir });
      expect(result.dir).toBe(join(dir, ".claude", "skills", "uitest-phone"));
      expect((await stat(join(result.dir, "SKILL.md"))).isFile()).toBe(true);
    });
  });
});
