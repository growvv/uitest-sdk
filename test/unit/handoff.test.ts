import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lease, readLease } from "../../src/lease.js";
import { handoffDevice, holdDevice, resumeDevice, HOLD_TASK } from "../../src/hold.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-handoff-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("handoffDevice", () => {
  it("takes the device and records why the person was asked", async () => {
    // The reason is not decoration: the hold outlives the tool call, so it is
    // the only thing that tells a later reader (or another agent) what the
    // person is doing with the phone.
    await withDir(async (dir) => {
      const result = await handoffDevice({
        stateDir: dir,
        tag: "abc12345",
        reason: "Sign in to Dinely",
      });
      const info = await readLease(join(dir, "leases", "abc12345.lock"));
      expect(info?.task).toBe(HOLD_TASK);
      expect(info?.hold).toBe(true);
      expect(info?.reason).toBe("Sign in to Dinely");
      expect(result.path).toBe(join(dir, "leases", "abc12345.lock"));
    });
  });

  it("preempts the task that asked for the handoff", async () => {
    // An agent calls handoff from inside the session that holds the lease
    // (`mcp` holds one for the life of the process). Taking the device has to
    // work from there, or the agent could never give it up.
    await withDir(async (dir) => {
      const path = join(dir, "leases", "abc12345.lock");
      await mkdir(join(dir, "leases"), { recursive: true });
      await Lease.acquire({ path, task: "mcp" });
      const result = await handoffDevice({
        stateDir: dir,
        tag: "abc12345",
        reason: "Enter the one-time code",
      });
      expect(result.tookOverFrom).toBe("mcp");
      expect((await readLease(path))?.task).toBe(HOLD_TASK);
    });
  });

  it("keeps the reason on one line", async () => {
    // It is printed after a status line in `lease_held`; a pasted multi-line
    // instruction would break that message apart.
    await withDir(async (dir) => {
      await handoffDevice({
        stateDir: dir,
        tag: "abc12345",
        reason: "Unlock the phone\n  then open Settings\tand turn on WLAN",
      });
      const info = await readLease(join(dir, "leases", "abc12345.lock"));
      expect(info?.reason).toBe("Unlock the phone then open Settings and turn on WLAN");
    });
  });

  it("stops the next agent with lease_held and repeats the reason", async () => {
    await withDir(async (dir) => {
      await handoffDevice({
        stateDir: dir,
        tag: "abc12345",
        reason: "Sign in to Dinely",
      });
      const attempt = Lease.acquire({
        path: join(dir, "leases", "abc12345.lock"),
        task: "another agent",
      });
      await expect(attempt).rejects.toThrow(/A person is using the phone/);
      await expect(attempt).rejects.toThrow(/Sign in to Dinely/);
    });
  });

  it("is released by the same resume a hold uses", async () => {
    await withDir(async (dir) => {
      await handoffDevice({ stateDir: dir, tag: "abc12345", reason: "Unlock the phone" });
      expect(await resumeDevice({ stateDir: dir, tag: "abc12345" })).toBe(true);
      expect(await readLease(join(dir, "leases", "abc12345.lock"))).toBeNull();
    });
  });

  it("updates the reason when the agent asks again", async () => {
    await withDir(async (dir) => {
      await handoffDevice({ stateDir: dir, tag: "abc12345", reason: "Unlock the phone" });
      await handoffDevice({ stateDir: dir, tag: "abc12345", reason: "Now enter the code" });
      const info = await readLease(join(dir, "leases", "abc12345.lock"));
      expect(info?.reason).toBe("Now enter the code");
    });
  });

  it("leaves a person's own hold without a reason", async () => {
    await withDir(async (dir) => {
      await holdDevice({ stateDir: dir, tag: "abc12345" });
      const info = await readLease(join(dir, "leases", "abc12345.lock"));
      expect(info?.reason).toBeUndefined();
    });
  });
});
