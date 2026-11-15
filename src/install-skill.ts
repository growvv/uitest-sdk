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
  /**
   * A single target directory. When omitted, the skill is written to both
   * agent skill directories below.
   */
  dir?: string;
  /** Home directory override, for tests. */
  home?: string;
  /**
   * An explicit set of directories, used when one agent reads a subset of
   * them. Takes precedence over `dir` and the defaults.
   */
  dirs?: string[];
  /** Overwrite an existing installation. */
  force?: boolean;
}

export interface InstallSkillResult {
  /** The first directory written; the one to report as "the" install. */
  dir: string;
  /** Every directory written, in the order written. */
  dirs: string[];
  written: string[];
}

/**
 * The directories an agent reads skills from.
 *
 * `~/.claude/skills` is Claude Code's. `~/.agents/skills` is the
 * cross-runtime alias ([agentskills.io](https://agentskills.io)) that Codex,
 * Copilot CLI and Gemini CLI read, so writing both is what makes one install
 * reach every runtime the package supports. A caller that names `dir` gets
 * exactly that directory — it is a deliberate target, not a default.
 */
export function defaultSkillDirs(home: string = homedir()): string[] {
  return [
    join(home, ".claude", "skills", "uitest-phone"),
    join(home, ".agents", "skills", "uitest-phone"),
  ];
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
  const dirs = opts.dirs ?? (opts.dir ? [opts.dir] : defaultSkillDirs(opts.home ?? homedir()));

  // Check every target before writing any of them. A half install is worse
  // than none: the agent reading the other directory would load a skill whose
  // commands this package does not have.
  if (!opts.force) {
    for (const dir of dirs) {
      const skillMd = join(dir, "SKILL.md");
      if (existsSync(skillMd)) {
        throw new UitestError(
          `${skillMd} already exists; pass --force to replace it`,
          "ESKILLEXISTS",
        );
      }
    }
  }

  const files = skillFiles();
  const written: string[] = [];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
      written.push(path);
    }
  }
  return { dir: dirs[0]!, dirs, written };
}
