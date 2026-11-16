import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Lease, readLease } from "../../src/lease.js";
import { LeaseHeldError } from "../../src/errors.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-lease-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Lease", () => {
  it("acquires an empty lock", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      const lease = await Lease.acquire({ path, task: "wlan check" });
      const info = await readLease(path);
      expect(info).toMatchObject({ task: "wlan check" });
      expect(lease.info.token).toBe(info!.token);
    });
  });

  it("refuses a lock held by another live task", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      await Lease.acquire({ path, task: "first" });
      const err = await Lease.acquire({ path, task: "second" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseHeldError);
      expect((err as Error).message).toContain("first");
    });
  });

  it("lets the same task re-enter from the same process and keeps the token", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      const first = await Lease.acquire({ path, task: "same" });
      const second = await Lease.acquire({ path, task: "same" });
      expect(second.info.token).toBe(first.info.token);
    });
  });

  it("refuses the same task name from a second process", async () => {
    // Two `live` pages both call their task "live". Matching on the name alone
    // let both hold the device, and the two casting daemons then fought over
    // the socket — measured as a livelock where each page killed the other's
    // daemon. A task name is not an identity; the process is.
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      await Lease.acquire({ path, task: "live", pid: 4242, isAlive: () => true });
      const err = await Lease.acquire({ path, task: "live", pid: 4343, isAlive: () => true }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LeaseHeldError);
    });
  });

  it("takes over a lease from another host whose heartbeat went stale", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      let now = 1000;
      // A pid cannot be checked across hosts, so the clock is the only signal.
      const old = await Lease.acquire({
        path, task: "crashed", staleMs: 500, now: () => now, host: "other-machine",
      });
      now = 2000;
      const fresh = await Lease.acquire({ path, task: "next", staleMs: 500, now: () => now });
      expect(fresh.info.task).toBe("next");
      expect(fresh.info.token).not.toBe(old.info.token);
    });
  });

  it("takes over a lease whose process is gone on this host", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      const first = await Lease.acquire({
        path, task: "crashed", staleMs: 10 * 60_000, pid: 424242, isAlive: () => false,
      });
      const second = await Lease.acquire({ path, task: "next", staleMs: 10 * 60_000, isAlive: () => false });
      expect(second.info.task).toBe("next");
      expect(first.info.token).not.toBe(second.info.token);
    });
  });

  it("does not steal from a live process that is heartbeating", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      let now = 1000;
      await Lease.acquire({ path, task: "busy", staleMs: 500, now: () => now, isAlive: () => true });
      now = 2000; // stale by clock, but the process is alive and will heartbeat
      await expect(
        Lease.acquire({ path, task: "other", staleMs: 500, now: () => now, isAlive: () => true }),
      ).rejects.toBeInstanceOf(LeaseHeldError);
    });
  });

  it("heartbeats without changing the token or task", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      let now = 1000;
      const lease = await Lease.acquire({ path, task: "t", now: () => now });
      now = 5000;
      await lease.heartbeat();
      const info = await readLease(path);
      expect(info).toMatchObject({ task: "t", token: lease.info.token, heartbeatAt: 5000 });
    });
  });

  it("releases the file only if it still owns it", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      const lease = await Lease.acquire({ path, task: "t" });
      await lease.release();
      expect(await readLease(path)).toBeNull();
    });
  });

  it("does not delete a file another process took over", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      let now = 1000;
      const lease = await Lease.acquire({
        path, task: "old", staleMs: 100, now: () => now, host: "other-machine",
      });
      now = 1300;
      const next = await Lease.acquire({ path, task: "new", staleMs: 100, now: () => now });
      await lease.release();
      const info = await readLease(path);
      expect(info?.token).toBe(next.info.token);
    });
  });


  it("keeps a lease whose owner is a person, not a process", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      // `uitest-phone hold` writes the lease and exits, so the pid is gone the
      // moment the command returns. Judging that by pid would let the next
      // agent command steal the device back, which is the opposite of a hold.
      await writeFile(
        path,
        `${JSON.stringify({
          task: "held by a person", token: "deadbeef", pid: 999999, host: hostname(),
          since: 1000, heartbeatAt: 1000, hold: true,
        })}
`,
      );
      const err = await Lease.acquire({ path, task: "agent", now: () => 2000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseHeldError);
      expect((err as Error).message).toContain("held by a person");
    });
  });

  it("lets a forced hold preempt a live task", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      await Lease.acquire({ path, task: "agent", isAlive: () => true });
      const held = await Lease.acquire({ path, task: "held by a person", hold: true, force: true });
      expect(held.info.task).toBe("held by a person");
      expect((await readLease(path))?.hold).toBe(true);
    });
  });

  it("tells a session its lease was taken, and lets it take the device again after a hand-back", async () => {
    // The MCP server holds one lease for the life of the process. Without this
    // re-check a `hold` would be invisible to it and it would keep driving the
    // phone: takeover only worked between one-shot CLI commands.
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      const lease = await Lease.acquire({ path, task: "agent" });
      await Lease.acquire({ path, task: "held by a person", hold: true, force: true });

      const err = await lease.reacquire().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseHeldError);
      expect((err as Error).message).toContain("held by a person");

      // The person runs `resume`: the lock is gone, and the same session may
      // take the device again without being restarted.
      await (await import("node:fs/promises")).unlink(path);
      await lease.reacquire();
      expect((await readLease(path))?.task).toBe("agent");
    });
  });

  it("treats a corrupt lock file as stale", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "dev.lock");
      await (await import("node:fs/promises")).writeFile(path, "not json");
      const lease = await Lease.acquire({ path, task: "t" });
      expect((await readLease(path))?.token).toBe(lease.info.token);
      expect(await readFile(path, "utf8")).toContain("t");
    });
  });
});
