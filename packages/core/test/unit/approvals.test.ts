import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, Grants } from "../../src/governance/approvals.js";

const step = { command: "tap", args: { text: "删除" }, signature: "sig-1" };

function store(opts: { ttlMs?: number; now?: () => number } = {}): Approvals {
  return new Approvals({ dir: mkdtempSync(join(tmpdir(), "uitest-appr-")), ...opts });
}

describe("approval decisions", () => {
  it("cannot be consumed by the agent alone", () => {
    const a = store();
    const pending = a.request(step, "deletes", { bundle: "com.demo", task: "t" });
    expect(a.consume(pending.id, step).kind).toBe("pending");
  });

  it("proceeds once after a person allows it", () => {
    const a = store();
    const pending = a.request(step, "deletes", { bundle: "com.demo", task: "t" });
    expect(a.decide(pending.id, "allow", { by: "cli" }).kind).toBe("allowed");
    expect(a.consume(pending.id, step)).toMatchObject({ kind: "approved", rule: "deletes" });
    expect(a.consume(pending.id, step).kind).toBe("denied");
  });

  it("denies after a person denies, and survives a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const first = new Approvals({ dir });
    const pending = first.request(step, "deletes");
    expect(first.decide(pending.id, "deny", { by: "console", reason: "not now" }).kind).toBe("denied");
    expect(new Approvals({ dir }).consume(pending.id, step)).toMatchObject({ kind: "denied" });
  });

  it("expires after 60 s by default", () => {
    let now = 1_000;
    const a = store({ now: () => now });
    const pending = a.request(step, "deletes");
    now += 60_001;
    expect(a.consume(pending.id, step).kind).toBe("denied");
    expect(a.pending()).toEqual([]);
  });
});

describe("Approvals", () => {
  it("issues an id that is unguessable and unique", () => {
    const a = store();
    const first = a.request(step);
    const second = a.request(step);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("refuses an id that does not match this exact step", () => {
    const a = store();
    const { id } = a.request(step);
    a.decide(id, "allow", { by: "cli" });
    const other = { command: "tap", args: { ref: 4 }, signature: "sig-1" };
    expect(a.consume(id, other)).toMatchObject({ kind: "denied" });
    // A mismatch must not burn the approval: the right step can still use it.
    expect(a.consume(id, step)).toEqual({ kind: "approved" });
  });

  it("refuses a stale approval when the target changed", () => {
    const a = store();
    const { id } = a.request(step);
    a.decide(id, "allow", { by: "cli" });
    const moved = { ...step, signature: "button|删除|9,9,9,9" };
    expect(a.consume(id, moved)).toMatchObject({ kind: "stale" });
  });

  it("allows an approval exactly once", () => {
    const a = store();
    const { id } = a.request(step);
    a.decide(id, "allow", { by: "cli" });
    expect(a.consume(id, step)).toEqual({ kind: "approved" });
    expect(a.consume(id, step)).toMatchObject({ kind: "denied" });
  });

  it("expires an approval after its window", () => {
    let now = 1000;
    const a = store({ ttlMs: 500, now: () => now });
    const { id } = a.request(step);
    now = 1600;
    expect(a.consume(id, step)).toMatchObject({ kind: "denied" });
  });

  it("rejects an unknown id", () => {
    const a = store();
    expect(a.consume("deadbeef", step)).toMatchObject({ kind: "denied" });
  });

  it("lists pending approvals for status output", () => {
    const a = store();
    const { id } = a.request(step);
    expect(a.pending()).toEqual([expect.objectContaining({ id, command: "tap", status: "pending" })]);
  });

  it("reports a denied reason a person can act on", () => {
    let now = 1000;
    const a = store({ ttlMs: 500, now: () => now });
    const { id } = a.request(step);
    now = 2000;
    const r = a.consume(id, step);
    expect(r.kind).toBe("denied");
    expect(r.kind === "denied" && r.reason).toMatch(/expired/);
  });

  it("keeps the first decision when asked twice, and says which answer won", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const first = new Approvals({ dir });
    const { id } = first.request(step, "deletes");
    expect(first.decide(id, "allow", { by: "cli" }).kind).toBe("allowed");
    // The id alone is not enough to flip the answer: a second decision loses.
    // It must not be reported as if the deny took effect — a person who is
    // told "denied" stops looking, and the agent's replay still proceeds.
    expect(new Approvals({ dir }).decide(id, "deny", { by: "console" })).toMatchObject({
      kind: "conflict",
      reason: expect.stringMatching(/already allowed/),
    });
    expect(new Approvals({ dir }).consume(id, step)).toMatchObject({ kind: "approved" });
  });

  it("reports an expired id instead of writing a decision", () => {
    let now = 1000;
    const a = store({ ttlMs: 500, now: () => now });
    const { id } = a.request(step);
    now = 2000;
    expect(a.decide(id, "allow")).toMatchObject({ kind: "expired" });
  });

  it("keeps an id single-use across processes", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const { id } = new Approvals({ dir }).request(step);
    new Approvals({ dir }).decide(id, "allow", { by: "cli" });
    new Approvals({ dir }).consume(id, step);
    expect(new Approvals({ dir }).consume(id, step)).toMatchObject({ kind: "denied" });
  });

  it("remembers the scope a person chose with the decision", () => {
    const a = store();
    const { id } = a.request(step, "deletes");
    a.decide(id, "allow", { by: "console", scope: "task" });
    expect(a.consume(id, step)).toMatchObject({ kind: "approved", scope: "task" });
  });

  it("refuses to remember an approval that carries no rule, without burning it", () => {
    const a = store({ ttlMs: 500 });
    const { id } = a.request(step);
    a.decide(id, "allow", { by: "cli" });
    expect(a.consume(id, step, { scope: "always" })).toMatchObject({ kind: "denied" });
    // Not consumed: the person's allow still covers one plain replay.
    expect(a.consume(id, step)).toEqual({ kind: "approved" });
  });

  it("reports the status of a decided id", () => {
    const a = store();
    const { id } = a.request(step, "deletes");
    expect(a.status(id)).toMatchObject({ status: "pending" });
    a.decide(id, "allow", { by: "cli" });
    expect(a.status(id)).toMatchObject({ status: "allowed" });
  });
});

describe("Grants", () => {
  const grant = { rule: "deletes", bundle: "com.demo" } as const;

  it("permits nothing by default", () => {
    expect(new Grants().permits({ rule: "deletes", bundle: "com.demo", task: "a" })).toBeNull();
  });

  it("applies a task grant only to the same task, rule and app", () => {
    const g = new Grants();
    g.add({ ...grant, task: "cleanup", scope: "task" });
    expect(g.permits({ rule: "deletes", bundle: "com.demo", task: "cleanup" })).not.toBeNull();
    expect(g.permits({ rule: "deletes", bundle: "com.demo", task: "other" })).toBeNull();
    expect(g.permits({ rule: "sends", bundle: "com.demo", task: "cleanup" })).toBeNull();
    expect(g.permits({ rule: "deletes", bundle: "com.other", task: "cleanup" })).toBeNull();
  });

  it("applies an always grant to every task but only its own app and rule", () => {
    const g = new Grants();
    g.add({ ...grant, task: null, scope: "always" });
    expect(g.permits({ rule: "deletes", bundle: "com.demo", task: "one" })).not.toBeNull();
    expect(g.permits({ rule: "deletes", bundle: "com.demo", task: "two" })).not.toBeNull();
    expect(g.permits({ rule: "deletes", bundle: "com.other", task: "one" })).toBeNull();
    expect(g.permits({ rule: "sends", bundle: "com.demo", task: "one" })).toBeNull();
  });

  it("does not keep the same grant twice", () => {
    const g = new Grants();
    g.add({ ...grant, task: null, scope: "always" });
    g.add({ ...grant, task: null, scope: "always" });
    expect(g.list()).toHaveLength(1);
  });

  it("survives a new process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-grants-"));
    const path = join(dir, "grants.json");
    await Grants.open(path).then((g) => g.add({ ...grant, task: "cleanup", scope: "task" }));
    const next = await Grants.open(path);
    expect(next.permits({ rule: "deletes", bundle: "com.demo", task: "cleanup" })).not.toBeNull();
    expect(next.permits({ rule: "deletes", bundle: "com.demo", task: "other" })).toBeNull();
  });

  it("drops task grants on resume and keeps always grants", () => {
    const g = new Grants();
    g.add({ ...grant, task: "cleanup", scope: "task" });
    g.add({ ...grant, task: null, scope: "always" });
    expect(g.clearTask()).toBe(1);
    expect(g.permits({ rule: "deletes", bundle: "com.demo", task: "cleanup" })).not.toBeNull();
    expect(g.list()).toHaveLength(1);
  });
});
