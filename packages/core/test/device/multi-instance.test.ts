import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { getTarget, killAllUitest } from "./helpers.js";

const TARGET = getTarget();
const workers: ChildProcess[] = [];

function spawn(): Promise<ChildProcess> {
  // Node's native type stripping does not rewrite `./x.js` to `./x.ts`, which
  // this ESM codebase relies on, so the worker runs through tsx.
  const w = fork(new URL("./worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
  });
  workers.push(w);
  return new Promise((r) => w.once("spawn", () => r(w)));
}

function ask(w: ChildProcess, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("worker timeout")), 60_000);
    w.once("message", (m) => {
      clearTimeout(to);
      resolve(m as Record<string, unknown>);
    });
    w.send(msg);
  });
}

// The suite asserts who started the daemon, so it must begin from a device with
// no uitest processes at all.
beforeAll(async () => {
  await killAllUitest();
}, 60_000);

afterEach(async () => {
  for (const w of workers.splice(0)) {
    // A worker the test already disposed (or killed) cannot answer; just drop it.
    if (w.connected && w.exitCode === null) {
      await ask(w, { op: "dispose" }).catch(() => undefined);
    }
    w.kill();
  }
});

describe("multi-instance", () => {
  it("second connect reuses the daemon instead of restarting it", async () => {
    const a = await spawn();
    const ra = await ask(a, { op: "connect", target: TARGET });
    expect(ra.ok).toBe(true);
    expect(ra.ownsDaemon).toBe(true); // the first one started it

    const b = await spawn();
    const rb = await ask(b, { op: "connect", target: TARGET });
    expect(rb.ok).toBe(true);
    expect(rb.ownsDaemon).toBe(false); // reused, not restarted
  }, 120_000);

  it("two processes hammering concurrently both fully succeed", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    const [ra, rb] = await Promise.all([
      ask(a, { op: "hammer", calls: 40 }),
      ask(b, { op: "hammer", calls: 40 }),
    ]);
    expect(ra).toMatchObject({ ok: true, n: 40 });
    expect(rb).toMatchObject({ ok: true, n: 40 });
    // No `Disallow concurrent use` may leak to a caller: the backoff must absorb it.
  }, 120_000);

  it("RPC in B works while A is streaming", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    expect((await ask(a, { op: "startStream" })).ok).toBe(true);
    const rb = await ask(b, { op: "captureLayout" });
    expect(rb).toMatchObject({ ok: true, hasAttrs: true });
  }, 120_000);

  it("B's captureScreen fails with AgentBusyError while A streams", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    await ask(a, { op: "startStream" });
    const rb = await ask(b, { op: "startCaptureScreen" });
    expect(rb.ok).toBe(false);
    expect(rb.name).toBe("AgentBusyError");
  }, 120_000);

  it("A's dispose does not disturb B", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    await ask(a, { op: "dispose" });
    a.kill();
    const rb = await ask(b, { op: "ping" });
    expect(rb.ok).toBe(true);
  }, 120_000);

  it("both can dispose without error", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    const [ra, rb] = await Promise.all([
      ask(a, { op: "dispose" }),
      ask(b, { op: "dispose" }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
  }, 120_000);
});
