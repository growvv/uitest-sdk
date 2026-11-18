import { randomBytes } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { LeaseHeldError } from "../transport/errors.js";

export interface LeaseInfo {
  task: string;
  token: string;
  pid: number;
  host: string;
  since: number;
  heartbeatAt: number;
  /**
   * Set when a person holds the device (`uitest-phone hold`).
   *
   * A hold has no owning process: the command writes the lease and exits, and
   * the person keeps the phone until they run `resume`. Judging it by pid
   * would make every agent command steal the device back immediately.
   */
  hold?: true;
  /**
   * Why a person was asked to take the phone (`uitest-phone handoff`).
   *
   * A hold outlives the call that created it, so this is what a later reader
   * (the person, or another agent that gets `lease_held`) has to go on.
   */
  reason?: string;
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
  /** Mark this lease as a person's hold, so pid liveness does not apply. */
  hold?: boolean;
  /** What the person was asked to do; shown in `lease_held`. */
  reason?: string;
  /**
   * Take the device even from a live task.
   *
   * Only `uitest-phone hold` sets this. A person saying "I have the phone now"
   * is the one case where a running task must lose the device; the task finds
   * out on its next command (`Session.assertLease`) and stops with
   * `lease_held`, which is the same outcome as if it had run afterwards.
   */
  force?: boolean;
}

/** Reads a lock file; null when absent or unreadable. */
export async function readLease(path: string): Promise<LeaseInfo | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LeaseInfo>;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.task !== "string") return null;
    const info: LeaseInfo = {
      task: parsed.task,
      token: parsed.token,
      pid: Number(parsed.pid ?? 0),
      host: String(parsed.host ?? ""),
      since: Number(parsed.since ?? 0),
      heartbeatAt: Number(parsed.heartbeatAt ?? 0),
    };
    if (parsed.hold === true) info.hold = true;
    if (typeof parsed.reason === "string" && parsed.reason) info.reason = parsed.reason;
    return info;
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
 *
 * The pid alone is not enough, because a pid outlives its process: Windows and
 * Linux both hand a dead process's pid to the next one, so a killed task's
 * lock names a pid that is alive again. That is not hypothetical — a killed
 * `mcp` session wedged a device this way for hours, its pid reused by an
 * unrelated console, with `lease_held` telling the next person to wait for a
 * heartbeat that never came. So the lease heartbeats while it is held (see
 * `startHeartbeat`), and silence past `staleMs` is abandonment on any host. A
 * gone pid is still the fast path: it frees the device at once instead of
 * after the window.
 */
export class Lease {
  readonly info: LeaseInfo;
  readonly staleMs: number;
  private readonly path: string;
  private readonly now: () => number;
  private released = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(info: LeaseInfo, path: string, now: () => number, staleMs: number) {
    this.info = info;
    this.path = path;
    this.now = now;
    this.staleMs = staleMs;
    this.startHeartbeat();
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
      // One line: the reason is appended to a status line in `lease_held`.
      const reason = String(opts.reason ?? "").replace(/\s+/g, " ").trim();
      const info: LeaseInfo = {
        task: String(opts.task ?? "").trim() || "task",
        token,
        pid,
        host,
        since: at,
        heartbeatAt: at,
      };
      if (opts.hold) info.hold = true;
      if (reason) info.reason = reason;
      try {
        // `wx` is the atomic part: exactly one process creates the file.
        const handle = await open(opts.path, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(info)}\n`);
        } finally {
          await handle.close();
        }
        return new Lease(info, opts.path, now, staleMs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }

      const current = await readLease(opts.path);
      if (!current) {
        // Corrupt or half-written: remove and retry once.
        await unlink(opts.path).catch(() => undefined);
        continue;
      }
      // A re-entry is the same process coming back, not merely a task with the
      // same name: every `live` page calls its task "live", and matching on the
      // name alone let two processes both hold the device. The name is a label
      // for `lease_held`; the pid is the identity.
      //
      // A hold is the exception, because it has no owning process: `hold` and
      // `resume` are separate commands run from separate shells, so the pid
      // that wrote it is gone by the time it is released. Requiring a pid
      // match there made `resume` refuse the very lease it exists to release.
      const reentry =
        current.task === info.task &&
        current.host === host &&
        (current.hold ? info.hold === true : current.pid === pid);
      if (reentry) {
        // A handoff that asks again is the exception: the person may now need
        // a different step, and the reason is the message they are acting on.
        if (info.reason && current.hold && current.reason !== info.reason) {
          const next = { ...current, reason: info.reason };
          await writeFile(opts.path, `${JSON.stringify(next)}\n`);
          return new Lease(next, opts.path, now, staleMs);
        }
        return new Lease(current, opts.path, now, staleMs);
      }
      const sameHost = current.host === host;
      // A hold belongs to a person, not to a process: it has no pid to check
      // and lasts until `resume`, so it is never stale on this host.
      const processGone = sameHost && !current.hold && !alive(current.pid);
      // The clock, not the pid, is what a reused pid cannot fake: a held lease
      // refreshes its heartbeat, so silence past `staleMs` means nobody is
      // working, on this host or another.
      const abandoned = !current.hold && at - current.heartbeatAt > staleMs;
      if (!opts.force && !processGone && !abandoned) {
        throw new LeaseHeldError(
          `lease_held · this device already runs task "${current.task}"` +
            (current.hold
              ? `\nA person is using the phone${current.reason ? ` (the agent asked: ${current.reason})` : ""}. Stop and wait; they will run \`uitest-phone resume\`.`
              : `\nIf that task is gone, remove ${opts.path} or wait for its heartbeat to expire.`),
          "ELEASE",
        );
      }
      // Stale, or a person's forced takeover: replace the contents. A
      // concurrent stealer may win; the retry loop reads the file again and
      // either yields or sees the new owner.
      await writeFile(opts.path, `${JSON.stringify(info)}\n`);
      const confirmed = await readLease(opts.path);
      if (confirmed?.token === token) return new Lease(info, opts.path, now, staleMs);
    }
    throw new LeaseHeldError("lease_held · another task took the device while acquiring", "ELEASE");
  }

  /**
   * Re-checks that this lease still owns the device, and takes it again when
   * nobody else does.
   *
   * A long-lived session (`mcp`) holds one lease for its whole life, so a
   * person's `hold` would otherwise be invisible to it: the person's command
   * replaces the lock file, and the session would keep driving the phone.
   * Called before every command. Throws `LeaseHeldError` with the holder's
   * reason when the device moved; after `resume` removed the hold, the same
   * session takes the device again under its own task and continues.
   */
  async reacquire(): Promise<void> {
    const fresh = await Lease.acquire({
      path: this.path,
      task: this.info.task,
      staleMs: this.staleMs,
      now: this.now,
      hold: this.info.hold,
    });
    // The fresh lease started its own interval in the constructor; this object
    // keeps the identity, so it keeps the one timer.
    fresh.stopHeartbeat();
    Object.assign(this.info, fresh.info);
    this.released = false;
    this.startHeartbeat();
  }

  /** Refreshes the heartbeat. Nothing changes if another task has taken over. */
  async heartbeat(): Promise<void> {
    const current = await readLease(this.path);
    if (!current || current.token !== this.info.token) return;
    const next: LeaseInfo = { ...current, heartbeatAt: this.now() };
    await writeFile(this.path, `${JSON.stringify(next)}\n`);
    Object.assign(this.info, next);
  }

  /**
   * Keeps the heartbeat fresh while this lease is held.
   *
   * Half the staleness window, so one late tick does not look like death. The
   * interval is `unref`'d: it must never be the reason a process stays alive,
   * and a one-command CLI that forgets to release still exits on its own.
   */
  private startHeartbeat(): void {
    if (this.timer) return;
    const every = Math.max(50, Math.floor(this.staleMs / 2));
    this.timer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, every);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Releases the lock, but only when this lease still owns it. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopHeartbeat();
    const current = await readLease(this.path);
    if (current?.token === this.info.token) {
      await unlink(this.path).catch(() => undefined);
    }
  }
}
