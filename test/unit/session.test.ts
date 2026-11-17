import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { Session, tagOf } from "../../src/session.js";
import { On } from "../../src/agent/selector.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (type: string, attrs: Record<string, unknown>, children: UiNode[] = []): UiNode => ({
  attributes: { type, ...attrs } as UiNode["attributes"],
  children,
});

const page = (text: string, extra: UiNode[] = [], bundle = "com.demo"): UiNode =>
  node("Root", { bounds: "[0,0][1000,2000]", bundleName: bundle }, [
    node("Button", { text, bounds: "[100,200][300,400]", clickable: "true" }),
    ...extra,
  ]);

const lockPage = (): UiNode =>
  node("Root", { bounds: "[0,0][1000,2000]", bundleName: "SCBScreenLock13" }, [
    node("Button", { text: "ScreenLockWidgetView 9:41", bounds: "[100,200][900,400]", clickable: "true" }),
  ]);

const solidJpeg = () =>
  jpeg.encode({ data: Buffer.alloc(20 * 40 * 4, 0x11), width: 20, height: 40 }, 80).data;

interface Call {
  api: string;
  thisRef: string;
  args: unknown[];
}

function fakeDevice(trees: UiNode[]) {
  let index = 0;
  const calls: Call[] = [];
  const actions: { kind: string; args: unknown[] }[] = [];
  const device = {
    deviceId: "SERIAL0123456789",
    agent: {
      async hypium(api: string, thisRef: string, args: unknown[]) {
        calls.push({ api, thisRef, args });
        if (api === "Driver.waitForIdle") return true;
        if (api.startsWith("On.")) return "On#0";
        if (api === "Driver.findComponent") return "Component#0";
        if (api === "Driver.waitForComponent") return "Component#0";
        if (api === "Driver.findWindow") return "UiWindow#0";
        if (api === "PointerMatrix.create") return "PointerMatrix#0";
        if (api === "Component.getBounds") return { left: 100, top: 200, right: 300, bottom: 400 };
        if (api === "Component.click" || api === "Component.doubleClick" || api === "Component.longClick") {
          actions.push({ kind: api, args: [] });
          index = Math.min(index + 1, trees.length - 1);
          return null;
        }
        if (api === "Driver.triggerKey") {
          actions.push({ kind: "key", args });
          index = Math.min(index + 1, trees.length - 1);
          return null;
        }
        return null;
      },
      async captureLayout() {
        return trees[Math.min(index, trees.length - 1)]!;
      },
      async getDisplaySize() {
        return { width: 1000, height: 2000 };
      },
      async getDisplayRotation() {
        return 0;
      },
      async captureScreen() {
        return Buffer.from(solidJpeg());
      },
      async click(x: number, y: number) {
        actions.push({ kind: "click", args: [x, y] });
        index = Math.min(index + 1, trees.length - 1);
      },
      async touchDown(x: number, y: number) {
        actions.push({ kind: "touchDown", args: [x, y] });
      },
      async touchMove(x: number, y: number) {
        actions.push({ kind: "touchMove", args: [x, y] });
      },
      async touchUp(x: number, y: number) {
        actions.push({ kind: "touchUp", args: [x, y] });
      },
      async inputText(x: number, y: number, text: string) {
        actions.push({ kind: "inputText", args: [x, y, text] });
      },
      async triggerKey(code: number) {
        actions.push({ kind: "key", args: [code] });
        index = Math.min(index + 1, trees.length - 1);
      },
    },
    hdc: {
      async shell(command: string) {
        if (command === "bm dump -a") return "com.demo";
        if (command === "aa dump -l") return "";
        if (command.startsWith("bm dump -n")) return "";
        return "";
      },
    },
    async dispose() {},
  };
  return {
    device,
    calls,
    actions,
    get index() {
      return index;
    },
    setIndex(i: number) {
      index = i;
    },
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-session-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function open(fake: ReturnType<typeof fakeDevice>, dir: string, opts = {}) {
  return Session.open(fake.device, {
    task: "test",
    stateDir: dir,
    lease: { dir },
    traceShots: false,
    ...opts,
  });
}

describe("Session: observe", () => {
  it("returns the rendered screen", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const r = await s.observe();
      expect(r.status).toBe("settled");
      expect(r.screen?.bundle).toBe("com.demo");
      expect(r.screen?.lines.join("\n")).toContain('"WLAN"');
      await s.release();
    });
  });

  it("writes a screenshot when asked", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const file = join(dir, "shots", "a.jpg");
      const r = await s.observe({ out: file });
      expect(r.status).toBe("settled");
      const { stat } = await import("node:fs/promises");
      expect((await stat(file)).size).toBeGreaterThan(0);
      await s.release();
    });
  });
});

describe("Session: device state", () => {
  it("reports device_locked for the lock screen and refuses to act on it", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([lockPage()]);
      const s = await open(fake, dir);
      const observed = await s.observe();
      expect(observed.status).toBe("device_locked");
      expect(observed.screen?.locked).toBe(true);

      const tapped = await s.tap(1);
      expect(tapped.status).toBe("device_locked");
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });
});

describe("Session: standing approvals", () => {
  const deletePage = () => page("删除");

  it("remembers an approval for the task, and only for that task", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([deletePage(), deletePage(), deletePage()]);
      const s = await open(fake, dir, { task: "cleanup" });
      const observed = await s.observe();
      const ref = observed.screen!.elements.find((e) => e.label === "删除")!.ref;
      const asked = await s.tap(ref);
      expect(asked.status).toBe("approval_pending");
      const approved = await s.tap(ref, {
        approvalId: (asked as { approvalId: string }).approvalId,
        approvalScope: "task",
      });
      expect(approved.status).toBe("settled");
      await s.release();

      // One command per process is the CLI's normal shape: a new Session
      // with the same task must skip the question.
      const same = await open(fake, dir, { task: "cleanup" });
      expect((await same.tap(ref)).status).toBe("settled");
      await same.release();

      const other = await open(fake, dir, { task: "other" });
      expect((await other.tap(ref)).status).toBe("approval_pending");
      await other.release();
    });
  });

  it("remembers an always approval across tasks in the same state dir", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([deletePage(), deletePage()]);
      const s = await open(fake, dir, { task: "cleanup" });
      const observed = await s.observe();
      const ref = observed.screen!.elements.find((e) => e.label === "删除")!.ref;
      const asked = await s.tap(ref);
      const approved = await s.tap(ref, {
        approvalId: (asked as { approvalId: string }).approvalId,
        approvalScope: "always",
      });
      expect(approved.status).toBe("settled");
      await s.release();

      const other = await open(fake, dir, { task: "another task" });
      expect((await other.tap(ref)).status).toBe("settled");
      await other.release();
    });
  });

  it("forgets task grants when the person hands the phone back", async () => {
    await withDir(async (dir) => {
      const { Grants } = await import("../../src/approvals.js");
      const { resumeDevice } = await import("../../src/hold.js");
      const tag = tagOf("SERIAL");
      const path = join(dir, `grants-${tag}.json`);
      const grants = await Grants.open(path);
      grants.add({ rule: "deletes", bundle: "com.demo", task: "cleanup", scope: "task" });
      grants.add({ rule: "deletes", bundle: "com.demo", task: null, scope: "always" });

      const { holdDevice } = await import("../../src/hold.js");
      await holdDevice({ stateDir: dir, tag });
      expect(await resumeDevice({ stateDir: dir, tag })).toBe(true);

      const after = await Grants.open(path);
      expect(after.list().filter((g) => g.scope === "task")).toHaveLength(0);
      expect(after.list().filter((g) => g.scope === "always")).toHaveLength(1);
    });
  });
});

describe("Session: tap", () => {
  it("taps a ref at the element's center", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN"), page("WLAN", [node("Text", { text: "connected", bounds: "[100,500][300,600]" })])]);
      const s = await open(fake, dir);
      const before = await s.observe();
      const ref = before.screen!.elements.find((e) => e.label === "WLAN")!.ref;
      const r = await s.tap(ref);
      expect(r.status).toBe("settled");
      expect(fake.actions).toContainEqual({ kind: "click", args: [200, 300] });
      expect(r.diff?.added.length ?? 0).toBeGreaterThan(0);
      await s.release();
    });
  });

  it("reports not_found for a ref that is no longer on screen", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const r = await s.tap(999);
      expect(r.status).toBe("not_found");
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });

  it("taps text through the device-side component", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN"), page("WLAN detail")]);
      const s = await open(fake, dir);
      const r = await s.tap({ text: "WLAN" });
      expect(r.status).toBe("settled");
      expect(fake.actions).toContainEqual({ kind: "Component.click", args: [] });
      await s.release();
    });
  });

  it("waits for approval instead of touching the device", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("付款")]);
      const s = await open(fake, dir);
      const r = await s.tap({ text: "付款" });
      expect(r.status).toBe("approval_pending");
      expect(r.status === "approval_pending" && r.rule).toBe("payments");
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });

  it("runs the step when the approval id matches", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("付款"), page("付款 done")]);
      const s = await open(fake, dir);
      const pending = await s.tap({ text: "付款" });
      const id = pending.status === "approval_pending" ? pending.approvalId : "";
      const r = await s.tap({ text: "付款" }, { approvalId: id });
      expect(r.status).toBe("settled");
      expect(fake.actions).toContainEqual({ kind: "Component.click", args: [] });
      await s.release();
    });
  });

  it("refuses an approval issued for a different step", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("付款")]);
      const s = await open(fake, dir);
      const pending = await s.tap({ text: "付款" });
      const id = pending.status === "approval_pending" ? pending.approvalId : "";
      const r = await s.tap({ text: "WLAN" }, { approvalId: id });
      expect(r.status).toBe("approval_denied");
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });

  it("blocks a step the policy refuses outright", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("删除")]);
      const s = await open(fake, dir, { policy: { confirm: "all", readOnly: true } });
      const r = await s.tap({ text: "删除" });
      expect(r.status).toBe("blocked");
      expect(r.status === "blocked" && r.rule).toBe("read-only");
      await s.release();
    });
  });

  it("refuses an app outside the allow-list", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir, { policy: { apps: ["com.some.other"] } });
      const r = await s.tap(1);
      expect(r.status).toBe("blocked");
      expect(r.status === "blocked" && r.rule).toBe("scope");
      await s.release();
    });
  });

  it("taps a selector through the device and reports not_found on a miss", async () => {
    await withDir(async (dir) => {
      const dev = fakeDevice([page("WLAN"), page("WLAN")]);
      // A selector that the device cannot resolve.
      dev.device.agent.hypium = (async (api: string, thisRef: string, args: unknown[]) => {
        dev.calls.push({ api, thisRef, args });
        if (api === "Driver.waitForIdle") return true;
        if (api.startsWith("On.")) return "On#0";
        if (api === "Driver.findComponent") return null;
        if (api === "Driver.findComponents") return [];
        if (api === "Driver.findWindow") return null;
        return null;
      }) as typeof dev.device.agent.hypium;
      const s = await open(dev, dir);
      const r = await s.tapSelector(On.text("nope"));
      expect(r.status).toBe("not_found");
      await s.release();
    });
  });
});

describe("Session: type", () => {
  it("types into the focused input", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([
        page("Search", [
          node("TextInput", { text: "query", bounds: "[100,700][900,800]", focused: "true" }),
        ]),
      ]);
      const s = await open(fake, dir);
      const r = await s.type("hello");
      expect(r.status).toBe("settled");
      expect(fake.actions).toContainEqual({ kind: "inputText", args: [500, 750, "hello"] });
      await s.release();
    });
  });

  it("refuses to type in read-only mode", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([
        page("Name", [
          node("TextInput", { text: "", bounds: "[100,700][900,800]", focused: "true" }),
        ]),
      ]);
      const s = await open(fake, dir, { policy: { readOnly: true } });
      const r = await s.type("hello");
      expect(r.status).toBe("blocked");
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });

  it("reports not_found when there is no input", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      expect((await s.type("hello")).status).toBe("not_found");
      await s.release();
    });
  });
});

describe("Session: keys and gestures", () => {
  it("presses a named key", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("a"), page("b")]);
      const s = await open(fake, dir);
      const r = await s.pressKey("back");
      expect(r.status).toBe("settled");
      expect(fake.actions).toContainEqual({ kind: "key", args: [2] });
      await s.release();
    });
  });

  it("swipes between two points", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("a"), page("b")]);
      const s = await open(fake, dir);
      const r = await s.swipe({ from: { x: 500, y: 1500 }, to: { x: 500, y: 500 }, steps: 2 });
      expect(r.status).toBe("settled");
      expect(fake.actions.filter((a) => a.kind === "touchMove")).toHaveLength(2);
      expect(fake.actions.at(-1)).toEqual({ kind: "touchUp", args: [500, 500] });
      await s.release();
    });
  });

  it("rejects a malformed swipe without touching the device", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("a")]);
      const s = await open(fake, dir);
      await expect(s.swipe({ from: { x: 1, y: 2 } } as never)).rejects.toThrow(/to/);
      expect(fake.actions).toHaveLength(0);
      await s.release();
    });
  });
});

describe("Session: window", () => {
  it("reports the focused window's bounds and bundle", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const original = fake.device.agent.hypium;
      fake.device.agent.hypium = (async (api: string, thisRef: string, args: unknown[]) => {
        if (api === "UiWindow.getBounds") {
          return { left: 0, top: 100, right: 1000, bottom: 1900 };
        }
        if (api === "UiWindow.getBundleName") return "com.demo";
        if (api === "UiWindow.isFocused") return true;
        return original.call(fake.device.agent, api, thisRef, args);
      }) as typeof fake.device.agent.hypium;
      const s = await open(fake, dir);
      const w = await s.window({ focused: true });
      expect(w.status).toBe("settled");
      expect(w.bundle).toBe("com.demo");
      expect(w.focused).toBe(true);
      expect(w.bounds).toEqual({ x: 0, y: 100, width: 1000, height: 1800 });
      expect(fake.calls.find((c) => c.api === "Driver.findWindow")!.args).toEqual([{ focused: true }]);
      await s.release();
    });
  });

  it("is not_found when no window matches", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const original = fake.device.agent.hypium;
      fake.device.agent.hypium = async (api: string, thisRef: string, args: unknown[]) => {
        if (api === "Driver.findWindow") return null;
        return original.call(fake.device.agent, api, thisRef, args);
      };
      const s = await open(fake, dir);
      const w = await s.window({ bundleName: "com.gone" });
      expect(w.status).toBe("not_found");
      await s.release();
    });
  });

  it("closes a window through the handle", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const r = await s.window({ focused: true }, { close: true });
      expect(r.status).toBe("settled");
      expect(fake.calls.map((c) => c.api)).toContain("UiWindow.close");
      await s.release();
    });
  });
});

describe("Session: pinch", () => {
  it("pinches around a point", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const r = await s.pinch({ center: { x: 500, y: 900 }, from: 200, to: 400 });
      expect(r.status).toBe("settled");
      const create = fake.calls.find((c) => c.api === "PointerMatrix.create")!;
      expect(create.args[0]).toBe(2);
      expect(fake.calls.some((c) => c.api === "Driver.injectMultiPointerAction")).toBe(true);
      await s.release();
    });
  });

  it("pinches inside the element at a ref", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const observed = await s.observe();
      const ref = observed.screen!.elements[0]!.ref;
      const r = await s.pinch({ ref, scale: 2 });
      expect(r.status).toBe("settled");
      // The fingers start inside the element, so the center is its middle.
      const setPoint = fake.calls.find((c) => c.api === "PointerMatrix.setPoint")!;
      expect(setPoint.args[2]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
      await s.release();
    });
  });

  it("is not_found when the ref is gone", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      const r = await s.pinch({ ref: 999 });
      expect(r.status).toBe("not_found");
      await s.release();
    });
  });
});

describe("Session: waitFor", () => {
  it("uses the device-side wait and settles on a hit", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN"), page("WLAN")]);
      const s = await open(fake, dir);
      const r = await s.waitFor({ text: "WLAN" }, { timeoutMs: 1000 });
      expect(r.status).toBe("settled");
      expect(fake.calls.some((c) => c.api === "Driver.waitForComponent")).toBe(true);
      await s.release();
    });
  });

  it("reports not_found on a timeout", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      fake.device.agent.hypium = (async (api: string, thisRef: string, args: unknown[]) => {
        fake.calls.push({ api, thisRef, args });
        if (api === "Driver.waitForIdle") return true;
        if (api === "Driver.waitForComponent") return null;
        if (api.startsWith("On.")) return "On#0";
        return null;
      }) as typeof fake.device.agent.hypium;
      const s = await open(fake, dir);
      const r = await s.waitFor({ text: "nope" }, { timeoutMs: 50 });
      expect(r.status).toBe("not_found");
      await s.release();
    });
  });
});

describe("Session: trace and lease", () => {
  it("records every step and redacts the serial", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN"), page("ok")]);
      const s = await open(fake, dir);
      await s.observe();
      await s.tap(1);
      const records = s.trace!.records();
      expect(records.map((r) => r.command)).toEqual(["observe", "tap"]);
      expect(JSON.stringify(records)).not.toContain("SERIAL0123456789");
      await s.release();
    });
  });

  it("holds the lease until release", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const first = await open(fake, dir);
      const second = Session.open(fake.device, {
        task: "other", stateDir: dir, lease: { dir },
      });
      await expect(second).rejects.toThrow(/lease_held/);
      await first.release();
      const third = await Session.open(fake.device, {
        task: "other", stateDir: dir, lease: { dir },
      });
      await third.release();
    });
  });

  it("releases the lease when disposed", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([page("WLAN")]);
      const s = await open(fake, dir);
      await s.release();
      const again = await open(fake, dir);
      await again.release();
    });
  });
});

describe("Session: credential redaction", () => {
  it("keeps codes out of the result and the screenshot", async () => {
    await withDir(async (dir) => {
      const fake = fakeDevice([
        page("Your code is 482913", [
          node("TextInput", { text: "hunter2", password: "true", bounds: "[100,700][300,800]" }),
        ]),
      ]);
      const s = await open(fake, dir);
      const file = join(dir, "shots", "code.jpg");
      const r = await s.observe({ out: file });
      const text = r.screen!.lines.join("\n");
      expect(text).not.toContain("482913");
      expect(text).toContain("••••••");

      // The screenshot must not show what the text does not say. The button
      // occupies display [100,200]-[300,400]; the frame is 20x40 for a
      // 1000x2000 display, so its center is frame (4,6).
      const decoded = jpeg.decode(await (await import("node:fs/promises")).readFile(file));
      const i = (6 * decoded.width + 4) * 4;
      const channels = [decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]];
      for (const c of channels) {
        expect(c).toBeGreaterThan(110);
        expect(c).toBeLessThan(150);
      }
      await s.release();
    });
  });
});
