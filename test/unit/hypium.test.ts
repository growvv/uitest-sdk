import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HypiumDriver, Gesture } from "../../src/hypium/index.js";
import { On } from "../../src/agent/selector.js";
import { ComponentHandle } from "../../src/agent/components.js";
import { UnsupportedError } from "../../src/errors.js";

interface Call {
  api: string;
  args: unknown[];
  thisRef: string;
}

type Handler = (args: unknown[], thisRef: string) => unknown;

function world(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const shellCalls: { cmd: string; timeoutMs?: number }[] = [];
  const hdcCalls: string[][] = [];
  const pushes: [string, string][] = [];
  const pulls: [string, string][] = [];
  let matrix = 0;
  let on = 0;
  const sleeps: number[] = [];

  const agent = {
    calls,
    async hypium(api: string, thisRef: string, args: unknown[]) {
      calls.push({ api, args, thisRef });
      const handler = handlers[api];
      if (handler) return handler(args, thisRef);
      if (api.startsWith("On.")) return `On#${on++}`;
      if (api === "PointerMatrix.create") return `PointerMatrix#${matrix++}`;
      if (api === "Driver.findComponent") return "Component#0";
      if (api === "Driver.findComponents") return ["Component#0", "Component#1"];
      if (api === "Driver.findWindow") return "UiWindow#0";
      if (api === "Driver.waitForComponent") return "Component#0";
      return null;
    },
    async touchDown(x: number, y: number) {
      calls.push({ api: "touchDown", args: [x, y], thisRef: "Gestures" });
    },
    async touchMove(x: number, y: number) {
      calls.push({ api: "touchMove", args: [x, y], thisRef: "Gestures" });
    },
    async touchUp(x: number, y: number) {
      calls.push({ api: "touchUp", args: [x, y], thisRef: "Gestures" });
    },
    async click(x: number, y: number) {
      calls.push({ api: "agent.click", args: [x, y], thisRef: "Agent" });
    },
    async getDisplaySize() {
      return { width: 1000, height: 2000 };
    },
    async getDisplayRotation() {
      return 0;
    },
    async captureScreen() {
      // A 2×2 white JPEG; enough for save/return tests.
      const jpeg = (await import("jpeg-js")).default;
      return jpeg.encode({ data: Buffer.alloc(2 * 2 * 4, 255), width: 2, height: 2 }, 90).data;
    },
    async triggerKey(code: number) {
      calls.push({ api: "agent.triggerKey", args: [code], thisRef: "Agent" });
    },
  };

  const hdc = {
    async shell(cmd: string, timeoutMs?: number) {
      shellCalls.push({ cmd, timeoutMs });
      const h = handlers[`shell:${cmd}`];
      // A handler answers with whatever the driver expects to parse; `shell`
      // itself always hands back a string.
      if (h) return String(h([], "shell"));
      return "";
    },
    async command(args: string[]) {
      hdcCalls.push(args);
      return "";
    },
    async push(local: string, remote: string) {
      pushes.push([local, remote]);
    },
    async pull(remote: string, local: string) {
      pulls.push([remote, local]);
    },
  };

  const driver = new HypiumDriver({
    agent: agent as never,
    hdc,
    deviceTag: "deadbeef",
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    log: { debug() {}, info() {}, warning() {}, error() {} },
  });

  return { driver, agent, hdc, calls, shellCalls, hdcCalls, pushes, pulls, sleeps };
}

describe("HypiumDriver · targets and actions", () => {
  it("converts ratio coordinates against the display size", async () => {
    const w = world();
    expect(await w.driver.toAbsPos(0.5, 0.25)).toEqual({ x: 500, y: 500 });
    expect(await w.driver.toAbsPos(100, 200)).toEqual({ x: 100, y: 200 });
  });

  it("clicks an absolute point through the cheap gesture channel", async () => {
    const w = world();
    await w.driver.click({ x: 10, y: 20 });
    expect(w.calls).toContainEqual({ api: "agent.click", args: [10, 20], thisRef: "Agent" });
  });

  it("clicks a ratio point in the center of the screen", async () => {
    const w = world();
    await w.driver.click([0.5, 0.5]);
    expect(w.calls).toContainEqual({ api: "agent.click", args: [500, 1000], thisRef: "Agent" });
  });

  it("clicks a selector at its bounds with an offset", async () => {
    const w = world({
      "Component.getBounds": () => ({ left: 100, top: 200, right: 300, bottom: 400, displayId: 0 }),
    });
    await w.driver.click(On.text("OK"), { offset: [0.25, 0.75] });
    expect(w.calls.some((c) => c.api === "On.text")).toBe(true);
    expect(w.calls).toContainEqual({ api: "agent.click", args: [150, 350], thisRef: "Agent" });
  });

  it("long-clicks by holding the pointer down for the requested time", async () => {
    const w = world();
    await w.driver.longClick({ x: 30, y: 40 }, { pressTime: 0.5 });
    expect(w.calls.filter((c) => c.api === "touchDown")).toHaveLength(1);
    expect(w.calls.filter((c) => c.api === "touchUp")).toHaveLength(1);
    expect(w.sleeps).toContain(500);
  });

  it("double-clicks twice", async () => {
    const w = world();
    await w.driver.doubleClick({ x: 30, y: 40 });
    expect(w.calls.filter((c) => c.api === "agent.click")).toHaveLength(2);
  });

  it("swipes up from the lower center of the area", async () => {
    const w = world();
    await w.driver.swipe("up", { distance: 50, durationMs: 200, steps: 4 });
    const down = w.calls.find((c) => c.api === "touchDown")!;
    // `findLast` needs ES2023, which the package's ES2022 target does not have.
    const up = w.calls.filter((c) => c.api === "touchUp").at(-1)!;
    expect(down.args[1] as number).toBeGreaterThan(up.args[1] as number);
    expect(down.args[0]).toBe(500);
  });

  it("drags after a long hold", async () => {
    const w = world();
    await w.driver.drag({ x: 100, y: 100 }, { x: 300, y: 300 }, { pressMs: 900, durationMs: 100 });
    expect(w.sleeps[0]).toBe(900);
    expect(w.calls.filter((c) => c.api === "touchMove").length).toBeGreaterThan(1);
  });

  it("injects a custom multi-step gesture through PointerMatrix", async () => {
    const w = world();
    const gesture = new Gesture().start([0.5, 0.8]).moveTo([0.5, 0.4], 0.2).pause(0.1);
    await w.driver.injectGesture(gesture, { durationMs: 500 });
    expect(w.calls.some((c) => c.api === "Driver.injectMultiPointerAction")).toBe(true);
    const create = w.calls.find((c) => c.api === "PointerMatrix.create")!;
    expect(create.args[0]).toBe(1);
    expect(create.args[1] as number).toBeGreaterThan(2);
  });

  it("multi-finger touch injects every finger at once", async () => {
    const w = world();
    await w.driver.multiFingerTouch([[0.2, 0.2], [0.8, 0.8]], { durationMs: 300 });
    const create = w.calls.find((c) => c.api === "PointerMatrix.create")!;
    expect(create.args[0]).toBe(2);
    expect(w.calls.some((c) => c.api === "Driver.injectMultiPointerAction")).toBe(true);
  });

  it("pinch-in moves two fingers toward the center", async () => {
    const w = world();
    await w.driver.pinchIn(undefined, { scale: 0.5, durationMs: 200 });
    const moves = w.calls.filter((c) => c.api === "PointerMatrix.setPoint");
    expect(moves.length).toBeGreaterThan(0);
    expect(w.calls.some((c) => c.api === "Driver.injectMultiPointerAction")).toBe(true);
  });
});

describe("HypiumDriver · keys, text and waits", () => {
  it("presses a single key through the agent", async () => {
    const w = world();
    await w.driver.pressKey("enter");
    expect(w.calls).toContainEqual({ api: "Driver.triggerKey", args: [2054], thisRef: "Driver#0" });
  });

  it("long-presses a key through uinput", async () => {
    const w = world();
    await w.driver.pressKey("power", undefined, "long");
    expect(w.shellCalls.some((c) => c.cmd === "uinput -K -l 26")).toBe(true);
  });

  it("presses a combination through one device call", async () => {
    const w = world();
    await w.driver.pressCombinationKey("volume_down", "power", "ctrl_left");
    expect(w.calls).toContainEqual({
      api: "Driver.triggerCombineKeys",
      args: [17, 26, 2072],
      thisRef: "Driver#0",
    });
  });

  it("types into a point with an input mode", async () => {
    const w = world();
    await w.driver.inputText({ x: 10, y: 20 }, "hello", { paste: true, addition: true });
    expect(w.calls).toContainEqual({
      api: "Driver.inputText",
      args: [{ x: 10, y: 20 }, "hello", { paste: true, addition: true }],
      thisRef: "Driver#0",
    });
  });

  it("waits for the device to report idle", async () => {
    const w = world();
    await w.driver.waitForIdle({ idleMs: 100, timeoutMs: 2000 });
    expect(w.calls).toContainEqual({
      api: "Driver.waitForIdle",
      args: [100, 2000],
      thisRef: "Driver#0",
    });
  });

  it("waits for a component and returns a handle", async () => {
    const w = world();
    const handle = await w.driver.waitForComponent(On.text("done"), { timeoutMs: 1500 });
    expect(handle?.ref).toBe("Component#0");
    expect(w.calls).toContainEqual({
      api: "Driver.waitForComponent",
      args: [expect.anything(), 1500],
      thisRef: "Driver#0",
    });
  });

  it("waits for a component to disappear with host polling", async () => {
    let n = 0;
    const w = world({
      "Driver.findComponent": () => (n++ < 2 ? "Component#0" : null),
    });
    const gone = await w.driver.waitForComponentDisappear(On.text("busy"), {
      timeoutMs: 2000,
      pollMs: 1,
    });
    expect(gone).toBeNull();
  });

  it("waits host-side for a fixed number of seconds", async () => {
    const w = world();
    await w.driver.wait(0.25);
    expect(w.sleeps).toContain(250);
  });
});

describe("HypiumDriver · components and windows", () => {
  it("finds a component and reads a property", async () => {
    const w = world({
      "Component.getText": () => "Hello",
      "Component.getId": () => "title",
      "Component.isEnabled": () => true,
    });
    const handle = await w.driver.findComponent(On.text("Hello"));
    expect(handle?.ref).toBe("Component#0");
    expect(await w.driver.getComponentProperty(handle!, "text")).toBe("Hello");
    expect(await w.driver.getComponentProperty(handle!, "id")).toBe("title");
    expect(await w.driver.getComponentProperty(handle!, "key")).toBe("title");
    expect(await w.driver.getComponentProperty(handle!, "enabled")).toBe(true);
  });

  it("rejects an unknown component property before touching the device", async () => {
    const w = world();
    const handle = new ComponentHandle(w.agent as never, "Component#0", On.text("x"));
    await expect(w.driver.getComponentProperty(handle, "colour")).rejects.toThrow(/unknown property/);
  });

  it("checks component properties without throwing on mismatch", async () => {
    const w = world({
      "Component.getText": () => "Save",
      "Component.isEnabled": () => false,
    });
    const handle = new ComponentHandle(w.agent as never, "Component#0", On.text("Save"));
    expect(await w.driver.checkComponent(handle, { text: "Save", enabled: false })).toBe(true);
    expect(await w.driver.checkComponent(handle, { text: "Cancel" })).toBe(false);
  });

  it("checks existence with and without a wait", async () => {
    const w = world({ "Driver.findComponent": () => "Component#0" });
    expect(await w.driver.checkComponentExist(On.text("x"))).toBe(true);
    expect(await w.driver.checkComponentExist(On.text("x"), { expectExist: false })).toBe(false);
  });

  it("finds a window by filter and reads its title and size", async () => {
    const w = world({
      "UiWindow.getTitle": () => "Settings",
      "UiWindow.getBounds": () => ({ left: 0, top: 0, right: 1000, bottom: 1800, displayId: 0 }),
      "UiWindow.isActive": () => true,
    });
    const win = await w.driver.findWindow({ bundleName: "com.example.settings" });
    expect(win?.ref).toBe("UiWindow#0");
    expect(w.calls).toContainEqual({
      api: "Driver.findWindow",
      args: [{ bundleName: "com.example.settings" }],
      thisRef: "Driver#0",
    });
    expect(await w.driver.checkWindow(win!, { title: "Settings" })).toBe(true);
    expect(await w.driver.getWindowSize()).toEqual({ width: 1000, height: 1800 });
  });

  it("falls back from the active window to the focused window", async () => {
    let n = 0;
    const w = world({ "Driver.findWindow": () => (n++ === 0 ? null : "UiWindow#1") });
    const win = await w.driver.getCurrentWindow();
    expect(win?.ref).toBe("UiWindow#1");
    expect(w.calls.filter((c) => c.api === "Driver.findWindow").map((c) => c.args[0])).toEqual([
      { actived: true },
      { focused: true },
    ]);
  });
});

describe("HypiumDriver · apps and files", () => {
  it("starts an app with an explicit ability", async () => {
    const w = world();
    const out = await w.driver.startApp("com.example.app", { ability: "EntryAbility", waitMs: 0 });
    expect(out).toContain("aa start -b com.example.app -a EntryAbility");
    expect(w.shellCalls.some((c) => c.cmd.startsWith("aa start"))).toBe(true);
  });

  it("refuses an invalid bundle id before building a shell command", async () => {
    const w = world();
    await expect(w.driver.startApp("x; rm -rf /", { ability: "A" })).rejects.toThrow(/invalid bundle/);
  });

  it("checks whether a file exists", async () => {
    const w = world({ "shell:ls '/data/local/tmp/x.txt'": () => "/data/local/tmp/x.txt" });
    expect(await w.driver.hasFile("/data/local/tmp/x.txt")).toBe(true);
    const empty = world({ "shell:ls '/nope'": () => "ls: /nope: No such file or directory" });
    expect(await empty.driver.hasFile("/nope")).toBe(false);
  });

  it("pulls and pushes files through hdc", async () => {
    const w = world();
    await w.driver.pullFile("/data/local/tmp/a.log");
    expect(w.pulls[0]).toEqual(["/data/local/tmp/a.log", "a.log"]);
    await w.driver.pushFile("local.txt", "/data/local/tmp/local.txt");
    expect(w.pushes[0]).toEqual(["local.txt", "/data/local/tmp/local.txt"]);
  });

  it("runs hdc connector commands", async () => {
    const w = world();
    await w.driver.hdc("list targets");
    expect(w.hdcCalls[0]).toEqual(["list", "targets"]);
  });

  it("reports device info without leaking the serial", async () => {
    const w = world({
      "shell:param get const.product.devicetype": () => "phone\n",
    });
    expect(await w.driver.getDeviceType()).toBe("phone");
    expect(await w.driver.deviceType()).toBe("phone");
    expect(await w.driver.sn()).toBe("deadbeef");
  });
});

describe("HypiumDriver · mouse, pen and hardware-gated APIs", () => {
  it("clicks the mouse with a button and modifier keys", async () => {
    const w = world();
    await w.driver.mouseClick({ x: 10, y: 20 }, { button: "right", keys: ["ctrl_left"] });
    expect(w.calls).toContainEqual({
      api: "Driver.mouseClick",
      args: [{ x: 10, y: 20 }, 1, 2072],
      thisRef: "Driver#0",
    });
  });

  it("scrolls the mouse wheel with a direction boolean", async () => {
    const w = world();
    await w.driver.mouseScroll({ x: 10, y: 20 }, "down", 3);
    expect(w.calls).toContainEqual({
      api: "Driver.mouseScroll",
      args: [{ x: 10, y: 20 }, true, 3],
      thisRef: "Driver#0",
    });
  });

  it("moves and drags the mouse with tracks", async () => {
    const w = world();
    await w.driver.mouseMove({ x: 0, y: 0 }, { x: 10, y: 10 }, { speed: 3000 });
    await w.driver.mouseDrag({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(w.calls.some((c) => c.api === "Driver.mouseMoveWithTrack")).toBe(true);
    expect(w.calls.some((c) => c.api === "Driver.mouseDrag")).toBe(true);
  });

  it("sends pen clicks with pressure", async () => {
    const w = world();
    await w.driver.penClick({ x: 10, y: 20 });
    await w.driver.penLongClick({ x: 10, y: 20 }, { pressure: 0.4 });
    expect(w.calls).toContainEqual({
      api: "Driver.penClick",
      args: [{ x: 10, y: 20 }],
      thisRef: "Driver#0",
    });
    expect(w.calls).toContainEqual({
      api: "Driver.penLongClick",
      args: [{ x: 10, y: 20 }, 0.4],
      thisRef: "Driver#0",
    });
  });

  it("turns a device capability error into UnsupportedError", async () => {
    const w = world({
      "Driver.crownRotate": () => {
        throw new Error("Capability not support");
      },
    });
    const err = await w.driver.rotateCrown(2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect((err as Error).message).toMatch(/rotateCrown/);
  });

  it("reports the toast observer as unavailable instead of hanging", async () => {
    const w = world();
    await expect(w.driver.startListenToast()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(w.driver.getLatestToast()).rejects.toBeInstanceOf(UnsupportedError);
    expect(w.calls.some((c) => c.api === "Driver.getRecentUiEvent")).toBe(false);
  });
});

describe("HypiumDriver · hooks and lifecycle", () => {
  it("fires ui_action_start hooks before an action", async () => {
    const w = world();
    const seen: string[] = [];
    w.driver.addHook("ui_action_start", "h1", (event) => seen.push(String(event.point)));
    await w.driver.click({ x: 1, y: 2 });
    expect(seen).toEqual(["1,2"]);
  });

  it("removes one hook and all hooks", async () => {
    const w = world();
    let n = 0;
    w.driver.addHook("ui_action_start", "h1", () => n++);
    w.driver.addHook("ui_action_start", "h2", () => n++);
    w.driver.removeHook("ui_action_start", "h1");
    await w.driver.click({ x: 1, y: 2 });
    expect(n).toBe(1);
    w.driver.removeAllHooks("ui_action_start");
    await w.driver.click({ x: 1, y: 2 });
    expect(n).toBe(1);
  });

  it("close clears hooks without closing the shared connection", async () => {
    const w = world();
    let n = 0;
    w.driver.addHook("ui_action_start", "h1", () => n++);
    w.driver.close();
    await w.driver.click({ x: 1, y: 2 });
    expect(n).toBe(0);
  });

  it("keeps an implicit wait used by findComponent", async () => {
    let waited = 0;
    const w = world({
      "Driver.findComponent": () => null,
      "Driver.waitForComponent": () => {
        waited++;
        return "Component#9";
      },
    });
    w.driver.setImplicitWaitTime(2);
    expect(w.driver.getImplicitWaitTime()).toBe(2);
    const handle = await w.driver.findComponent(On.text("late"));
    expect(waited).toBe(1);
    expect(handle?.ref).toBe("Component#9");
  });
});

describe("HypiumDriver · screenshots and files", () => {
  it("returns a buffer when no path is requested", async () => {
    const w = world();
    const out = await w.driver.captureScreen();
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  it("saves a JPEG to the host and returns the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hypium-shot-"));
    const path = join(dir, "shot.jpeg");
    const w = world();
    const out = await w.driver.captureScreen({ savePath: path });
    expect(out).toBe(path);
    expect(readFileSync(path).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("captures to the device when inPc is false", async () => {
    const w = world({ "shell:ls '/data/local/tmp/s.jpeg'": () => "/data/local/tmp/s.jpeg" });
    const out = await w.driver.captureScreen({
      savePath: "/data/local/tmp/s.jpeg",
      inPc: false,
    });
    expect(out).toBe("/data/local/tmp/s.jpeg");
    expect(w.shellCalls.some((c) => c.cmd.includes("screenCap"))).toBe(true);
  });
});

describe("HypiumDriver · rotation", () => {
  it("reads and sets rotation through the agent", async () => {
    const w = world();
    expect(await w.driver.getDisplayRotation()).toBe(0);
    await w.driver.setDisplayRotation(1);
    expect(w.calls).toContainEqual({
      api: "Driver.setDisplayRotation",
      args: [1],
      thisRef: "Driver#0",
    });
    await w.driver.setDisplayRotationEnabled(false);
    expect(w.calls).toContainEqual({
      api: "Driver.setDisplayRotationEnabled",
      args: [false],
      thisRef: "Driver#0",
    });
  });

  it("rejects the named rotations the device cannot accept", async () => {
    // Measured: the extension's argument checker takes an integer only —
    // "left" fails with "Expect integer which cannot be less than 0".
    const w = world();
    await expect(w.driver.setDisplayRotation("left" as never)).rejects.toThrow(/integer/);
    expect(w.calls.some((c) => c.api === "Driver.setDisplayRotation")).toBe(false);
  });
});
