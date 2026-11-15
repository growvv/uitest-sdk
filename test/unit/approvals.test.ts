import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals } from "../../src/approvals.js";

const step = { command: "tap", args: { ref: 3 }, signature: "button|删除|1,2,3,4" };

describe("Approvals", () => {
  it("issues an id that is unguessable and unique", () => {
    const a = new Approvals();
    const first = a.request(step);
    const second = a.request(step);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("is pending until the matching id is presented", () => {
    const a = new Approvals();
    const { id } = a.request(step);
    expect(a.consume(id, step)).toEqual({ kind: "approved" });
  });

  it("refuses an id that does not match this exact step", () => {
    const a = new Approvals();
    const { id } = a.request(step);
    const other = { command: "tap", args: { ref: 4 }, signature: "button|删除|1,2,3,4" };
    expect(a.consume(id, other)).toMatchObject({ kind: "denied" });
    // A mismatch must not burn the approval: the right step can still use it.
    expect(a.consume(id, step)).toEqual({ kind: "approved" });
  });

  it("refuses a stale approval when the target changed", () => {
    const a = new Approvals();
    const { id } = a.request(step);
    const moved = { ...step, signature: "button|删除|9,9,9,9" };
    expect(a.consume(id, moved)).toMatchObject({ kind: "stale" });
  });

  it("allows an approval exactly once", () => {
    const a = new Approvals();
    const { id } = a.request(step);
    expect(a.consume(id, step)).toEqual({ kind: "approved" });
    expect(a.consume(id, step)).toMatchObject({ kind: "denied" });
  });

  it("expires an approval after its window", () => {
    let now = 1000;
    const a = new Approvals({ ttlMs: 500, now: () => now });
    const { id } = a.request(step);
    now = 1600;
    expect(a.consume(id, step)).toMatchObject({ kind: "denied" });
  });

  it("rejects an unknown id", () => {
    const a = new Approvals();
    expect(a.consume("deadbeef", step)).toMatchObject({ kind: "denied" });
  });

  it("clears everything on release", () => {
    const a = new Approvals();
    const { id } = a.request(step);
    a.clear();
    expect(a.consume(id, step)).toMatchObject({ kind: "denied" });
  });

  it("lists pending approvals for status output", () => {
    const a = new Approvals();
    const { id } = a.request(step);
    expect(a.pending()).toEqual([expect.objectContaining({ id, command: "tap" })]);
  });

  it("reports a denied reason a person can act on", () => {
    let now = 1000;
    const a = new Approvals({ ttlMs: 500, now: () => now });
    const { id } = a.request(step);
    now = 2000;
    const r = a.consume(id, step);
    expect(r.kind).toBe("denied");
    expect(r.kind === "denied" && r.reason).toMatch(/expired/);
  });
});

describe("Approvals across processes", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "uitest-approvals-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("honours an id issued by an earlier process", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "approvals.json");
      const first = await Approvals.open(path);
      const { id } = first.request(step);

      // The CLI runs one command per process: the replay is a fresh instance.
      const second = await Approvals.open(path);
      expect(second.consume(id, step)).toEqual({ kind: "approved" });
    });
  });

  it("keeps an id single-use across processes", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "approvals.json");
      const { id } = (await Approvals.open(path)).request(step);
      await Approvals.open(path).then((a) => a.consume(id, step));
      const third = await Approvals.open(path);
      expect(third.consume(id, step)).toMatchObject({ kind: "denied" });
    });
  });

  it("does not resurrect an id that a mismatch left intact", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "approvals.json");
      const { id } = (await Approvals.open(path)).request(step);
      const other = { ...step, args: { ref: 4 } };
      expect((await Approvals.open(path)).consume(id, other)).toMatchObject({ kind: "denied" });
      // Still usable for the step it was issued for.
      expect((await Approvals.open(path)).consume(id, step)).toEqual({ kind: "approved" });
    });
  });

  it("starts empty when the file is corrupt", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "approvals.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "nope");
      expect((await Approvals.open(path)).pending()).toEqual([]);
    });
  });

  it("drops expired entries instead of growing forever", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "approvals.json");
      const first = await Approvals.open(path, { ttlMs: 1 });
      first.request(step);
      await new Promise((r) => setTimeout(r, 5));
      const later = await Approvals.open(path, { ttlMs: 1 });
      later.request({ ...step, args: { ref: 9 } });
      const raw = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
      expect(Object.keys(raw.entries)).toHaveLength(1);
    });
  });
});
