import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The ref table as it survives a process: signature → ref number, plus the
 * next free number.
 */
export interface RefTable {
  next: number;
  refs: Record<string, number>;
}

/**
 * A ref table backed by a JSON file.
 *
 * Refs have to outlive the process that printed them: the CLI runs one command
 * per invocation, so a ref an agent saw from `observe` is only useful if the
 * next `tap` starts its builder from the same table. Without this, each command
 * would number elements from 1 again, and a ref could silently address a
 * different element.
 *
 * The file is deliberately small and forgiving. A missing or corrupt table is
 * treated as empty — refs are a convenience, and a stale file must never fail a
 * command that would otherwise work.
 */
export class FileRefStore {
  constructor(readonly path: string) {}

  load(): RefTable | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RefTable>;
      if (typeof parsed.next !== "number" || !parsed.refs || typeof parsed.refs !== "object") {
        return null;
      }
      return { next: parsed.next, refs: parsed.refs as Record<string, number> };
    } catch {
      return null;
    }
  }

  async save(table: RefTable): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(table));
  }
}
