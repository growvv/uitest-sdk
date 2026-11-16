import type { HdcRunner } from "../hdc.js";

/** Parses `pidof` output. Multiple pids come back space-separated on one line. */
export function pids(output: string): Set<string> {
  return new Set(output.split(/\s+/).filter((t) => /^\d+$/.test(t)));
}

/**
 * Finds the pid whose argv carries `socketName`, from `ps -ef` output.
 *
 * `pidof` alone cannot say which of several new pids is ours: two clients
 * starting in the same window each see the other's daemon as a new pid. The
 * argv can — a grpc daemon is spawned with `-scrcpy_socket_name <name>` and a
 * ws daemon with `-p <port>` — so the socket or port is what identifies a
 * daemon, not the timing of its arrival.
 */
export function pidFor(ps: string, marker: string): string | null {
  for (const line of ps.split(/\r?\n/)) {
    if (!line.includes(marker)) continue;
    const pid = line.trim().split(/\s+/)[1];
    if (pid && /^\d+$/.test(pid)) return pid;
  }
  return null;
}

/**
 * Reads `ps -ef` and returns the daemon started with `marker` in its argv.
 *
 * Only this process is safe to kill later: a pid that appeared in the same
 * window but does not carry the marker belongs to somebody else, and killing
 * it makes two clients take turns killing each other's daemons.
 */
export async function ownDaemon(hdc: HdcRunner, marker: string): Promise<string | null> {
  return pidFor(await hdc.shell("ps -ef"), marker);
}
