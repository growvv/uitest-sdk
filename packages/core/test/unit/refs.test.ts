import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRefStore } from "../../src/operations/refs.js";
import { ScreenBuilder } from "../../src/driver/agent/screen.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (attrs: Record<string, string>, children: UiNode[] = []): UiNode => ({
  attributes: attrs,
  children,
});

const tree = (labels: string[] = ["WLAN", "Bluetooth", "Display"]): UiNode =>
  node({ bundleName: "com.demo" }, [
    node({ type: "Root", bounds: "[0,0][1000,2000]" }, [
      ...labels.map((text, i) =>
        node({ type: "Button", text, clickable: "true", bounds: `[0,${200 + i * 200}][1000,${380 + i * 200}]` }),
      ),
    ]),
  ]);

const ctx = { display: { width: 1000, height: 2000 }, rotation: 0 };

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-refs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("FileRefStore", () => {
  it("round-trips the table through a file", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const store = new FileRefStore(path);
      expect(store.load()).toBeNull();
      await store.save({ next: 4, refs: { "button|WLAN": 3 } });
      const loaded = new FileRefStore(path).load();
      expect(loaded).toEqual({ next: 4, refs: { "button|WLAN": 3 } });
    });
  });

  it("treats a corrupt file as empty instead of failing the command", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const store = new FileRefStore(path);
      await store.save({ next: 2, refs: {} });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "{not json");
      expect(new FileRefStore(path).load()).toBeNull();
    });
  });

  it("creates the parent directory", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "nested", "deeper", "refs.json");
      await new FileRefStore(path).save({ next: 2, refs: { a: 1 } });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ next: 2, refs: { a: 1 } });
    });
  });
});

describe("ScreenBuilder with a ref store", () => {
  it("gives the same element the same ref in a later process", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const first = new ScreenBuilder(new FileRefStore(path));
      const before = first.build(tree(), ctx);
      const home = before.elements.find((e) => e.label === "WLAN")!;
      await first.persist();

      // A separate CLI invocation starts a brand-new builder from the same file.
      const second = new ScreenBuilder(new FileRefStore(path));
      const after = second.build(tree(), ctx);
      expect(after.elements.find((e) => e.label === "WLAN")!.ref).toBe(home.ref);
    });
  });

  it("never reuses a number for a different element", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const first = new ScreenBuilder(new FileRefStore(path));
      const before = first.build(tree(), ctx);
      const highest = Math.max(...before.elements.map((e) => e.ref));
      await first.persist();

      const second = new ScreenBuilder(new FileRefStore(path));
      const after = second.build(tree(["WLAN", "Bluetooth", "Display", "Battery"]), ctx);
      const battery = after.elements.find((e) => e.label === "Battery")!;
      expect(battery.ref).toBeGreaterThan(highest);
    });
  });

  it("does not hand a dropped element's ref to a new element", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const first = new ScreenBuilder(new FileRefStore(path));
      const before = first.build(tree(["WLAN", "Bluetooth", "Display"]), ctx);
      const display = before.elements.find((e) => e.label === "Display")!;
      await first.persist();

      const second = new ScreenBuilder(new FileRefStore(path));
      const after = second.build(tree(["WLAN", "Bluetooth", "Battery"]), ctx);
      expect(after.elements.find((e) => e.label === "Battery")!.ref).not.toBe(display.ref);
    });
  });

  it("treats a moved element as a new element", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const first = new ScreenBuilder(new FileRefStore(path));
      const before = first.build(tree(["WLAN"]), ctx);
      const wlan = before.elements.find((e) => e.label === "WLAN")!;
      await first.persist();

      const moved = node({ bundleName: "com.demo" }, [
        node({ type: "Root", bounds: "[0,0][1000,2000]" }, [
          node({ type: "Button", text: "WLAN", clickable: "true", bounds: "[0,900][1000,1080]" }),
        ]),
      ]);
      const second = new ScreenBuilder(new FileRefStore(path));
      const after = second.build(moved, ctx);
      // Place is part of the identity, so the moved control is a new element.
      expect(after.elements.find((e) => e.label === "WLAN")!.ref).not.toBe(wlan.ref);
    });
  });

  it("writes nothing when the screen did not change", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "refs.json");
      const builder = new ScreenBuilder(new FileRefStore(path));
      builder.build(tree(), ctx);
      await builder.persist();
      const written = await readFile(path, "utf8");

      const again = new ScreenBuilder(new FileRefStore(path));
      again.build(tree(), ctx);
      expect(await again.persist()).toBe(false);
      expect(await readFile(path, "utf8")).toBe(written);
    });
  });
});
