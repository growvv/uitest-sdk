import { describe, it, expect } from "vitest";
import { doctor } from "../../src/doctor.js";
import { Session } from "../../src/session.js";
import type { UiNode } from "../../src/model.js";

const page: UiNode = {
  attributes: { type: "Root", bounds: "[0,0][1000,2000]", bundleName: "com.demo" },
  children: [{ attributes: { type: "Text", text: "hi", bounds: "[0,100][500,200]" } }],
};

function device(opts: { hypium?: (api: string) => unknown; targets?: string[] } = {}) {
  return {
    deviceId: "SERIAL",
    agent: {
      async hypium(api: string) {
        if (opts.hypium) return opts.hypium(api);
        return true;
      },
      async captureLayout() {
        return page;
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
    },
    hdc: {
      async shell(command: string) {
        if (command === "bm dump -a") return "com.demo";
        return "";
      },
      async listTargets() {
        return opts.targets ?? ["SERIAL"];
      },
    },
    async dispose() {},
  };
}

describe("doctor", () => {
  it("reports the target count, display and capabilities", async () => {
    const report = await doctor(device());
    expect(report.targets).toEqual(["SERIAL"]);
    expect(report.display).toEqual({ width: 1000, height: 2000 });
    expect(report.capabilities.waitForIdle).toBe(true);
    expect(report.capabilities.findComponent).toBe(true);
    expect(report.capabilities.findWindow).toBe(true);
    expect(report.capabilities.multiTouch).toBe(true);
    expect(report.capabilities.waitForComponent).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("renders a text report", async () => {
    const { renderDoctor } = await import("../../src/doctor.js");
    const text = renderDoctor(await doctor(device()));
    expect(text).toContain("capabilities:");
    expect(text).toContain("waitForIdle=yes");
    expect(text).toContain("session: none");
  });

  it("reports a missing capability instead of failing the whole check", async () => {
    const report = await doctor(
      device({
        hypium: (api) => {
          if (api === "Driver.waitForIdle") throw new Error("No handler found");
          return true;
        },
      }),
    );
    expect(report.capabilities.waitForIdle).toBe(false);
    expect(report.problems.join("\n")).toMatch(/waitForIdle/);
  });

  it("warns when several devices are attached", async () => {
    const report = await doctor(device({ targets: ["A", "B"] }));
    expect(report.problems.join("\n")).toMatch(/multiple targets/);
  });

  it("describes a session, including policy and lease", async () => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await fs.mkdtemp(join(tmpdir(), "doctor-"));
    const session = await Session.open(device(), {
      task: "check",
      stateDir: dir,
      lease: { dir },
      policy: { readOnly: true, apps: ["com.demo"] },
      noTrace: true,
    });
    const report = await doctor(device(), session);
    expect(report.session).toMatchObject({
      task: "check",
      readOnly: true,
      apps: ["com.demo"],
    });
    await session.release();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
