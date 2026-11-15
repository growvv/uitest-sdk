import { randomBytes } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { LeaseHeldError } from "./errors.js";

export interface LeaseInfo {
  task: string;
  token: string;
  pid: number;
  host: string;
  since: number;
  heartbeatAt: number;
}

export interface LeaseOptions {
  /** Lock file path. One file per device tag. */
  path: string;
  /** What the lease is for, shown in `lease_held`. */
  task: string;
  /** A lease without a heartbeat for this long is considered abandoned. */
  staleMs?: number;
  /** Clock override, for tests. */
  now?: () => number;
  /** Process liveness check, for tests. */
  isAlive?: (pid: number) => boolean;
  pid?: number;
  host?: string;
}

/** Reads a lock file; null when absent or unreadable. */
export async function readLease(path: string): Promise<LeaseInfo | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LeaseInfo>;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.task !== "string") return null;
    return {
      task: parsed.task,
      token: parsed.token,
      pid: Number(parsed.pid ?? 0),
      host: String(parsed.host ?? ""),
      since: Number(parsed.since ?? 0),
      heartbeatAt: Number(parsed.heartbeatAt ?? 0),
    };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A cooperative lock on one device.
 *
 * The agent extension itself is not aware of tasks, and two agents driving one
 * phone interleave their gesturers — measured conflict rate 40–66%. The lease
 * makes that exclusion explicit: a second task gets `lease_held` before it
 * touches anything, instead of a corrupted screen halfway through.
 *
 * Liveness is a heartbeat plus the pid, not a TTL alone: a long task must be
 * allowed to hold the device forever, while a crashed one must not block it
 * for a fixed window.
 */
export class Lease {
  readonly info: LeaseInfo;
  private readonly path: string;
  private readonly now: () => number;
  private released = false;

  private constructor(info: LeaseInfo, path: string, now: () => number) {
    this.info = info;
    this.path = path;
    this.now = now;
  }

  static async acquire(opts: LeaseOptions): Promise<Lease> {
    const now = opts.now ?? Date.now;
    const alive = opts.isAlive ?? pidAlive;
    const host = opts.host ?? hostname();
    const staleMs = Math.max(1, opts.staleMs ?? 60_000);
    const pid = opts.pid ?? process.pid;

    for (let attempt = 0; attempt < 3; attempt++) {
      const at = now();
      const token = randomBytes(8).toString("hex");
      const info: LeaseInfo = {
        task: String(opts.task ?? "").trim() || "task",
        token,
        pid,
        host,
        since: at,
        heartbeatAt: at,
      };
      try {
        // `wx` is the atomic part: exactly one process creates the file.
        const handle = await open(opts.path, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(info)}\n`);
        } finally {
          await handle.close();
        }
        return new Lease(info, opts.path, now);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }

      const current = await readLease(opts.path);
      if (!current) {
        // Corrupt or half-written: remove and retry once.
        await unlink(opts.path).catch(() => undefined);
        continue;
      }
      if (current.task === info.task) {
        // Re-entering the same task is a no-op that keeps the original owner.
        return new Lease(current, opts.path, now);
      }
      const sameHost = current.host === host;
      const processGone = sameHost && !alive(current.pid);
      // A live process on this host keeps its lease even if its heartbeat is
      // late: it may be inside one long device call. A remote host can only be
      // judged by the clock.
      const abandonedHere = !sameHost && at - current.heartbeatAt > staleMs;
      if (!processGone && !abandonedHere) {
        throw new LeaseHeldError(
          `lease_held · this device already runs task "${current.task}"` +
            `\nIf that task is gone, remove ${opts.path} or wait for its heartbeat to expire.`,
          "ELEASE",
        );
      }
      // Stale: replace the contents. A concurrent stealer may win; the retry
      // loop reads the file again and either yields or sees the new owner.
      await writeFile(opts.path, `${JSON.stringify(info)}\n`);
      const confirmed = await readLease(opts.path);
      if (confirmed?.token === token) return new Lease(info, opts.path, now);
    }
    throw new LeaseHeldError("lease_held · another task took the device while acquiring", "ELEASE");
  }

  /** Refreshes the heartbeat. Nothing changes if another task has taken over. */
  async heartbeat(): Promise<void> {
    const current = await readLease(this.path);
    if (!current || current.token !== this.info.token) return;
    const next: LeaseInfo = { ...current, heartbeatAt: this.now() };
    await writeFile(this.path, `${JSON.stringify(next)}\n`);
    Object.assign(this.info, next);
  }

  /** Releases the lock, but only when this lease still owns it. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const current = await readLease(this.path);
    if (current?.token === this.info.token) {
      await unlink(this.path).catch(() => undefined);
    }
  }
}
