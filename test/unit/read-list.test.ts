import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../../src/operations/session.js";
import { On } from "../../src/driver/agent/selector.js";
import type { UiNode } from "../../src/transport/model.js";

const listPage = (labels: string[]): UiNode => ({
  attributes: { type: "Root", bounds: "[0,0][1000,2000]", bundleName: "com.demo" },
  children: [
    {
      attributes: { type: "List", bounds: "[0,200][1000,1800]", scrollable: "true" },
      children: labels.map((label, i) => ({
        attributes: {
          type: "ListItem",
          bounds: `[0,${250 + i * 200}][1000,${400 + i * 200}]`,
          clickable: "true",
        },
        children: [{ attributes: { type: "Text", text: label, bounds: `[40,${270 + i * 200}][600,${360 + i * 200}]` } }],
      })),
    },
  ],
});

function device(pages: UiNode[]) {
  let index = 0;
  const actions: string[] = [];
  return {
    actions,
    device: {
      deviceId: "SERIAL",
      agent: {
        async hypium(api: string) {
          if (api === "Driver.waitForIdle") return true;
          if (api === "Driver.findComponent") return null;
          return null;
        },
        async captureLayout() {
          return pages[Math.min(index, pages.length - 1)]!;
        },
        async getDisplaySize() {
          return { width: 1000, height: 2000 };
        },
        async getDisplayRotation() {
          return 0;
        },
        async captureScreen() {
          return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        },
        async touchDown() {
          actions.push("down");
        },
        async touchMove() {
          actions.push("move");
        },
        async touchUp() {
          actions.push("up");
          index = Math.min(index + 1, pages.length - 1);
        },
        // Read-list only reads and swipes; these exist so the fake satisfies
        // `SessionAgent` rather than relying on a cast.
        async click() {},
        async inputText() {},
        async triggerKey() {},
      },
      hdc: {
        async shell() {
          return "";
        },
      },
      async dispose() {},
    },
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-list-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Session.readList", () => {
  it("reads a short list and stops after one fruitless scroll", async () => {
    await withDir(async (dir) => {
      const fake = device([listPage(["Alpha", "Beta", "Gamma"])]);
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true, settleMs: 300,
      });
      const r = await s.readList();
      expect(r.status).toBe("settled");
      expect(r.items).toEqual(["Alpha", "Beta", "Gamma"]);
      // A list that does not say "no more" gets one scroll to prove it; the
      // unchanged screen then ends the read.
      expect(fake.actions.filter((a) => a === "up")).toHaveLength(1);
      expect(r.screens).toBe(1);
      await s.release();
    });
  });

  it("scrolls and merges pages, dropping the repeated overlap", async () => {
    await withDir(async (dir) => {
      const fake = device([
        listPage(["Alpha", "Beta", "Gamma"]),
        listPage(["Beta", "Gamma", "Delta"]),
        listPage(["Gamma", "Delta", "Epsilon"]),
        listPage(["Delta", "Epsilon", "Zeta"]),
      ]);
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true, settleMs: 300,
      });
      const r = await s.readList({ maxScreens: 4 });
      expect(r.items).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]);
      expect(fake.actions).toContain("up");
      await s.release();
    });
  });

  it("stops when a scroll no longer reveals anything new", async () => {
    await withDir(async (dir) => {
      const fake = device([listPage(["Alpha", "Beta"]), listPage(["Alpha", "Beta"])]);
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true, settleMs: 300,
      });
      const r = await s.readList({ maxScreens: 5 });
      expect(r.items).toEqual(["Alpha", "Beta"]);
      expect(r.complete).toBe(false);
      await s.release();
    });
  });

  it("answers from the screen when the target is already visible", async () => {
    await withDir(async (dir) => {
      const calls: string[] = [];
      const fake = device([listPage(["Alpha", "Beta"])]);
      fake.device.agent.hypium = (async (api: string) => {
        calls.push(api);
        if (api === "Driver.waitForIdle") return true;
        if (api.startsWith("On.")) return "On#0";
        if (api === "Driver.findComponent") return "Component#0";
        return null;
      }) as typeof fake.device.agent.hypium;
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true,
      });
      const r = await s.scrollUntilVisible({ text: "Beta" });
      expect(r.status).toBe("settled");
      // A visible label needs no scroll at all, on the device or in the host.
      expect(calls).not.toContain("Component.scrollSearch");
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });

  it("pages with swipes when the target is below the fold", async () => {
    await withDir(async (dir) => {
      const fake = device([listPage(["Alpha"]), listPage(["Alpha", "Beta"])]);
      fake.device.agent.hypium = (async (api: string) => {
        if (api === "Driver.waitForIdle") return true;
        if (api.startsWith("On.")) return "On#0";
        if (api === "Driver.findComponent") return null;
        return null;
      }) as typeof fake.device.agent.hypium;
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true, settleMs: 300,
      });
      const r = await s.scrollUntilVisible({ text: "Beta" }, { maxScreens: 3 });
      expect(r.status).toBe("settled");
      expect(fake.actions).toContain("up");
      await s.release();
    });
  });

  it("never calls scrollSearch, which hangs the device for 30 s on a miss", async () => {
    await withDir(async (dir) => {
      const calls: string[] = [];
      const fake = device([listPage(["Alpha"]), listPage(["Alpha"])]);
      fake.device.agent.hypium = (async (api: string) => {
        calls.push(api);
        if (api === "Driver.waitForIdle") return true;
        if (api.startsWith("On.")) return "On#0";
        if (api === "Driver.findComponent") return "Component#0";
        if (api === "Component.scrollSearch") return null;
        return null;
      }) as typeof fake.device.agent.hypium;
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true, settleMs: 300,
      });
      await s.scrollUntilVisible({ text: "Zeta" }, { maxScreens: 2 });
      // Measured on the device: a miss times out after 30 s and leaves the
      // global lock held, so every later command fails with "Disallow
      // concurrent use". Paging the host-side way costs a scroll and never
      // touches that path.
      expect(calls).not.toContain("Component.scrollSearch");
      await s.release();
    });
  });

  it("reports not_found when the target never appears", async () => {
    await withDir(async (dir) => {
      const fake = device([listPage(["Alpha"]), listPage(["Alpha"])]);
      fake.device.agent.hypium = (async (api: string) => {
        if (api === "Driver.waitForIdle") return true;
        if (api.startsWith("On.")) return "On#0";
        return null;
      }) as typeof fake.device.agent.hypium;
      const s = await Session.open(fake.device, {
        task: "t", stateDir: dir, lease: { dir }, noTrace: true, settleMs: 300,
      });
      const r = await s.scrollUntilVisible(On.text("Zeta"), { maxScreens: 2 });
      expect(r.status).toBe("not_found");
      await s.release();
    });
  });
});
