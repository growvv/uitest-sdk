import { describe, it, expect } from "vitest";
import { AgentInputLane, type InputAgent } from "../../src/live/input-lane.js";
import type { InputTextMode } from "../../src/model.js";

class FakeAgent implements InputAgent {
  calls: Array<{ api: string; args: unknown[] }> = [];
  async click(x: number, y: number) { this.calls.push({ api: "click", args: [x, y] }); }
  async touchDown(x: number, y: number) { this.calls.push({ api: "touchDown", args: [x, y] }); }
  async touchMove(x: number, y: number) { this.calls.push({ api: "touchMove", args: [x, y] }); }
  async touchUp(x: number, y: number) { this.calls.push({ api: "touchUp", args: [x, y] }); }
  async triggerKey(code: number) { this.calls.push({ api: "triggerKey", args: [code] }); }
  async inputText(x: number, y: number, text: string, mode?: InputTextMode) {
    this.calls.push({ api: "inputText", args: [x, y, text, mode] });
  }
  async hypium(api: string, _thisRef: string, args: unknown[]) {
    this.calls.push({ api, args });
    return api === "PointerMatrix.create" ? "matrix-1" : undefined;
  }
}

describe("AgentInputLane", () => {
  it("passes pointer events through with rounded coordinates", async () => {
    const agent = new FakeAgent();
    const lane = new AgentInputLane(agent);
    await lane.touchDown(10.4, 20.6);
    await lane.touchMove(11.6, 21.4);
    await lane.touchUp(12.5, 22.5);
    expect(agent.calls.map((c) => [c.api, ...c.args])).toEqual([
      ["touchDown", 10, 21],
      ["touchMove", 12, 21],
      ["touchUp", 13, 23],
    ]);
  });

  it("adds for typing and sets paste for paste", async () => {
    const agent = new FakeAgent();
    const lane = new AgentInputLane(agent);
    await lane.text(10, 20, "abc", "typing");
    await lane.text(10, 20, "你好", "paste");
    expect(agent.calls[0]).toEqual({
      api: "inputText",
      args: [10, 20, "abc", { addition: true }],
    });
    expect(agent.calls[1]).toEqual({
      api: "inputText",
      args: [10, 20, "你好", { paste: true, addition: true }],
    });
  });

  it("maps system keys", async () => {
    const agent = new FakeAgent();
    await new AgentInputLane(agent).key(2);
    expect(agent.calls).toEqual([{ api: "triggerKey", args: [2] }]);
  });

  it("builds one two-finger matrix segment with six points per finger", async () => {
    const agent = new FakeAgent();
    await new AgentInputLane(agent).pinch(200, 300, 50, 80, 140);
    const create = agent.calls.find((c) => c.api === "PointerMatrix.create");
    expect(create?.args).toEqual([2, 6]);
    const points = agent.calls.filter((c) => c.api === "PointerMatrix.setPoint");
    expect(points).toHaveLength(12);
    // Finger 0: 150 -> 120; finger 1: 250 -> 280, at y = 300.
    expect(points[0]?.args).toEqual([0, 0, { x: 150, y: 300 }]);
    expect(points[5]?.args).toEqual([0, 5, { x: 120, y: 300 }]);
    expect(points[11]?.args).toEqual([1, 5, { x: 280, y: 300 }]);
    const inject = agent.calls.find((c) => c.api === "Driver.injectMultiPointerAction");
    expect(inject?.args).toEqual(["matrix-1", 140]);
  });

  it("scrolls with the boolean direction the device takes", async () => {
    const agent = new FakeAgent();
    await new AgentInputLane(agent).scroll(10, 20, true, 3);
    expect(agent.calls).toEqual([
      { api: "Driver.mouseScroll", args: [{ x: 10, y: 20 }, true, 3] },
    ]);
  });
});
