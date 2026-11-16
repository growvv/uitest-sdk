import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { CommandRunner, COMMANDS } from "../../src/commands.js";
import { Session, tagOf } from "../../src/session.js";
import { holdDevice, resumeDevice } from "../../src/hold.js";
import { readLease } from "../../src/lease.js";
import type { UiNode } from "../../src/model.js";

const page = (text: string): UiNode => ({
  attributes: { type: "Root", bounds: "[0,0][1000,2000]", bundleName: "com.demo" },
  children: [
    { attributes: { type: "Button", text, bounds: "[100,200][400,400]", clickable: "true" } },
    { attributes: { type: "TextInput", text: "q", bounds: "[100,700][900,800]", focused: "true" } },
  ],
});

function fakeDevice() {
  let index = 0;
  const calls: { api: string; args: unknown[] }[] = [];
  const pages = [page("WLAN"), page("WLAN detail")];
  return {
    calls,
    device: {
      deviceId: "SERIAL",
      agent: {
        async hypium(api: string, _thisRef: string, args: unknown[]) {
          calls.push({ api, args });
          if (api === "Driver.waitForIdle") return true;
          if (api.startsWith("On.")) return "On#0";
          if (api === "Driver.findComponent") return "Component#0";
          if (api === "Driver.waitForComponent") return "Component#0";
          if (api === "PointerMatrix.create") return "PointerMatrix#0";
          if (api === "Driver.findWindow") {
            // Only a window for com.demo exists; anything else is not_found.
            return (args[0] as { bundleName?: string } | undefined)?.bundleName === "com.gone"
              ? null
              : "UiWindow#0";
          }
          if (api === "UiWindow.getBounds") return { left: 0, top: 100, right: 1000, bottom: 1900 };
          if (api === "UiWindow.getBundleName") return "com.demo";
          if (api === "UiWindow.isFocused") return true;
          if (api === "Component.getBounds") return { left: 100, top: 200, right: 400, bottom: 400 };
          if (api === "Component.click") index = Math.min(index + 1, pages.length - 1);
          if (api === "Driver.triggerKey") index = Math.min(index + 1, pages.length - 1);
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
          return Buffer.from(
            jpeg.encode({ data: Buffer.alloc(20 * 40 * 4, 0x22), width: 20, height: 40 }, 80).data,
          );
        },
        async click() {
          index = Math.min(index + 1, pages.length - 1);
        },
        async touchDown() {},
        async touchMove() {},
        async touchUp() {},
        async inputText(_x: number, _y: number, _text: string, mode?: unknown) {
          calls.push({ api: "inputText", args: [mode] });
        },
        async triggerKey() {},
      },
      hdc: {
        async shell(command: string) {
          if (command === "bm dump -a") return "com.demo";
          if (command === "aa dump -l") {
            return [
              "  current mission lists:{",
              "    Mission ID #1  mission name #[#com.demo:EntryAbility]",
              "      app name [com.demo]",
              "      main name [EntryAbility]",
              "      bundle name [com.demo]",
              "      state #FOREGROUND",
              "  }",
            ].join("\n");
          }
          return "";
        },
        async listTargets() {
          return ["SERIAL"];
        },
      },
      async dispose() {},
    },
  };
}

/** The input mode each type command passed to the device, in order. */
function textModes(fake: ReturnType<typeof fakeDevice>): unknown[] {
  return fake.calls.filter((c) => c.api === "inputText").map((c) => c.args[0]);
}

async function withRunner<T>(
  fn: (runner: CommandRunner, dir: string, fake: ReturnType<typeof fakeDevice>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-cmd-"));
  const fake = fakeDevice();
  const session = await Session.open(fake.device, {
    // The same `<state-dir>/leases` the hold commands write, so the test can
    // take the device away from a live session the way a person does.
    task: "t", stateDir: dir, lease: { dir: join(dir, "leases") }, settleMs: 300,
  });
  const runner = new CommandRunner(session, { stateDir: dir, device: fake.device });
  try {
    return await fn(runner, dir, fake);
  } finally {
    await session.release();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("COMMANDS", () => {
  it("lists every command with a description and its args", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "observe", "tap", "type", "swipe", "key", "wait-for", "read-list",
        "launch", "apps", "doctor", "screenshot", "inspect", "report", "scroll-until",
      ]),
    );
    for (const command of COMMANDS) {
      expect(command.description.length).toBeGreaterThan(10);
      expect(command.args).toBeDefined();
    }
  });

  it("names a ref argument the same way in every command that takes one", () => {
    const withRef = COMMANDS.filter((c) => "ref" in c.args);
    expect(withRef.length).toBeGreaterThan(0);
    for (const command of withRef) expect(command.args.ref!.type).toBe("number");
  });
});

describe("CommandRunner", () => {
  it("runs observe", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("observe", {});
      expect(r.status).toBe("settled");
      expect(r.text).toContain("com.demo");
      expect(r.data?.elements).toBeGreaterThan(0);
    });
  });

  it("writes an annotated image and a node table for inspect", async () => {
    await withRunner(async (runner, dir) => {
      const out = join(dir, "inspect.jpg");
      const panel = join(dir, "panel.html");
      const r = await runner.run("inspect", { out, html: panel });
      expect(r.status).toBe("settled");
      expect(r.code).toBe(0);
      const image = await readFile(out);
      expect(image[0]).toBe(0xff);
      expect(image[1]).toBe(0xd8);
      expect(String(r.data?.image)).toBe(out);
      const nodes = r.data?.nodes as { index: number; label: string }[];
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes[0]!.index).toBe(1);
      const html = await readFile(panel, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("data:image/jpeg;base64,");
      expect(r.text).toContain("saved:");
      expect(r.text).toContain("panel:");
    });
  });

  it("defaults inspect's image into the state directory", async () => {
    await withRunner(async (runner, dir) => {
      const r = await runner.run("inspect", {});
      expect(String(r.data?.image)).toContain(join(dir, "shots"));
      expect(r.data?.html).toBeNull();
    });
  });

  it("puts the device_locked instruction above the lock-screen elements", async () => {
    // The elements are context; a bare screen dump with no instruction reads
    // like a page the agent is supposed to work on.
    const screen = {
      header: "screen 1000x2000 · app: com.ohos.sceneboard · rotation 0°",
      lines: ['[1] button "ScreenLockWidgetView RelativeContainer" @600,1300'],
      bundle: "com.ohos.sceneboard",
      locked: true,
      elements: [],
      hash: "0",
    };
    const session = {
      steps: 0,
      async assertLease() {},
      record() {},
      async observe() {
        return { status: "device_locked", screen, step: 1, shot: null };
      },
    } as unknown as Session;
    // The locked path returns before touching the device; the runner still
    // wants one, so hand it the same fake the other tests use.
    const runner = new CommandRunner(session, { stateDir: tmpdir(), device: fakeDevice().device });
    const r = await runner.run("observe", {});
    expect(r.status).toBe("device_locked");
    expect(r.code).toBe(2);
    expect(r.text).toContain("Ask the person to unlock it");
    expect(r.text).toContain("ScreenLockWidgetView");
  });

  it("does not claim inspect saved anything while the phone is locked", async () => {
    const screen = {
      header: "screen 1000x2000 · app: com.ohos.sceneboard · rotation 0°",
      lines: ['[1] button "ScreenLockWidgetView RelativeContainer" @600,1300'],
      bundle: "com.ohos.sceneboard",
      locked: true,
      elements: [],
      hash: "0",
    };
    const session = {
      steps: 0,
      async assertLease() {},
      record() {},
      async inspect() {
        return { status: "device_locked", screen, step: 1, shot: null };
      },
    } as unknown as Session;
    // The locked path returns before touching the device; the runner still
    // wants one, so hand it the same fake the other tests use.
    const runner = new CommandRunner(session, { stateDir: tmpdir(), device: fakeDevice().device });
    const r = await runner.run("inspect", { out: join(tmpdir(), "never.jpg") });
    expect(r.status).toBe("device_locked");
    expect(r.code).toBe(2);
    expect(r.text).toContain("Ask the person to unlock it");
    expect(r.text).not.toContain("saved:");
    expect(r.data?.image).toBeNull();
  });

  it("stops a live session when a person takes the device, and continues after resume", async () => {
    // This is the MCP shape: one session, many commands. A hold must reach it
    // mid-session, or "take over at any time" only holds between one-shot CLI
    // commands — not in the mode agents actually use.
    await withRunner(async (runner, dir) => {
      expect((await runner.run("status", {})).status).toBe("settled");

      const tag = tagOf("SERIAL");
      await holdDevice({ stateDir: dir, tag });
      const stopped = await runner.run("status", {});
      expect(stopped.status).toBe("lease_held");
      expect(stopped.code).toBe(2);
      expect(stopped.text).toContain("A person is using the phone");

      // `resume` hands it back; the same session takes the device again on
      // its next command instead of needing a restart.
      expect(await resumeDevice({ stateDir: dir, tag })).toBe(true);
      expect((await runner.run("status", {})).status).toBe("settled");
    });
  });

  it("hands the device to a person on request, and continues after resume", async () => {
    // `handoff` is the agent-initiated half of the same lease: the agent hits
    // a step only a person can do (sign-in, one-time code, unlock) and gives
    // the phone up instead of guessing or typing a credential.
    await withRunner(async (runner, dir) => {
      const handed = await runner.run("handoff", { reason: "Enter the one-time code" });
      expect(handed.status).toBe("handoff");
      expect(handed.code).toBe(2);
      expect(handed.text).toContain("Enter the one-time code");

      const tag = tagOf("SERIAL");
      const info = await readLease(join(dir, "leases", `${tag}.lock`));
      expect(info?.hold).toBe(true);
      expect(info?.reason).toBe("Enter the one-time code");

      // The same session is the one that asked; its next command must stop.
      const stopped = await runner.run("status", {});
      expect(stopped.status).toBe("lease_held");
      expect(stopped.text).toContain("Enter the one-time code");

      await resumeDevice({ stateDir: dir, tag });
      expect((await runner.run("status", {})).status).toBe("settled");
    });
  });

  it("rejects a handoff without a reason", async () => {
    await withRunner(async (runner) => {
      await expect(runner.run("handoff", {})).rejects.toThrow(/reason/);
    });
  });

  it("runs tap by ref and by text", async () => {
    await withRunner(async (runner) => {
      const observed = await runner.run("observe", {});
      const ref = Number(observed.data?.firstRef);
      expect((await runner.run("tap", { ref })).status).toBe("settled");
    });
  });

  it("runs tap by text", async () => {
    await withRunner(async (runner) => {
      expect((await runner.run("tap", { text: "WLAN" })).status).toBe("settled");
    });
  });

  it("runs tap by selector string", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("tap", { selector: "type=Button&text=WLAN" });
      expect(r.status).toBe("settled");
    });
  });

  it("rejects a tap with no target", async () => {
    await withRunner(async (runner) => {
      await expect(runner.run("tap", {})).rejects.toThrow(/ref|text|selector/);
    });
  });

  it("runs type", async () => {
    await withRunner(async (runner) => {
      expect((await runner.run("type", { text: "hello" })).status).toBe("settled");
    });
  });

  it("passes --paste to the device", async () => {
    await withRunner(async (runner, _dir, fake) => {
      expect((await runner.run("type", { text: "hello", paste: true })).status).toBe("settled");
      expect(textModes(fake)).toEqual([{ paste: true }]);
    });
  });

  it("sends no mode when --paste is absent", async () => {
    await withRunner(async (runner, _dir, fake) => {
      expect((await runner.run("type", { text: "hello" })).status).toBe("settled");
      expect(textModes(fake)).toEqual([undefined]);
    });
  });

  it("runs double-click, drag and fling", async () => {
    await withRunner(async (runner) => {
      const observed = await runner.run("observe", {});
      const ref = Number(observed.data?.firstRef);
      expect((await runner.run("double-click", { ref })).status).toBe("settled");
      expect((await runner.run("drag", { from: "600,1500", to: "600,400" })).status).toBe("settled");
      expect((await runner.run("fling", { direction: "up" })).status).toBe("settled");
    });
  });

  it("rejects a drag without both points", async () => {
    await withRunner(async (runner) => {
      // The required-argument check names the missing one, which is more
      // useful than a generic "needs two points".
      await expect(runner.run("drag", { from: "1,2" })).rejects.toThrow(/drag needs to/);
      await expect(runner.run("drag", { from: "1,2", to: "bad" })).rejects.toThrow(/x,y/);
    });
  });

  it("runs key with a name", async () => {
    await withRunner(async (runner) => {
      expect((await runner.run("key", { key: "back" })).status).toBe("settled");
    });
  });

  it("runs wait-for", async () => {
    await withRunner(async (runner) => {
      expect((await runner.run("wait-for", { text: "WLAN" })).status).toBe("settled");
    });
  });

  it("runs read-list", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("read-list", {});
      expect(r.status).toBe("not_found");
      expect(r.text).toMatch(/no scrollable list/);
    });
  });

  it("runs screenshot and returns the saved path", async () => {
    await withRunner(async (runner, dir) => {
      const out = join(dir, "shot.jpg");
      const r = await runner.run("screenshot", { out });
      expect(r.status).toBe("settled");
      expect(r.data?.path).toBe(out);
      expect(r.text).toMatch(/JPEG/);
    });
  });

  it("runs pinch by ref and by center", async () => {
    await withRunner(async (runner) => {
      const observed = await runner.run("observe", {});
      const ref = Number(observed.data?.firstRef);
      expect((await runner.run("pinch", { ref })).status).toBe("settled");
      expect((await runner.run("pinch", { center: "500,900", scale: "2" })).status).toBe("settled");
    });
  });

  it("rejects a pinch with no center and no ref", async () => {
    await withRunner(async (runner) => {
      await expect(runner.run("pinch", {})).rejects.toThrow(/center|ref/);
    });
  });

  it("records every command in the trace, including ones that skip settle", async () => {
    await withRunner(async (runner, dir) => {
      // `apps`, `launch` and friends answer directly instead of going through
      // the session's settle path, so nothing recorded them. A report that
      // claims "every step" has to include the step that changed the app.
      await runner.run("apps", {});
      await runner.run("doctor", {});
      const r = await runner.run("report", {});
      const html = await readFile(String(r.data?.path), "utf8");
      expect(html).toContain("<code>apps</code>");
      expect(html).toContain("<code>doctor</code>");
      expect(r.data?.steps).toBeGreaterThanOrEqual(2);
      expect(dir).toBeTruthy();
    });
  });

  it("runs window", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("window", {});
      expect(r.status).toBe("settled");
      expect(r.text).toContain("bounds:");
      expect(r.data?.bundle).toBeDefined();
    });
  });

  it("reports a window that is not there", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("window", { bundleName: "com.gone" });
      expect(r.status).toBe("not_found");
      expect(r.code).toBe(1);
    });
  });

  it("reports the foreground app", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("apps", { current: true });
      expect(r.status).toBe("settled");
      expect(r.text).toContain("com.demo");
      expect(r.data?.bundle).toBe("com.demo");
    });
  });

  it("answers whether a bundle is installed", async () => {
    await withRunner(async (runner) => {
      const yes = await runner.run("apps", { has: "com.demo" });
      expect(yes.status).toBe("settled");
      expect(yes.data?.installed).toBe(true);

      const no = await runner.run("apps", { has: "com.absent" });
      expect(no.status).toBe("not_found");
      expect(no.code).toBe(1);
      expect(no.data?.installed).toBe(false);
    });
  });

  it("runs doctor", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("doctor", {});
      expect(r.status).toBe("settled");
      expect(r.text).toContain("capabilities:");
      expect(r.text).toContain("session:");
    });
  });

  it("runs report and writes an html file", async () => {
    await withRunner(async (runner) => {
      await runner.run("observe", {});
      const r = await runner.run("report", { title: "my run" });
      expect(r.status).toBe("settled");
      expect(String(r.data?.path)).toMatch(/\.html$/);
    });
  });

  it("reports the steps earlier commands wrote for this task", async () => {
    await withRunner(async (runner, dir) => {
      // Each CLI invocation is its own process, so a previous command's steps
      // are a different file in the same trace directory.
      const traces = join(dir, "traces");
      await mkdir(traces, { recursive: true });
      const prior = {
        at: "2026-01-01T00:00:00.000Z",
        step: 1,
        command: "tap",
        status: "settled",
        text: 'tapped button "WLAN"',
      };
      await writeFile(join(traces, "2026-01-01T00-00-00-000Z-t.jsonl"), `${JSON.stringify(prior)}\n`);

      const r = await runner.run("report", {});
      expect(r.status).toBe("settled");
      expect(r.data?.steps).toBeGreaterThanOrEqual(1);
      const html = await readFile(String(r.data?.path), "utf8");
      expect(html).toContain('tapped button &quot;WLAN&quot;');
    });
  });

  it("returns the exit code with every result", async () => {
    await withRunner(async (runner) => {
      expect((await runner.run("observe", {})).code).toBe(0);
      expect((await runner.run("read-list", {})).code).toBe(1);
    });
  });

  it("hands back the approval id and the rule that needs a person", async () => {
    await withRunner(async (runner) => {
      const r = await runner.run("tap", { text: "付款" });
      expect(r.status).toBe("approval_pending");
      expect(r.code).toBe(3);
      // The id is the whole point: an agent repeats the step with it.
      expect(r.text).toMatch(/approval_id: [0-9a-f]+/);
      expect(r.text).toContain("payments");
      expect(r.data?.approvalId).toMatch(/^[0-9a-f]+$/);
      expect(r.data?.rule).toBe("payments");
    });
  });

  it("explains a policy block and a stale approval", async () => {
    await withRunner(async (runner, dir) => {
      const blocked = await runner.run("tap", { text: "密码" });
      expect(blocked.status).toBe("blocked");
      expect(blocked.code).toBe(4);
      expect(blocked.text).toMatch(/credentials/);
      expect(blocked.data?.rule).toBe("credentials");

      const denied = await runner.run("tap", { text: "WLAN", approvalId: "deadbeef" });
      expect(denied.status).toBe("approval_denied");
      expect(denied.code).toBe(4);
      expect(denied.text.length).toBeGreaterThan("approval_denied".length);
      expect(dir).toBeTruthy();
    });
  });

  it("rejects an unknown command and lists the real ones", async () => {
    await withRunner(async (runner) => {
      await expect(runner.run("frobnicate", {})).rejects.toThrow(/unknown command "frobnicate"/);
    });
  });
});
