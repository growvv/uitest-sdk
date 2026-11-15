import { describe, it, expect } from "vitest";
import { statusOf, isOk, actionText, type ActionResult } from "../../src/agent/result.js";

const settled: ActionResult = {
  status: "settled",
  screen: null as never,
  diff: { mode: "diff", text: "", added: [], removed: [], changed: [] },
};

describe("ActionResult", () => {
  it("maps statuses to exit codes", () => {
    expect(statusOf(settled)).toBe(0);
    expect(statusOf({ ...settled, status: "uncertain", reason: "settle timeout" })).toBe(1);
    expect(statusOf({ ...settled, status: "not_found", query: "Save" })).toBe(1);
    expect(statusOf({ ...settled, status: "blocked", rule: "credentials", reason: "password" })).toBe(4);
    expect(statusOf({ ...settled, status: "approval_pending", approvalId: "ap_1", rule: "payments" })).toBe(3);
    expect(statusOf({ ...settled, status: "approval_denied", reason: "expired" })).toBe(4);
    expect(statusOf({ ...settled, status: "stale", reason: "screen changed" })).toBe(4);
    expect(statusOf({ ...settled, status: "lease_held", task: "other" })).toBe(2);
  });

  it("knows which statuses are terminal successes", () => {
    expect(isOk(settled)).toBe(true);
    expect(isOk({ ...settled, status: "uncertain", reason: "x" })).toBe(false);
  });

  it("renders a one-line status header", () => {
    expect(actionText(settled)).toBe("settled");
    expect(actionText({ ...settled, status: "blocked", rule: "credentials", reason: "password field" })).toContain(
      "blocked_by_policy · rule: credentials",
    );
    expect(actionText({ ...settled, status: "approval_pending", approvalId: "ap_9", rule: "payments" })).toContain(
      "approval_id: ap_9",
    );
  });
});
