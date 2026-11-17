/** `uitest-sdk/govern` — policy, approvals, leases, holds and traces. */
export { Policy, DEFAULT_CONFIRM, POLICY_WORDS, SYSTEM_CHROME } from "../governance/policy.js";
export type { PolicyOptions, PolicyCheck, Decision, Rule, ConfirmRule } from "../governance/policy.js";
export { Approvals, Grants } from "../governance/approvals.js";
export type {
  ApprovalOptions,
  ApprovalDecision,
  ApprovalScope,
  ApprovalStatus,
  ConsumeResult,
  DecisionResult,
  Grant,
  PendingApproval,
  RememberScope,
  StepIdentity,
} from "../governance/approvals.js";
export { Lease, readLease } from "../governance/lease.js";
export type { LeaseInfo, LeaseOptions } from "../governance/lease.js";
export {
  HOLD_TASK,
  handoffDevice,
  holdDevice,
  readHold,
  resolveTag,
  resumeDevice,
} from "../governance/hold.js";
export type { HandoffOptions, HoldOptions, HoldResult } from "../governance/hold.js";
export { TraceRecorder, deviceTag, readRecentTrace } from "../governance/trace.js";
export type { TaskReportResult, TraceEntry, TraceOptions, TraceRecord } from "../governance/trace.js";
