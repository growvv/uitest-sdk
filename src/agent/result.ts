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
  | "lease_held";

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
  | (Base & { status: "lease_held"; task: string });

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
  }
}
