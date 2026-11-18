import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Approvals } from "uitest-sdk/govern";
import type { PendingApproval } from "uitest-sdk/govern";
import type { ViewerClient, ViewerSource } from "uitest-sdk/viewer";
import { consoleHooks, createConsoleServer } from "../../src/server.js";

/** A tab as a hook sees it: messages are recorded instead of sent. */
function tab(): ViewerClient & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return { id: "c1", send: (m) => sent.push(m), sent };
}

function store(): { dir: string; approvals: Approvals; pending: PendingApproval } {
  const dir = mkdtempSync(join(tmpdir(), "console-"));
  const approvals = new Approvals({ dir: join(dir, "approvals", "7544d645") });
  const pending = approvals.request(
    { command: "tap", args: { text: "删除" }, signature: "sig" },
    "deletes",
    { bundle: "com.demo", task: "checkout" },
  );
  return { dir, approvals, pending };
}

function deps(dir: string, approvals: Approvals) {
  const held: string[] = [];
  return {
    approvals,
    stateDir: dir,
    tag: "7544d645",
    // Whether the device is already held by a person. The page's button is a
    // toggle, and a tab that joins while a hold is in place must start at
    // "Resume" — otherwise its first click takes the device *again* and the
    // person can never hand it back.
    isHeld: async () => false,
    hold: async () => {
      held.push("hold");
      return { path: "p", token: "t", task: "held by a person", tookOverFrom: "agent" };
    },
    resume: async () => {
      held.push("resume");
      return true;
    },
    activity: async () => [
      { at: "2026-11-18T06:00:00.000Z", step: 1, command: "observe", status: "settled", text: "ok" },
    ],
    held,
  };
}

describe("console hooks", () => {
  it("lists pending approvals with the time left", () => {
    const { dir, approvals, pending } = store();
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    expect(hooks.onMessage!(c, { type: "console:approvals:list" })).toBe(true);

    const reply = c.sent[0]!;
    expect(reply.type).toBe("console:approvals");
    const items = reply.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: pending.id,
      command: "tap",
      bundle: "com.demo",
      rule: "deletes",
      task: "checkout",
      status: "pending",
    });
    expect(Number(items[0]!.expiresInMs)).toBeGreaterThan(50_000);
  });

  it("writes the person's answer and answers with the refreshed list", () => {
    const { dir, approvals, pending } = store();
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    hooks.onMessage!(c, {
      type: "console:approvals:decide",
      id: pending.id,
      decision: "allow",
      scope: "once",
    });

    expect(approvals.status(pending.id)?.status).toBe("allowed");
    expect(c.sent[0]!.type).toBe("console:approvals");
    expect((c.sent[0]!.items as unknown[]).length).toBe(1);
  });

  it("refuses a decision on an id nobody asked for", () => {
    const { dir, approvals } = store();
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    hooks.onMessage!(c, {
      type: "console:approvals:decide",
      id: "deadbeef",
      decision: "allow",
    });

    const reply = c.sent.find((m) => m.type === "console:error");
    expect(reply).toBeDefined();
    expect(String(reply!.message)).toContain("unknown approval id");
  });

  it("tells the tab when its deny lost to an allow already given", () => {
    // The console's Deny button must not look like it worked. The allow is
    // already on disk, so the agent's replay proceeds whatever this click does;
    // the person needs to be told that, not shown a quiet refresh.
    const { dir, approvals, pending } = store();
    approvals.decide(pending.id, "allow", { by: "cli", scope: "once" });
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    hooks.onMessage!(c, {
      type: "console:approvals:decide",
      id: pending.id,
      decision: "deny",
    });

    const reply = c.sent.find((m) => m.type === "console:error");
    expect(reply).toBeDefined();
    expect(String(reply!.message)).toContain("already allowed");
  });

  it("sends the refreshed inbox before the reason it did not change", () => {
    // Order is the whole message here. The page redraws the inbox on every
    // list frame, so an error sent first is erased by the frame that follows
    // it — the person sees the row come back and no explanation. The reason
    // has to be the last thing on the wire.
    const { dir, approvals, pending } = store();
    approvals.decide(pending.id, "allow", { by: "cli", scope: "once" });
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    hooks.onMessage!(c, { type: "console:approvals:decide", id: pending.id, decision: "deny" });

    const types = c.sent.map((m) => m.type);
    expect(types).toContain("console:approvals");
    expect(types.at(-1)).toBe("console:error");
  });

  it("takes the device for the person and reports who had it", async () => {
    const { dir, approvals } = store();
    const d = deps(dir, approvals);
    const hooks = consoleHooks(d);
    const c = tab();

    hooks.onMessage!(c, { type: "console:hold" });
    await new Promise((r) => setTimeout(r, 20));

    expect(d.held).toEqual(["hold"]);
    expect(c.sent[0]).toMatchObject({ type: "console:held", held: true, tookOverFrom: "agent" });
  });

  it("hands the device back", async () => {
    const { dir, approvals } = store();
    const d = deps(dir, approvals);
    const hooks = consoleHooks(d);
    const c = tab();

    hooks.onMessage!(c, { type: "console:resume" });
    await new Promise((r) => setTimeout(r, 20));

    expect(d.held).toEqual(["resume"]);
    expect(c.sent[0]).toMatchObject({ type: "console:held", held: false });
  });

  it("reports a hold that failed instead of claiming it worked", async () => {
    const { dir, approvals } = store();
    const d = { ...deps(dir, approvals), hold: async () => Promise.reject(new Error("locked")) };
    const hooks = consoleHooks(d);
    const c = tab();

    hooks.onMessage!(c, { type: "console:hold" });
    await new Promise((r) => setTimeout(r, 20));

    expect(c.sent[0]).toMatchObject({ type: "console:error", message: "locked" });
  });

  it("returns the recent activity, newest last", async () => {
    const { dir, approvals } = store();
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    hooks.onMessage!(c, { type: "console:activity" });
    await new Promise((r) => setTimeout(r, 20));

    const reply = c.sent[0]!;
    expect(reply.type).toBe("console:activity");
    expect((reply.items as Array<Record<string, unknown>>)[0]).toMatchObject({ command: "observe" });
  });

  it("tells a tab that joins while a person holds the device", async () => {
    // The button is one toggle: Hold, then Resume. A tab that opens after a
    // hold was written starts at `held = false`, so its first click holds the
    // device again and the person can never give it back. The server has to
    // say which state the device is in when the tab arrives.
    const { dir, approvals } = store();
    const d = { ...deps(dir, approvals), isHeld: async () => true };
    const hooks = consoleHooks(d);
    const c = tab();

    hooks.onClient!(c);
    await new Promise((r) => setTimeout(r, 20));

    expect(c.sent.some((m) => m.type === "console:held" && m.held === true)).toBe(true);
  });

  it("tells a tab that joins while the device is free", async () => {
    const { dir, approvals } = store();
    const hooks = consoleHooks(deps(dir, approvals));
    const c = tab();

    hooks.onClient!(c);
    await new Promise((r) => setTimeout(r, 20));

    expect(c.sent.some((m) => m.type === "console:held" && m.held === false)).toBe(true);
  });

  it("re-reads the lease when the page polls", async () => {
    // Two tabs share one lease. A tab that only learned the state on join
    // keeps showing "Hold" after the other tab resumed, and its next click
    // takes the device again instead of handing it back.
    const { dir, approvals } = store();
    let held = false;
    const hooks = consoleHooks({ ...deps(dir, approvals), isHeld: async () => held });
    const c = tab();

    hooks.onMessage!(c, { type: "console:held:list" });
    await new Promise((r) => setTimeout(r, 20));
    expect(c.sent.at(-1)).toMatchObject({ type: "console:held", held: false });

    held = true;
    hooks.onMessage!(c, { type: "console:held:list" });
    await new Promise((r) => setTimeout(r, 20));
    expect(c.sent.at(-1)).toMatchObject({ type: "console:held", held: true });
  });

  it("leaves messages it does not own to the viewer", () => {
    const { dir, approvals } = store();
    const hooks = consoleHooks(deps(dir, approvals));
    expect(hooks.onMessage!(tab(), { type: "input" })).toBe(false);
    expect(hooks.onMessage!(tab(), { type: "console:unknown" })).toBe(false);
  });
});

describe("createConsoleServer", () => {
  const running: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const server of running.splice(0)) await server.close().catch(() => undefined);
  });

  it("serves the console page with the inbox on it", async () => {
    const { dir, approvals } = store();
    const source: ViewerSource = {
      async createCast() {
        throw new Error("no cast in this test");
      },
    };
    const server = await createConsoleServer({
      ...deps(dir, approvals),
      source,
      port: 0,
      host: "127.0.0.1",
    });
    running.push(server);

    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();

    expect(html).toContain('id="inbox"');
    expect(html).toContain("<title>uitest-console</title>");
  });
});
