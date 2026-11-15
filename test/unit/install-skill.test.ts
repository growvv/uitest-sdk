import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSkill,
  refreshSkill,
  skillFiles,
  SKILL_MARKER,
  type SkillFile,
} from "../../src/install-skill.js";
import { VERSION } from "../../src/version.js";

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

  it("records the version and file digests so an upgrade can recognise its own copy", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skill");
      await installSkill({ dir: target });
      const marker = JSON.parse(await readFile(join(target, SKILL_MARKER), "utf8"));
      expect(marker.package).toBe("uitest-sdk");
      expect(marker.version).toBe(VERSION);
      const skill = skillFiles().find((f) => f.path === "SKILL.md")!;
      expect(marker.files["SKILL.md"]).toBe(digest(skill.content));
    });
  });
});

const OLD_FILES: SkillFile[] = [
  { path: "SKILL.md", content: "---\nname: uitest-phone\n---\nold skill\n" },
  { path: "REFERENCE.md", content: "old reference\n" },
];

const NEW_FILES: SkillFile[] = [
  { path: "SKILL.md", content: "---\nname: uitest-phone\n---\nnew skill\n" },
  { path: "REFERENCE.md", content: "new reference\n" },
];

function digest(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function marker(files: SkillFile[], version: string) {
  return {
    package: "uitest-sdk",
    version,
    files: Object.fromEntries(files.map((f) => [f.path, digest(f.content)])),
  };
}

async function plantSkill(dir: string, files: SkillFile[], record?: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file.path), file.content);
  if (record) await writeFile(join(dir, SKILL_MARKER), JSON.stringify(record));
}

describe("refreshSkill", () => {
  it("updates a copy this package installed from an older version", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      await plantSkill(target, OLD_FILES, marker(OLD_FILES, "0.0.1"));

      const result = await refreshSkill({ dirs: [target], files: NEW_FILES, version: "9.9.9" });

      expect(result.updated).toEqual([target]);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(NEW_FILES[0]!.content);
      expect(await readFile(join(target, "REFERENCE.md"), "utf8")).toBe(NEW_FILES[1]!.content);
      const record = JSON.parse(await readFile(join(target, SKILL_MARKER), "utf8"));
      expect(record.version).toBe("9.9.9");
      expect(record.files["SKILL.md"]).toBe(digest(NEW_FILES[0]!.content));
    });
  });

  it("does nothing when the installed copy is already this version", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      await plantSkill(target, OLD_FILES, marker(OLD_FILES, "9.9.9"));

      const result = await refreshSkill({ dirs: [target], files: NEW_FILES, version: "9.9.9" });

      expect(result.updated).toEqual([]);
      expect(result.current).toEqual([target]);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(OLD_FILES[0]!.content);
    });
  });

  it("leaves a copy the person edited alone", async () => {
    // The marker proves the copy was ours, and the digest proves it no longer
    // is: the person changed a file after installing it. An upgrade must not
    // throw that work away; --force is how they ask for the package's version.
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      await plantSkill(target, OLD_FILES, marker(OLD_FILES, "0.0.1"));
      await writeFile(join(target, "SKILL.md"), "---\nname: uitest-phone\n---\nmy notes\n");

      const result = await refreshSkill({ dirs: [target], files: NEW_FILES, version: "9.9.9" });

      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([{ dir: target, reason: "modified" }]);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("my notes");
      expect(await readFile(join(target, "REFERENCE.md"), "utf8")).toBe(OLD_FILES[1]!.content);
    });
  });

  it("leaves a hand-written skill alone", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      await plantSkill(target, [{ path: "SKILL.md", content: "mine\n" }]);

      const result = await refreshSkill({ dirs: [target], files: NEW_FILES, version: "9.9.9" });

      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([{ dir: target, reason: "unmanaged" }]);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("mine\n");
    });
  });

  it("adopts an unmarked copy whose files are exactly what 0.3.0 shipped", async () => {
    // 0.3.0 installed the skill before the marker existed. An exact digest
    // match is the only safe proof the person did not edit it.
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      await plantSkill(target, OLD_FILES);

      const result = await refreshSkill({
        dirs: [target],
        files: NEW_FILES,
        version: "9.9.9",
        legacy: Object.fromEntries(OLD_FILES.map((f) => [f.path, digest(f.content)])),
      });

      expect(result.updated).toEqual([target]);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(NEW_FILES[0]!.content);
    });
  });

  it("restores a file that went missing from a copy it owns", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "skills", "uitest-phone");
      await plantSkill(target, OLD_FILES, marker(OLD_FILES, "0.0.1"));
      await rm(join(target, "REFERENCE.md"));

      const result = await refreshSkill({ dirs: [target], files: NEW_FILES, version: "9.9.9" });

      expect(result.updated).toEqual([target]);
      expect(await readFile(join(target, "REFERENCE.md"), "utf8")).toBe(NEW_FILES[1]!.content);
    });
  });

  it("never installs into a directory with no skill", async () => {
    // Refresh is an upgrade, not an install; `install-skill` is the command
    // that puts a skill where none was.
    await withDir(async (dir) => {
      const target = join(dir, "missing");
      const result = await refreshSkill({ dirs: [target], files: NEW_FILES, version: "9.9.9" });
      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([{ dir: target, reason: "missing" }]);
      await expect(stat(target)).rejects.toThrow();
    });
  });
});
