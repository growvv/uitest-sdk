import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lease, readLease } from "../../src/governance/lease.js";
import { holdDevice, resumeDevice, HOLD_TASK, resolveTag } from "../../src/governance/hold.js";
import { tagOf } from "../../src/session.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-hold-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("holdDevice", () => {
  it("takes the device lease so an agent command gets lease_held", async () => {
    await withDir(async (dir) => {
      const result = await holdDevice({ stateDir: dir, tag: "abc12345" });
      const info = await readLease(join(dir, "leases", "abc12345.lock"));
      // The lease is recorded under HOLD_TASK, not the person's task name: an
      // agent that reads "held by a person" stops and asks, while one that
      // reads a task name waits for a competing agent that will never finish.
      expect(info?.task).toBe(HOLD_TASK);
      expect(result.path).toBe(join(dir, "leases", "abc12345.lock"));
    });
  });

  it("takes the device from a running task and names it", async () => {
    // `uitest-phone mcp` holds the lease for the life of the agent session, so
    // a hold that refused a live lease could never take the phone back in the
    // one mode agents actually use. The person's explicit command wins; the
    // task finds out on its next command (see the session test).
    await withDir(async (dir) => {
      await mkdir(join(dir, "leases"), { recursive: true });
      await Lease.acquire({
        path: join(dir, "leases", "abc12345.lock"),
        task: "other agent",
      });
      const result = await holdDevice({ stateDir: dir, tag: "abc12345" });
      expect(result.tookOverFrom).toBe("other agent");
      const info = await readLease(join(dir, "leases", "abc12345.lock"));
      expect(info?.task).toBe(HOLD_TASK);
      expect(info?.hold).toBe(true);
    });
  });

  it("does not report a takeover when it already held the device", async () => {
    await withDir(async (dir) => {
      await holdDevice({ stateDir: dir, tag: "abc12345" });
      const again = await holdDevice({ stateDir: dir, tag: "abc12345" });
      expect(again.tookOverFrom).toBeUndefined();
    });
  });

  it("is idempotent for the same person", async () => {
    await withDir(async (dir) => {
      const first = await holdDevice({ stateDir: dir, tag: "abc12345" });
      const second = await holdDevice({ stateDir: dir, tag: "abc12345" });
      expect(second.token).toBe(first.token);
    });
  });
});

describe("resumeDevice", () => {
  it("releases a hold so the next command can run", async () => {
    await withDir(async (dir) => {
      await holdDevice({ stateDir: dir, tag: "abc12345" });
      const released = await resumeDevice({ stateDir: dir, tag: "abc12345" });
      expect(released).toBe(true);
      expect(await readLease(join(dir, "leases", "abc12345.lock"))).toBeNull();
    });
  });

  it("releases a hold written by another process", async () => {
    // `hold` and `resume` are two separate commands: the person takes the
    // phone now and hands it back later, usually from another shell. A hold
    // has no owning process to check — it lives until `resume` — so the pid
    // that wrote it being gone must not make `resume` look like a competing
    // task and refuse the release.
    await withDir(async (dir) => {
      const path = join(dir, "leases", "abc12345.lock");
      await mkdir(join(dir, "leases"), { recursive: true });
      await Lease.acquire({ path, task: HOLD_TASK, hold: true, pid: 999_999_999 });
      expect(await resumeDevice({ stateDir: dir, tag: "abc12345" })).toBe(true);
      expect(await readLease(path)).toBeNull();
    });
  });

  it("does not release a lease held by someone else", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "leases", "abc12345.lock");
      await mkdir(join(dir, "leases"), { recursive: true });
      await Lease.acquire({ path, task: "an agent" });
      const released = await resumeDevice({ stateDir: dir, tag: "abc12345" });
      // Refusing here is the point: `resume` must never end another task.
      expect(released).toBe(false);
      expect((await readLease(path))?.task).toBe("an agent");
    });
  });

  it("reports nothing to release when the device is free", async () => {
    await withDir(async (dir) => {
      expect(await resumeDevice({ stateDir: dir, tag: "abc12345" })).toBe(false);
    });
  });
});

describe("HOLD_TASK", () => {
  it("names the person in the message an agent sees", () => {
    expect(HOLD_TASK).toBe("held by a person");
  });
});

/**
 * Which device `hold` / `resume` / `status` mean when nothing was passed.
 *
 * Every other entry point reads `HDC_TARGET` (Device, HdcRunner), so a caller
 * that selected a device that way expects these to agree. They did not: with
 * two phones attached, `resume` refused with "multiple targets attached" and
 * could not release the hold it had just been told about — found while running
 * the handoff acceptance with both devices plugged in.
 */
describe("resolveTag", () => {
  function fakeHdc(ids: string[]) {
    return { listTargets: async () => ids } as unknown as Parameters<typeof resolveTag>[1];
  }

  it("uses the device id it was given", async () => {
    expect(await resolveTag("SERIAL-A", fakeHdc(["SERIAL-A", "SERIAL-B"]))).toBe(tagOf("SERIAL-A"));
  });

  it("falls back to HDC_TARGET before counting targets", async () => {
    const saved = process.env.HDC_TARGET;
    process.env.HDC_TARGET = "SERIAL-B";
    try {
      expect(await resolveTag(undefined, fakeHdc(["SERIAL-A", "SERIAL-B"]))).toBe(tagOf("SERIAL-B"));
    } finally {
      if (saved === undefined) delete process.env.HDC_TARGET;
      else process.env.HDC_TARGET = saved;
    }
  });

  it("takes the only attached target", async () => {
    expect(await resolveTag(undefined, fakeHdc(["SERIAL-A"]))).toBe(tagOf("SERIAL-A"));
  });

  it("refuses to guess between two targets, and names them by tag", async () => {
    const saved = process.env.HDC_TARGET;
    delete process.env.HDC_TARGET;
    try {
      // `catch` on a Promise<string> widens to string | Error; the promise
      // only rejects here, so the value is always the error.
      const err = (await resolveTag(undefined, fakeHdc(["SERIAL-A", "SERIAL-B"])).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toMatch(/multiple targets/i);
      // The message must not print serials: it reaches a terminal and a log.
      expect(err.message).not.toContain("SERIAL-A");
      expect(err.message).toContain(tagOf("SERIAL-A"));
    } finally {
      if (saved !== undefined) process.env.HDC_TARGET = saved;
    }
  });
});
