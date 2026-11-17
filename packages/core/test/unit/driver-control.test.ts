import { describe, expect, it, vi } from "vitest";
import { AgentDriver } from "../../src/driver/agent-driver.js";

describe("AgentDriver", () => {
  it("delegates the control calls to the device's agent connection", async () => {
    const agent = {
      hypium: vi.fn(async () => "ok"),
      captureLayout: vi.fn(async () => ({ tag: "root", children: [] })),
      getDisplaySize: vi.fn(async () => ({ width: 1216, height: 2688 })),
      getDisplayRotation: vi.fn(async () => 0),
      captureScreen: vi.fn(async () => Buffer.from([1])),
      click: vi.fn(async () => undefined),
      touchDown: vi.fn(async () => undefined),
      touchMove: vi.fn(async () => undefined),
      touchUp: vi.fn(async () => undefined),
      inputText: vi.fn(async () => undefined),
      triggerKey: vi.fn(async () => undefined),
    };
    const driver = new AgentDriver({ deviceId: "SYNTH0DEVICE0001", agent, hdc: undefined } as never);
    expect(driver.kind).toBe("agent");
    expect(driver.deviceId).toBe("SYNTH0DEVICE0001");
    await driver.click(10, 20);
    expect(agent.click).toHaveBeenCalledWith(10, 20);
    await driver.captureLayout();
    expect(agent.captureLayout).toHaveBeenCalledTimes(1);
    await driver.getDisplaySize();
    expect(agent.getDisplaySize).toHaveBeenCalledTimes(1);
  });
});
