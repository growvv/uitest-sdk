import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UitestError } from "./errors.js";

export interface SkillFile {
  /** Path relative to the skill directory. */
  path: string;
  content: string;
}

export interface InstallSkillOptions {
  /** Target directory. Defaults to `<home>/.claude/skills/uitest-phone`. */
  dir?: string;
  /** Home directory override, for tests. */
  home?: string;
  /** Overwrite an existing installation. */
  force?: boolean;
}

export interface InstallSkillResult {
  dir: string;
  written: string[];
}

/**
 * The files that ship with the package. Both live under `assets/skill/`, which
 * is one level above `src/` and `dist/`, so the same lookup works from source
 * and from an installed package.
 */
function assetDir(): string {
  return fileURLToPath(new URL("../assets/skill", import.meta.url));
}

const SKILL_FILES = ["SKILL.md", "REFERENCE.md"] as const;

/** Reads the bundled skill files. */
export function skillFiles(): SkillFile[] {
  const dir = assetDir();
  return SKILL_FILES.map((name) => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      throw new UitestError(`bundled skill file is missing: ${path}`, "ENOSKILL");
    }
    // readFileSync keeps skillFiles usable from a synchronous CLI path.
    return { path: name, content: readFileSync(path, "utf8") };
  });
}

/**
 * Installs the bundled skill into an agent's skills directory.
 *
 * The skill and the CLI are shipped together on purpose: the instructions name
 * exactly the commands this package implements, and a skill copied from a
 * different version would teach calls that do not exist.
 */
export async function installSkill(opts: InstallSkillOptions = {}): Promise<InstallSkillResult> {
  const dir = opts.dir ?? join(opts.home ?? homedir(), ".claude", "skills", "uitest-phone");
  const existing = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const skillMd = join(dir, "SKILL.md");
  if (!opts.force && existing && existsSync(skillMd)) {
    throw new UitestError(
      `${skillMd} already exists; pass --force to replace it`,
      "ESKILLEXISTS",
    );
  }
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const file of skillFiles()) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    written.push(path);
  }
  return { dir, written };
}
