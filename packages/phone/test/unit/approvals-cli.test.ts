import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Approvals } from "uitest-sdk/govern";

const bin = join(import.meta.dirname, "..", "..", "dist", "bin.js");
const STEP = { command: "tap", args: { text: "删除" }, signature: "sig" };

function freshState(): { dir: string; store: Approvals } {
  const dir = mkdtempSync(join(tmpdir(), "uitest-phone-cli-"));
  const store = new Approvals({ dir: join(dir, "approvals", "7544d645") });
  return { dir, store };
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" });
}

describe("uitest-phone approvals", () => {
  it("allows a pending id from a second process without the agent holding a decision", () => {
    const { dir, store } = freshState();
    const pending = store.request(STEP, "deletes", { bundle: "com.demo", task: "t" });

    const out = run(["approvals", "allow", pending.id, "--yes", "--state-dir", dir]);

    expect(out).toContain(`allowed ${pending.id}`);
    expect(store.consume(pending.id, STEP).kind).toBe("approved");
  });

  it("refuses allow without --yes when no TTY is attached", () => {
    const { dir, store } = freshState();
    const pending = store.request(STEP, "deletes");

    const result = spawnSync(
      process.execPath,
      [bin, "approvals", "allow", pending.id, "--state-dir", dir],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("approval_refused");
    expect(result.stderr).toContain("--yes is required when no terminal is attached");
    expect(store.status(pending.id)?.status).toBe("pending");
  });

  it("records a denial with the person's reason", () => {
    const { dir, store } = freshState();
    const pending = store.request(STEP, "deletes");

    const out = run(["approvals", "deny", pending.id, "--reason", "not now", "--state-dir", dir]);

    expect(out).toContain(`denied ${pending.id}`);
    expect(store.consume(pending.id, STEP)).toMatchObject({ kind: "denied", reason: "not now" });
  });

  it("lists pending approvals as JSON", () => {
    const { dir, store } = freshState();
    const pending = store.request(STEP, "deletes", { bundle: "com.demo", task: "t" });

    const items = JSON.parse(run(["approvals", "list", "--json", "--state-dir", dir]));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      tag: "7544d645",
      id: pending.id,
      command: "tap",
      rule: "deletes",
      bundle: "com.demo",
      task: "t",
      status: "pending",
    });
  });

  // A deny that loses to an allow already on disk must say so and exit
  // non-zero. Printing "denied" and exiting 0 tells a person their refusal
  // took effect while the agent's replay still goes ahead.
  it("refuses a deny that lost to an allow, and says the replay proceeds", () => {
    const { dir, store } = freshState();
    const pending = store.request(STEP, "deletes", { bundle: "com.demo", task: "t" });
    store.decide(pending.id, "allow", { by: "cli" });

    const out = spawnSync(
      process.execPath,
      [bin, "approvals", "deny", pending.id, "--state-dir", dir],
      { encoding: "utf8" },
    );

    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/already allowed/);
    expect(store.consume(pending.id, STEP).kind).toBe("approved");
  });

  it("finds an id under the tag that owns it when several devices have approvals", () => {    const dir = mkdtempSync(join(tmpdir(), "uitest-phone-cli-"));
    const first = new Approvals({ dir: join(dir, "approvals", "7544d645") });
    const second = new Approvals({ dir: join(dir, "approvals", "6c585f5b") });
    first.request(STEP, "deletes");
    const pending = second.request(STEP, "sends");

    run(["approvals", "allow", pending.id, "--yes", "--state-dir", dir]);

    expect(second.status(pending.id)?.status).toBe("allowed");
    expect(first.status(pending.id)).toBeNull();
  });

  it("prints an empty list when nothing is waiting", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-phone-cli-"));

    expect(run(["approvals", "list", "--state-dir", dir])).toContain("no pending approvals");
    expect(JSON.parse(run(["approvals", "list", "--json", "--state-dir", dir]))).toEqual([]);
  });
});
