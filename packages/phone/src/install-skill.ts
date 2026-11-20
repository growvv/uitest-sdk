import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UitestError } from "uitest-sdk";
import { VERSION } from "./version.js";

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

/** The record written beside an installed skill, so an upgrade knows the copy is ours. */
export const SKILL_MARKER = ".uitest-skill.json";
/**
 * The package name the marker records.
 *
 * It is the product that owns the CLI the skill teaches, not the library the
 * product is built on: a skill installed by 0.9.4 said `uitest-sdk`, and an
 * upgrade adopts that marker rather than leaving the copy unmanaged.
 */
export const SKILL_PACKAGE = "uitest-phone";
const LEGACY_PACKAGES = new Set(["uitest-sdk"]);

/**
 * Line endings are normalised before hashing: the same skill checked out with
 * CRLF and installed from an LF package must count as the same content.
 */
function digest(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Digests of the two files 0.3.0 installed. That release predates the marker,
 * so an exact match is the only safe proof the copy is unmodified package
 * content; anything else is treated as the person's and left alone.
 */
const LEGACY_DIGESTS_0_3_0: Record<string, string> = {
  "SKILL.md": "4fa29d7dd3307ee65202b794fc9bd1fbee108993e9342c8a4f153eece02d0cef",
  "REFERENCE.md": "2ed37ad6b9b75785de1028040d2df097d80b040ddc825c02bd371b606ca9583f",
};

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
    // Last, so a crash mid-install never leaves a marker claiming files that
    // were not written. `refreshSkill` treats a markerless copy as unmanaged.
    await writeMarker(dir, VERSION, files);
  }
  return { dir: dirs[0]!, dirs, written };
}

/** One marker, written in the skill directory itself. */
interface SkillMarker {
  package?: unknown;
  version?: unknown;
  files?: unknown;
}

async function writeMarker(dir: string, version: string, files: SkillFile[]): Promise<void> {
  const record = {
    package: SKILL_PACKAGE,
    version,
    files: Object.fromEntries(files.map((file) => [file.path, digest(file.content)])),
  };
  await writeFile(join(dir, SKILL_MARKER), `${JSON.stringify(record, null, 2)}\n`);
}

function readMarker(dir: string): SkillMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SKILL_MARKER), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SkillMarker) : null;
  } catch {
    return null;
  }
}

/**
 * The recorded digests, or null when the marker is not a usable one of ours.
 *
 * `legacy` marks a file written by 0.9.4 and earlier, when the skill belonged
 * to the single `uitest-sdk` package. The digests still prove whether the
 * copy is ours; only the package name has to be migrated.
 */
function markerDigests(
  marker: SkillMarker | null,
): { digests: Record<string, string>; legacy: boolean } | null {
  if (!marker || typeof marker.version !== "string") return null;
  const pkg = String(marker.package ?? "");
  if (pkg !== SKILL_PACKAGE && !LEGACY_PACKAGES.has(pkg)) return null;
  if (!marker.files || typeof marker.files !== "object") return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(marker.files)) {
    if (typeof value === "string") out[name] = value;
  }
  return { digests: out, legacy: pkg !== SKILL_PACKAGE };
}

async function filesMatch(
  dir: string,
  files: SkillFile[],
  digests: Record<string, string>,
): Promise<boolean> {
  for (const file of files) {
    const path = join(dir, file.path);
    if (!existsSync(path)) return false;
    const text = await readFile(path, "utf8");
    if (digest(text) !== digests[file.path]) return false;
  }
  return true;
}

export interface RefreshSkillOptions {
  dirs?: string[];
  home?: string;
  /** This package's version; defaults to the running package's. */
  version?: string;
  /** The bundled files; tests supply their own. */
  files?: SkillFile[];
  /** Digests of a markerless install, when a test or a caller knows them. */
  legacy?: Record<string, string>;
}

export interface RefreshSkillResult {
  /** Directories rewritten to this version. */
  updated: string[];
  /** Directories already at this version. */
  current: string[];
  /** Directories left untouched, and why. */
  skipped: Array<{ dir: string; reason: "missing" | "unmanaged" | "modified" }>;
}

/**
 * Brings an installed skill forward after the package was upgraded.
 *
 * The skill and the CLI ship together, and a skill from another version names
 * commands this package may not have. `refreshSkill` rewrites only copies this
 * package wrote: a copy the person edited after installing is left alone
 * (`modified`), and so is a hand-written skill with no marker (`unmanaged`).
 * An exact match with 0.3.0's files is adopted, because that release installed
 * the skill before markers existed.
 *
 * This never installs into an empty directory: putting a skill where the agent
 * reads none is `install-skill`'s job, not an upgrade's.
 */
export async function refreshSkill(opts: RefreshSkillOptions = {}): Promise<RefreshSkillResult> {
  const dirs = opts.dirs ?? defaultSkillDirs(opts.home ?? homedir());
  const files = opts.files ?? skillFiles();
  const version = opts.version ?? VERSION;
  const legacy = opts.legacy ?? LEGACY_DIGESTS_0_3_0;
  const fresh = Object.fromEntries(files.map((file) => [file.path, digest(file.content)]));

  const result: RefreshSkillResult = { updated: [], current: [], skipped: [] };

  for (const dir of dirs) {
    if (!existsSync(join(dir, "SKILL.md")) && !existsSync(join(dir, SKILL_MARKER))) {
      result.skipped.push({ dir, reason: "missing" });
      continue;
    }

    const marker = readMarker(dir);
    const recorded = markerDigests(marker);
    let known = recorded?.digests;
    if (!known) {
      if (!(await filesMatch(dir, files, legacy))) {
        result.skipped.push({ dir, reason: "unmanaged" });
        continue;
      }
      known = legacy;
    } else if (!recorded!.legacy && marker?.version === version && (await filesMatch(dir, files, fresh))) {
      // Same version *and* the same bytes. The version alone is not enough: a
      // doc fix can ship in a build whose version was not bumped, and then the
      // agent keeps reading the text the fix replaced.
      result.current.push(dir);
      continue;
    }

    // A crash between writing the files and writing the marker leaves the new
    // content with an old marker; recognise that instead of wedging forever.
    if (await filesMatch(dir, files, fresh)) {
      await writeMarker(dir, version, files);
      result.updated.push(dir);
      continue;
    }

    // The marker says what was installed. A file that no longer matches was
    // edited by the person; refresh all or nothing so a half-updated skill
    // never teaches a mix of two versions.
    let edited = false;
    for (const file of files) {
      const path = join(dir, file.path);
      if (!existsSync(path)) continue; // a deleted file is restored below
      const text = await readFile(path, "utf8");
      if (digest(text) !== known[file.path]) {
        edited = true;
        break;
      }
    }
    if (edited) {
      result.skipped.push({ dir, reason: "modified" });
      continue;
    }

    for (const file of files) {
      await writeFile(join(dir, file.path), file.content);
    }
    await writeMarker(dir, version, files);
    result.updated.push(dir);
  }
  return result;
}
