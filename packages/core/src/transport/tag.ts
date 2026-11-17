import { createHash } from "node:crypto";

/**
 * A device serial never reaches a file or a line of output; only this does.
 *
 * One implementation for leases, traces, approvals and reports: two hashes over
 * the same serial would file the same device under two directories and make a
 * hold in one process invisible to another.
 */
export function tagOf(deviceId: string | null | undefined): string {
  if (!deviceId) return "nodevice";
  return createHash("sha1").update(String(deviceId)).digest("hex").slice(0, 8);
}

/** Historical name used by the trace module; kept as the same function. */
export const deviceTag = tagOf;
