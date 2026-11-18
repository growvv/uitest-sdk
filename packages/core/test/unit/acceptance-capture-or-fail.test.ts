import { describe, expect, it } from "vitest";
import { captureOrFail } from "../../../../scripts/acceptance.js";

/**
 * An acceptance case is a claim about one thing: "the mirror shows a frame",
 * "the row appears". A screenshot that could not be taken is a fact about that
 * case, so it belongs in the report as a failure.
 *
 * It used to throw instead, and the run died before writing any report at all:
 * one flaky frame on one device lost the other twelve cases that had already
 * passed, and the operator got a stack trace rather than a list of what did and
 * did not work.
 */
describe("captureOrFail", () => {
  it("returns the notes of a capture that worked", async () => {
    const r = await captureOrFail(async () => ({ notes: ["3 node rows"] }));

    expect(r).toEqual({ ok: true, notes: ["3 node rows"] });
  });

  it("treats a capture with no notes as a success", async () => {
    const r = await captureOrFail(async () => ({}));

    expect(r).toEqual({ ok: true, notes: [] });
  });

  it("reports a failed capture instead of throwing", async () => {
    const r = await captureOrFail(async () => {
      throw new Error("page never satisfied: #approvals-list");
    });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/page never satisfied/);
  });

  it("reports a rejection that is not an Error", async () => {
    const r = await captureOrFail(async () => {
      // A helper that rejects with a string is a real thing in this codebase's
      // older scripts, and `String(e)` is what keeps the reason readable.
      return Promise.reject("no Chrome or Edge found");
    });

    expect(r.ok === false && r.reason).toBe("no Chrome or Edge found");
  });
});
