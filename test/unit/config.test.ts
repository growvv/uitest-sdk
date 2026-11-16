import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastConfig, castConfigPath } from "../../src/config.js";
import { UitestError } from "../../src/errors.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CastConfig", () => {
  it("lives in the state directory as cast.json", () => {
    expect(castConfigPath("/state")).toBe(join("/state", "cast.json"));
  });

  it("starts empty when the file does not exist", async () => {
    await withDir(async (dir) => {
      const cfg = await CastConfig.load(castConfigPath(dir));
      expect(cfg.get()).toEqual({});
    });
  });

  it("round-trips settings through disk", async () => {
    await withDir(async (dir) => {
      const path = castConfigPath(dir);
      const cfg = await CastConfig.load(path);
      await cfg.set({ scale: 2, frameRate: 30, bitRate: 8_000_000, port: 5001, transport: "ws" });
      const again = await CastConfig.load(path);
      expect(again.get()).toEqual({
        scale: 2,
        frameRate: 30,
        bitRate: 8_000_000,
        port: 5001,
        transport: "ws",
      });
    });
  });

  it("merges a patch instead of replacing the file", async () => {
    await withDir(async (dir) => {
      const cfg = await CastConfig.load(castConfigPath(dir));
      await cfg.set({ frameRate: 30 });
      await cfg.set({ scale: 2 });
      expect((await CastConfig.load(castConfigPath(dir))).get()).toEqual({ frameRate: 30, scale: 2 });
    });
  });

  it("ignores unknown and invalid keys in a hand-edited file", async () => {
    await withDir(async (dir) => {
      const path = castConfigPath(dir);
      await writeFile(
        path,
        JSON.stringify({ frameRate: 45, port: 70_000, transport: "quic", scale: 2, bogus: 1 }),
      );
      const cfg = await CastConfig.load(path);
      expect(cfg.get()).toEqual({ scale: 2 });
    });
  });

  it("treats corrupt JSON as empty rather than failing a run", async () => {
    await withDir(async (dir) => {
      const path = castConfigPath(dir);
      await writeFile(path, "{not json");
      expect((await CastConfig.load(path)).get()).toEqual({});
    });
  });

  it("rejects invalid values when set", async () => {
    await withDir(async (dir) => {
      const cfg = await CastConfig.load(castConfigPath(dir));
      await expect(cfg.set({ frameRate: 45 as unknown as 30 })).rejects.toThrow(UitestError);
      await expect(cfg.set({ scale: 6 as unknown as 2 })).rejects.toThrow(UitestError);
      await expect(cfg.set({ port: 70_000 })).rejects.toThrow(UitestError);
      await expect(cfg.set({ transport: "quic" as unknown as "ws" })).rejects.toThrow(UitestError);
      expect(cfg.get()).toEqual({});
    });
  });

  it("turns settings into createCast options with the mode", async () => {
    await withDir(async (dir) => {
      const cfg = await CastConfig.load(castConfigPath(dir));
      await cfg.set({ scale: 2, frameRate: 30, transport: "ws", wsExtension: "./lib.so" });
      expect(cfg.toCastOptions("stream")).toEqual({
        mode: "stream",
        scale: 2,
        frameRate: 30,
        transport: "ws",
        wsExtension: "./lib.so",
      });
      expect(cfg.toCastOptions("record").mode).toBe("record");
    });
  });

  it("writes only the keys it was given", async () => {
    await withDir(async (dir) => {
      const path = castConfigPath(dir);
      const cfg = await CastConfig.load(path);
      await cfg.set({ frameRate: 30, bitRate: undefined });
      const raw = JSON.parse(await readFile(path, "utf8"));
      expect(raw).toEqual({ frameRate: 30 });
    });
  });
});
