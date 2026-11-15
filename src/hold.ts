import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Lease, readLease } from "./lease.js";
import { tagOf } from "./session.js";
import { HdcRunner } from "./hdc.js";

/**
 * The task name a hold records.
 *
 * It is what an agent sees in `lease_held`, so it has to read as a reason, not
 * as another agent's task id: "this device already runs task 'held by a
 * person'" tells the agent to stop and ask. A hold that recorded the person's
 * own task name would look like a competing agent, and an agent that waits for
 * a competing agent is exactly the failure this prevents.
 */
export const HOLD_TASK = "held by a person";

export interface HoldOptions {
  /** Directory holding traces, leases and refs. */
  stateDir: string;
  /** The device tag the lease is filed under. */
  tag: string;
  /** A hold older than this without a heartbeat is ignored. */
  staleMs?: number;
}

export interface HoldResult {
  /** Where the lock lives, so the person can remove it by hand if needed. */
  path: string;
  token: string;
  task: string;
  /** The task this hold took the device from, when one was running. */
  tookOverFrom?: string;
}

function lockPath(stateDir: string, tag: string): string {
  return join(stateDir, "leases", `${tag}.lock`);
}

/**
 * Gives the device to a person.
 *
 * There is no device-side signal for "a human is touching the screen" that
 * this SDK can rely on: the extension's UI-action stream closes the session
 * when it stops and wedges the daemon, and it reports injected input as if it
 * were a finger. So a takeover is explicit: the person runs `hold`, which
 * takes the same lease an agent task takes. Every agent command then stops at
 * `lease_held` before it reads the screen, and the person runs `resume` when
 * they are done.
 *
 * This is the cooperative half of the safety story: an agent cannot take the
 * phone back until the person hands it over.
 *
 * It preempts a running task (`force`). The alternative — refusing while an
 * agent session is open — would make takeover impossible in exactly the mode
 * agents use: `uitest-phone mcp` holds one lease for the life of the process.
 * The task is not stopped mid-gesture; it finds out on its next command.
 */
export async function holdDevice(opts: HoldOptions): Promise<HoldResult> {
  const path = lockPath(opts.stateDir, opts.tag);
  await mkdir(join(opts.stateDir, "leases"), { recursive: true });
  const current = await readLease(path);
  const lease = await Lease.acquire({
    path, task: HOLD_TASK, staleMs: opts.staleMs, hold: true, force: true,
  });
  const tookOverFrom = current && !current.hold ? current.task : undefined;
  return { path, token: lease.info.token, task: lease.info.task, ...(tookOverFrom ? { tookOverFrom } : {}) };
}

/**
 * Hands the device back.
 *
 * Returns false rather than throwing when the device is free or when the lease
 * belongs to another task: `resume` must never end a task it did not start.
 */
export async function resumeDevice(opts: HoldOptions): Promise<boolean> {
  const path = lockPath(opts.stateDir, opts.tag);
  const current = await readLease(path);
  if (!current || current.task !== HOLD_TASK) return false;
  const lease = await Lease.acquire({ path, task: HOLD_TASK, staleMs: opts.staleMs, hold: true });
  await lease.release();
  return true;
}

/** The lease currently on the device, for `hold --status`. */
export function readHold(opts: HoldOptions) {
  return readLease(lockPath(opts.stateDir, opts.tag));
}

/**
 * The tag the lease for the attached device is filed under.
 *
 * `hold` runs without a session (a session would take the very lease it is
 * trying to take), so it resolves the device id from hdc and hashes it the same
 * way `Session` does. Passing `--device` skips the lookup.
 */
export async function resolveTag(deviceId?: string, hdc?: HdcRunner): Promise<string> {
  if (deviceId) return tagOf(deviceId);
  const runner = hdc ?? new HdcRunner({});
  const targets = await runner.listTargets();
  const real = targets.filter((t) => t && !t.startsWith("["));
  if (real.length === 0) {
    throw new Error("no hdc target attached; connect a device or pass --device <id>");
  }
  if (real.length > 1) {
    throw new Error(
      `multiple targets attached (${real.map(tagOf).join(", ")}): pass --device <id>`,
    );
  }
  return tagOf(real[0]);
}
