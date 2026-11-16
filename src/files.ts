import type { HdcRunner } from "./hdc.js";
import { UitestError } from "./errors.js";
import { shellQuote } from "./util/shell.js";

/** One entry as `ls -l` prints it. */
export interface FileEntry {
  name: string;
  /** The path the entry was listed from, with its name appended. */
  path: string;
  size: number;
  isDir: boolean;
  mode: string;
  /** Date and time exactly as the device printed them. */
  mtime: string;
}

const LINE_RE = /^([dl-][rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+)\s+(.+)$/;
const DEFAULT_READ = 1024 * 1024;
const MAX_READ = 64 * 1024 * 1024;

function parseLine(line: string, dir: string): FileEntry | null {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  const name = m[4]!.trim();
  if (!name) return null;
  const path = name.startsWith("/")
    ? name
    : `${dir.replace(/\/+$/, "")}/${name}`;
  return {
    name,
    path,
    size: Number(m[2]),
    isDir: m[1]!.startsWith("d"),
    mode: m[1]!,
    mtime: m[3]!,
  };
}

/**
 * The device's filesystem, through hdc.
 *
 * Deliberately thin: every method is one shell command or one `file send` /
 * `file recv`. Paths are quoted for the device shell, so spaces and quotes are
 * safe. `remove` is the only destructive call and it refuses the empty path
 * and `/`; everything else is the caller's business.
 */
export class Files {
  constructor(private readonly hdc: HdcRunner) {}

  /** `ls -l <dir>`; a file path yields that one entry. */
  async list(path: string): Promise<FileEntry[]> {
    const out = await this.hdc.shell(`ls -l ${shellQuote(path)}`);
    const entries: FileEntry[] = [];
    for (const line of out.split(/\r?\n/)) {
      const entry = parseLine(line, path);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** The entry for one path, or null when it is missing or unreadable. */
  async stat(path: string): Promise<FileEntry | null> {
    try {
      const out = await this.hdc.shell(`ls -l ${shellQuote(path)}`);
      for (const line of out.split(/\r?\n/)) {
        const entry = parseLine(line, path);
        if (entry) return entry;
      }
      return null;
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  /** Creates a directory; parents are created by default. */
  async mkdir(path: string, opts: { parents?: boolean } = {}): Promise<void> {
    const flag = opts.parents === false ? "" : "-p ";
    await this.hdc.shell(`mkdir ${flag}${shellQuote(path)}`);
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed || trimmed === "/") {
      throw new UitestError(`refusing to remove ${JSON.stringify(path)}`, "EBADARG");
    }
    const flag = opts.recursive ? "-rf" : "-f";
    await this.hdc.shell(`rm ${flag} ${shellQuote(path)}`);
  }

  async move(from: string, to: string): Promise<void> {
    await this.hdc.shell(`mv ${shellQuote(from)} ${shellQuote(to)}`);
  }

  /** Sends a local file to the device (`hdc file send`). */
  async push(local: string, remote: string): Promise<void> {
    await this.hdc.push(local, remote);
  }

  /** Pulls a device file to the local path (`hdc file recv`). */
  async pull(remote: string, local: string): Promise<void> {
    await this.hdc.pull(remote, local);
  }

  /**
   * Reads a text file, capped at `maxBytes` (default 1 MiB, hard cap 64 MiB).
   * `cat` on an unbounded file is how a helper turns into an out-of-memory.
   */
  async readText(path: string, maxBytes = DEFAULT_READ): Promise<string> {
    const cap = Math.min(MAX_READ, Math.max(1, Math.floor(maxBytes)));
    return this.hdc.shell(`head -c ${cap} ${shellQuote(path)}`);
  }
}
