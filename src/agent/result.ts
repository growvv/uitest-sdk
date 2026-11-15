import type { Diff, Screen } from "./screen.js";

/**
 * The result of one agent-facing step.
 *
 * Transport and programming failures throw `UitestError`. Everything that is a
 * *task* outcome is a status, so a caller never has to parse an exception
 * string to learn whether the screen changed, the element vanished, or a
 * person has to approve.
 */
export type ActionStatus =
  | "settled"
  | "uncertain"
  | "not_found"
  | "blocked"
  | "approval_pending"
  | "approval_denied"
  | "stale"
  | "lease_held"
  | "handoff"
  | "device_locked"
  | "device_needs_setup"
  | "device_offline";

interface Base {
  /** Screen after the step; null only when the step could not observe one. */
  screen: Screen | null;
  diff?: Diff;
  step?: number;
  /** Screenshot saved for this step, when tracing is on. */
  shot?: string | null;
}

export type ActionResult =
  | (Base & { status: "settled" })
  /** The action ran but the UI never settled: it may or may not have taken effect. */
  | (Base & { status: "uncertain"; reason: string })
  /** Nothing matching the selector or ref was on screen. */
  | (Base & { status: "not_found"; query: string })
  /** Policy refused before the device was touched. */
  | (Base & { status: "blocked"; rule: string; reason: string })
  /** A person must approve this exact step. */
  | (Base & { status: "approval_pending"; approvalId: string; rule: string; reason: string })
  | (Base & { status: "approval_denied"; reason: string })
  /** The screen changed while an approval was pending. */
  | (Base & { status: "stale"; reason: string })
  /** Another task holds this device. */
  | (Base & { status: "lease_held"; task: string })
  /** The agent handed the device to a person for a step only they can do. */
  | (Base & { status: "handoff"; task: string; reason: string })
  /** The screen is the system lock screen; only a person can unlock it. */
  | (Base & { status: "device_locked" })
  /** The phone is attached but has not authorized this computer for debugging. */
  | (Base & { status: "device_needs_setup" })
  /** No usable hdc target: unplugged, switched off, or still connecting. */
  | (Base & { status: "device_offline" });

/** Process exit code for a status; shared by the CLI and any other wrapper. */
export const EXIT_CODE: Record<ActionStatus, number> = {
  settled: 0,
  uncertain: 1,
  not_found: 1,
  lease_held: 2,
  approval_pending: 3,
  blocked: 4,
  approval_denied: 4,
  stale: 4,
  // The device is not the caller's until the person runs `resume`, which is
  // the same situation as `lease_held`: stop, do not retry.
  handoff: 2,
  // A person has to unlock, authorize or plug in the phone. Retrying the same
  // command cannot change any of these, so they share the "stop" code.
  device_locked: 2,
  device_needs_setup: 2,
  device_offline: 2,
};

export function statusOf(result: ActionResult): number {
  return EXIT_CODE[result.status] ?? 1;
}

export function isOk(result: ActionResult): boolean {
  return result.status === "settled";
}

/** `status · detail` — the first line every renderer prints. */
export function actionText(result: ActionResult): string {
  switch (result.status) {
    case "settled":
      return "settled";
    case "uncertain":
      return `uncertain · ${result.reason}`;
    case "not_found":
      return `not_found · ${result.query}`;
    case "blocked":
      return `blocked_by_policy · rule: ${result.rule}\n${result.reason}`;
    case "approval_pending":
      return `approval_pending · approval_id: ${result.approvalId} · rule: ${result.rule}\n${result.reason}`;
    case "approval_denied":
      return `approval_denied · ${result.reason}`;
    case "stale":
      return `stale · ${result.reason}`;
    case "lease_held":
      return `lease_held · this device already runs task "${result.task}"`;
    case "handoff":
      return `handoff · the phone is with the person: ${result.reason}`;
    case "device_locked":
      return (
        "device_locked · the phone is on its lock screen. Ask the person to unlock it; " +
        "do not try a PIN, pattern or password."
      );
    case "device_needs_setup":
      return (
        "device_needs_setup · the phone has not authorized this computer for debugging. " +
        'Ask the person to unlock it and tap "Allow" on the USB debugging prompt.'
      );
    case "device_offline":
      return (
        "device_offline · no usable phone is attached. Ask the person to connect it by USB, " +
        "unlock it, and check that USB debugging is on."
      );
  }
}
