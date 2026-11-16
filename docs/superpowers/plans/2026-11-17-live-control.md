# live 页接管与输入实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `uitest-phone live` 的画布可以显式接管，并以 scrcpy 级跟手完成点击、长按、拖动、滚动、双指缩放、键盘与系统键，输入走独立 agent 通道。

**Architecture:** 读通道（现有 `session.agent`）只做 capture/layout/screenshot/record；写通道是第二条 fport + `AgentClient`，由 `LiveInput` 的指针状态机驱动。`LiveServer` 仲裁单页面接管，广播状态与延迟统计；协议只增不改。浏览器端只负责坐标换算、事件采集、文本缓冲和视觉反馈。

**Tech Stack:** TypeScript ESM（Node ≥20，strict）、vitest、现有零依赖 WebSocket 编解码、浏览器 Pointer Events / WebCodecs。

**Spec:** `docs/superpowers/specs/2026-11-17-live-control-design.md`

## Global Constraints

- 运行时零依赖；测试只用 vitest；`tsc` 严格模式通过。
- **所有 capture（layout/screen/record）留在读通道**；写通道只发 `touchDown/touchMove/touchUp/triggerKey/inputText/PointerMatrix/mouseScroll`。
- 写通道失败**不得**自动切回读通道发输入；一律回只读并广播原因。
- 坐标在客户端、服务器、`LiveInput` 三处 clamp；屏幕外坐标会让设备丢弃连接。
- 协议只增字段；旧页面照常只读。`hello` 的 `clientId` 只发给该连接的首次 hello。
- 真机序列号、`<state-dir>` 里的个人截图不进任何跟踪文件；验收报告只写 8 位 tag。
- 验收期间不点赞、不评论、不发布；截图逐张人工看过再提交。
- 不自动 push、不自动发 npm；版本号改动只改 `package.json`。
- Windows 上 hdc 调用需要 `MSYS_NO_PATHCONV=1`，Node `execFileSync` 用 `D:/...` 路径；验收脚本不直接调 hdc，只有启动知乎时用 `device.hdc.shell`。

## Review Focus

- 两个 tab 在同一 tick 内同时 `take`：只能有一个成功，另一个收到 `busy`。
- 控制 tab 在拖动中关闭：设备上必须留下 `touchUp`，不能卡指针。
- 写通道在队列里有文本/按键时失败：队列清空、状态回 idle、页面回只读，不补发。
- `--no-layout`（`bounds()` 为 null）：输入仍可用，客户端 clamp 是唯一防线。
- 真实浏览器里的输入法组合：拼音未上屏时不发，`compositionend` 后整词粘贴。
- 服务器 `close()` 落在注入进行中：不挂起、不把 lane 泄漏成永远打开的 socket。

---

### Task 1: InputLane 适配器

**Files:**
- Create: `src/live/input-lane.ts`
- Test: `test/unit/live-input-lane.test.ts`

**Interfaces:**
- Consumes: `Gestures`（`src/agent/gestures.ts`）的 `multiTouch(paths, { durationMs, steps })`；`InputTextMode`（`src/model.ts`）。
- Produces:
  ```ts
  export interface InputLane {
    click(x: number, y: number): Promise<void>;
    touchDown(x: number, y: number): Promise<void>;
    touchMove(x: number, y: number): Promise<void>;
    touchUp(x: number, y: number): Promise<void>;
    key(keyCode: number): Promise<void>;
    text(x: number, y: number, text: string, mode: "typing" | "paste"): Promise<void>;
    pinch(cx: number, cy: number, from: number, to: number, durationMs: number): Promise<void>;
    scroll(x: number, y: number, down: boolean, steps: number): Promise<void>;
  }
  export interface InputSession { lane: InputLane; close(): Promise<void>; }
  export interface InputAgent { click(...): Promise<void>; touchDown(...): Promise<void>; touchMove(...): Promise<void>; touchUp(...): Promise<void>; triggerKey(code: number): Promise<void>; inputText(x, y, text, mode?): Promise<void>; hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>; }
  export class AgentInputLane implements InputLane { constructor(agent: InputAgent) }
  ```
  `AgentClient` 结构上满足 `InputAgent`，不需要改 `client.ts`。

- [ ] **Step 1: 写失败的测试**

```ts
// test/unit/live-input-lane.test.ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/unit/live-input-lane.test.ts`
Expected: FAIL — cannot resolve `../../src/live/input-lane.js`.

- [ ] **Step 3: 实现**

`src/live/input-lane.ts`：接口如上；`AgentInputLane` 持有一个 `Gestures` 实例。`pinch` 调 `multiTouch([{from:{x:cx-from,y:cy},to:{x:cx-to,y:cy}},{from:{x:cx+from,y:cy},to:{x:cx+to,y:cy}}], { durationMs, steps: 6 })`；`text` 按 mode 传 `{addition:true}` 或 `{paste:true,addition:true}`；`scroll` 直接调 `hypium("Driver.mouseScroll","Driver#0",[point, down, steps])`；坐标 `Math.round`。`click` 用 `agent.click`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/live-input-lane.test.ts`
Expected: PASS 5/5.

- [ ] **Step 5: 提交**

```bash
git add src/live/input-lane.ts test/unit/live-input-lane.test.ts
git commit -m "feat(live): input lane adapter over the agent protocol"
```

---

### Task 2: 第二条 agent 连接

**Files:**
- Modify: `src/device.ts`（`Device` 类内新增方法，放在 `createCast` 前后）
- Test: `test/unit/device.test.ts`

**Interfaces:**
- Consumes: `AgentInputLane`、`InputSession`（Task 1）；现有 `connectTcp`、`AgentClient`、`hdc.fportAdd/fportRemove`。
- Produces: `Device.openInputLane(): Promise<InputSession>`。每次调用新开一条 fport，`close()` 关 client 并移除该 forward；不启动 daemon，不做健康检查，不自动重连。

- [ ] **Step 1: 写失败的测试**

在 `test/unit/device.test.ts` 的 `describe("Device.connect")` 末尾加：

```ts
it("opens a second input lane and removes its forward on close", async () => {
  const agent = await startFakeAgent();
  hdcState.listening = true;
  hdcState.agentPort = agent.port;
  const dev = await Device.connect({ extensionDir: hdcState.extDir });
  const input = await dev.openInputLane();
  await expect(input.lane.click(10, 20)).resolves.toBeUndefined();
  expect(hdcState.shellCalls.filter((c) => c.includes("start-daemon"))).toHaveLength(0);
  await input.close();
  expect(hdcState.removedPorts).toContain(hdcState.agentPort);
  await dev.dispose();
  await agent.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/device.test.ts`
Expected: FAIL — `dev.openInputLane is not a function`.

- [ ] **Step 3: 实现**

```ts
async openInputLane(): Promise<InputSession> {
  this.assertConnected();
  const port = await this.hdc.fportAdd(this.opts.agentPort ?? 8012, "tcp:8012");
  let sock: net.Socket;
  try {
    sock = await connectTcp(port);
  } catch (e) {
    await this.hdc.fportRemove(port).catch(() => undefined);
    throw e;
  }
  const client = new AgentClient(sock, {
    requestTimeoutMs: this.opts.requestTimeoutMs,
    retryOnBusy: this.opts.retryOnBusy,
  });
  return {
    lane: new AgentInputLane(client),
    async close() {
      client.close();
      await this.hdc.fportRemove(port).catch(() => undefined);
    },
  };
}
```

注意 `file` 顶部的 `import type { InputSession }` 与 `AgentInputLane` 是值导入。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/device.test.ts`
Expected: PASS（新增 1 个，原有全部通过）。

- [ ] **Step 5: 提交**

```bash
git add src/device.ts test/unit/device.test.ts
git commit -m "feat(device): open a second agent lane for input"
```

---

### Task 3: LiveInput 指针核心

**Files:**
- Create: `src/live/input.ts`
- Test: `test/unit/live-input.test.ts`

**Interfaces:**
- Consumes: `InputLane`（Task 1）。
- Produces:
  ```ts
  export type InputState = "idle" | "down";
  export interface LiveStats { p50: number; p95: number; n: number; }
  export interface LiveInputOptions {
    lane: InputLane;
    bounds?: () => { width: number; height: number } | null;
    focusPoint?: () => { x: number; y: number } | null;
    onError?: (error: Error) => void;
    now?: () => number;
    /** How long a held pointer may go without movement before it is lifted. Default 10_000. */
    holdMs?: number;
  }
  export class LiveInput {
    constructor(opts: LiveInputOptions);
    down(x: number, y: number): void;
    move(x: number, y: number): void;
    up(x: number, y: number): void;
    /** Clears the queue, lifts a held pointer and resolves when the lift settled. */
    cancel(): Promise<void>;
    tick(now?: number): void;
    state(): InputState;
    stats(): LiveStats | null;
  }
  ```
- 队列语义：down/up/key/text/pinch/scroll 严格有序；move 只保留最新一个且不越过 up；`cancel()` 清空队列并直接抬指针；任一 lane 拒绝 → `onError` 一次、尽力 `touchUp`、回到 idle、清空队列。

- [ ] **Step 1: 写失败的测试**

```ts
// test/unit/live-input.test.ts
import { describe, it, expect } from "vitest";
import { LiveInput } from "../../src/live/input.js";
import type { InputLane } from "../../src/live/input-lane.js";

class FakeLane implements InputLane {
  calls: Array<[string, ...unknown[]]> = [];
  hold = false;
  failMove = false;
  private waiters: Array<() => void> = [];
  protected async run(name: string, ...args: unknown[]) {
    this.calls.push([name, ...args]);
    if (name === "touchMove" && this.failMove) throw new Error("lane gone");
    if (this.hold) await new Promise<void>((r) => this.waiters.push(r));
  }
  release() { this.hold = false; for (const w of this.waiters.splice(0)) w(); }
  click(...a: [number, number]) { return this.run("click", ...a); }
  touchDown(x: number, y: number) { return this.run("touchDown", x, y); }
  touchMove(x: number, y: number) { return this.run("touchMove", x, y); }
  touchUp(x: number, y: number) { return this.run("touchUp", x, y); }
  key(code: number) { return this.run("key", code); }
  text(x: number, y: number, text: string, mode: string) { return this.run("text", x, y, text, mode); }
  pinch(cx: number, cy: number, from: number, to: number, ms: number) { return this.run("pinch", cx, cy, from, to, ms); }
  scroll(x: number, y: number, down: boolean, steps: number) { return this.run("scroll", x, y, down, steps); }
  ops(name: string) { return this.calls.filter((c) => c[0] === name).map((c) => c.slice(1)); }
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const bounds = () => ({ width: 400, height: 800 });

describe("LiveInput pointer", () => {
  it("sends a tap as touchDown then touchUp", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    input.up(10, 20);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[10, 20]]);
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("coalesces moves while one is in flight, keeping the latest", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 20);
    input.move(12, 20);
    input.move(13, 21);
    lane.release();
    await settle();
    expect(lane.ops("touchMove")).toEqual([[13, 21]]);
  });

  it("does not let a move cross an ordered up", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 20);
    input.up(11, 20);
    lane.release();
    await settle();
    const names = lane.calls.map((c) => c[0]);
    expect(names).toEqual(["touchDown", "touchMove", "touchUp"]);
  });

  it("clamps points to the display", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(-10, 900);
    input.up(5000, -5);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[0, 799]]);
    expect(lane.ops("touchUp")).toEqual([[399, 0]]);
  });

  it("trusts the client when the display size is unknown", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane }); // --no-layout: no bounds
    input.down(-5, 900);
    input.up(5000, -5);
    await settle();
    expect(lane.ops("touchDown")).toEqual([[-5, 900]]);
    expect(lane.ops("touchUp")).toEqual([[5000, -5]]);
  });

  it("lifts a pointer held ten seconds without movement", async () => {
    let now = 1000;
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds, now: () => now });
    input.down(10, 20);
    await settle();
    now += 10_001;
    input.tick();
    await settle();
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
    expect(input.state()).toBe("idle");
  });

  it("cancel clears the queue and lifts the pointer", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    await settle();
    input.move(11, 20);
    const done = input.cancel();
    lane.release();
    await done;
    await settle();
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
    expect(lane.ops("touchMove")).toEqual([]);
    expect(input.state()).toBe("idle");
  });

  it("cancel gives up on a lane that never answers", async () => {
    class DeadLane extends FakeLane {
      override touchUp(x: number, y: number): Promise<void> {
        this.calls.push(["touchUp", x, y]);
        return new Promise<void>(() => {});
      }
    }
    const lane = new DeadLane();
    const input = new LiveInput({ lane, bounds });
    input.down(1, 2);
    await settle();
    const started = Date.now();
    await input.cancel();
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("reports a lane failure, lifts best-effort and goes idle", async () => {
    const lane = new FakeLane();
    const errors: Error[] = [];
    const input = new LiveInput({ lane, bounds, onError: (e) => errors.push(e) });
    input.down(10, 20);
    await settle();
    lane.failMove = true;
    input.move(12, 22);
    await settle();
    expect(errors).toHaveLength(1);
    expect(input.state()).toBe("idle");
    // The lift uses the last point the device actually accepted.
    expect(lane.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("records injection timings for the stats broadcast", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 20);
    input.up(10, 20);
    await settle();
    const stats = input.stats();
    expect(stats?.n).toBe(2);
    expect(stats?.p50).toBeGreaterThanOrEqual(0);
    expect(stats?.p95).toBeGreaterThanOrEqual(stats!.p50);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/live-input.test.ts`
Expected: FAIL — cannot resolve `../../src/live/input.js`.

- [ ] **Step 3: 实现**

单条异步泵：`queue: Op[]` + `running: boolean`；`push(op)` 后 `void pump()`。move 入队时若队尾是 move 就替换它；否则 push。`pump` 顺序执行，记录 `performance.now()` 差值进 `timings`（上限 200）。维护 `lastPoint`（最近一次 down/move 的输入点）和 `sentPoint`（最近一次成功完成的 down/move 点）；`cancel()`、watchdog 和失败兜底都用 `sentPoint` 抬指针。`cancel()` 是 async：清空队列、置 idle，然后 `await Promise.race([lane.touchUp(sentPoint.x, sentPoint.y).catch(() => undefined), new Promise((r) => setTimeout(r, 500))])`；没按着时立即 resolve。500 ms 上限保证关闭流程不会被一条死连接拖住。错误处理：`onError`、不等待地尽力 `void lane.touchUp(sentPoint.x, sentPoint.y).catch(()=>{})`、`queue=[]`、`state="idle"`。clamp 用 `bounds()`；null 时不 clamp。`lastPointerAt = now()` 在 down/move 时更新。`tick(now = now())` 只在 `state==="down"` 且 `now - lastPointerAt > (holdMs ?? 10_000)` 时 `up(sentPoint.x, sentPoint.y)`（入队，不清队列）。`stats()` 返回 p50/p95（最近 200 次成功的 lane 调用；少于 1 次返回 null）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/live-input.test.ts`
Expected: PASS 10/10.

- [ ] **Step 5: 提交**

```bash
git add src/live/input.ts test/unit/live-input.test.ts
git commit -m "feat(live): pointer state machine with move coalescing and watchdog"
```

---

### Task 4: LiveInput 缩放、滚轮与文本

**Files:**
- Modify: `src/live/input.ts`
- Test: `test/unit/live-input.test.ts`

**Interfaces:**
- Produces（追加到 Task 3 的类上）:
  ```ts
  pinch(cx: number, cy: number, half: number): void;
  wheel(x: number, y: number, dy: number): void;
  key(name: "back" | "home" | "enter" | "delete"): void;
  type(text: string, point?: { x: number; y: number }): void;
  ```
- 键码：back=2，home=1，enter=2054，delete=2055。
- 文本规则：trim；换行→空格；空串不发；全 ASCII 且 ≤12 → typing；否则 paste。目标点：显式 `point` → `focusPoint()` → 最后按下的点 → 显示中心 → `{x:0,y:0}`。
- 缩放：首次只记基线；之后每段 `from=上次 half`、`to=新 half`，时长 140 ms；`|to-from| < 2` 不发；`down()` 清基线；拖动中 pinch 先抬指针。
- 滚轮：在途时累计 `dy`，完成后合并；`steps = clamp(round(|dy|/100),1,5)`；`down = dy > 0`。

- [ ] **Step 1: 写失败的测试**

在 `test/unit/live-input.test.ts` 追加：

```ts
describe("LiveInput pinch, wheel and text", () => {
  it("records a pinch baseline, then sends one segment per update", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.pinch(200, 400, 100);
    await settle();
    expect(lane.ops("pinch")).toEqual([]);
    input.pinch(200, 400, 140);
    input.pinch(200, 400, 180);
    await settle();
    expect(lane.ops("pinch")).toEqual([
      [200, 400, 100, 140, 140],
      [200, 400, 140, 180, 140],
    ]);
  });

  it("lifts a drag before starting a pinch", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(10, 10);
    await settle();
    input.pinch(200, 400, 100);
    await settle();
    expect(lane.calls.map((c) => c[0])).toEqual(["touchDown", "touchUp"]);
    expect(input.state()).toBe("idle");
  });

  it("coalesces wheel deltas while one scroll is in flight", async () => {
    const lane = new FakeLane();
    lane.hold = true;
    const input = new LiveInput({ lane, bounds });
    input.wheel(100, 200, 100);
    await settle();
    input.wheel(100, 200, 200);
    input.wheel(100, 200, 100);
    lane.release();
    await settle();
    expect(lane.ops("scroll")).toEqual([
      [100, 200, true, 1],
      [100, 200, true, 3],
    ]);
  });

  it("chooses typing or paste from length and charset", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds, focusPoint: () => ({ x: 50, y: 60 }) });
    input.type("abc");
    await settle();
    input.type("你好");
    input.type("   ");
    input.type("a\nb");
    await settle();
    expect(lane.ops("text")).toEqual([
      [50, 60, "abc", "typing"],
      [50, 60, "你好", "paste"],
      [50, 60, "a b", "typing"],
    ]);
  });

  it("prefers an explicit point, then the last press", async () => {
    const lane = new FakeLane();
    const input = new LiveInput({ lane, bounds });
    input.down(11, 22);
    input.up(11, 22);
    input.type("abc");
    input.type("xyz", { x: 7, y: 8 });
    await settle();
    expect(lane.ops("text")).toEqual([
      [11, 22, "abc", "typing"],
      [7, 8, "xyz", "typing"],
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/live-input.test.ts`
Expected: FAIL — `input.pinch is not a function`.

- [ ] **Step 3: 实现**

`pinch`：clamp half 到 `[20, min(w,h)/2]`；`state==="down"` 时先 push up 并置 idle；基线 null 时只记 `pinchBase=half, lastPoint={cx,cy}` 返回；否则 push `{kind:"pinch", ...}` 并更新基线。`wheel`：`pendingWheel += dy`；若没有在途/排队的 wheel，push scroll（用累计值并清零），完成后若又有累计再 push。`type(text, point?)`：按规则选 mode；点优先用显式 `point`，其次 `focusPoint()`、`lastPoint`、显示中心。`key`：码表。`stats` 保持 Task 3 的实现。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/live-input.test.ts`
Expected: PASS 15/15.

- [ ] **Step 5: 提交**

```bash
git add src/live/input.ts test/unit/live-input.test.ts
git commit -m "feat(live): pinch segments, wheel coalescing and text mode selection"
```

---

### Task 5: LiveServer 接管仲裁与输入路由

**Files:**
- Modify: `src/live/server.ts`
- Test: `test/unit/live-server.test.ts`

**Interfaces:**
- Consumes: `LiveInput`、`InputSession`。
- Produces:
  - `LiveSource.openInput?(): Promise<InputSession>`。
  - `LiveServerOptions.watchdogMs?: number`（默认 10_000）。
  - `hello` 字段：每个连接首次 hello 带 `clientId`；所有 hello 带 `control: { state: "readonly" | "controlled", by?: string }`。
  - 消息：`control`（take/release）与 `input`（down/move/up/pinch/wheel/text/key），见规范 §5。
  - 状态广播：`{type:"control", state, clientId?, reason?, by?, message?, stats?}`。

- [ ] **Step 1: 写失败的测试**

在 `test/unit/live-server.test.ts` 顶部加一个假 lane，并扩展 `start()`，然后新增 describe：

```ts
import type { InputLane } from "../../src/live/input-lane.js";
import type { InputSession } from "../../src/live/input-lane.js";

class FakeInputLane implements InputLane {
  calls: Array<[string, ...unknown[]]> = [];
  fail = false;
  closed = false;
  private go<T>(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push([name, ...args]);
    if (this.fail) return Promise.reject(new Error("lane failed"));
    return Promise.resolve();
  }
  click(...a: [number, number]) { return this.go("click", ...a); }
  touchDown(x: number, y: number) { return this.go("touchDown", x, y); }
  touchMove(x: number, y: number) { return this.go("touchMove", x, y); }
  touchUp(x: number, y: number) { return this.go("touchUp", x, y); }
  key(code: number) { return this.go("key", code); }
  text(x: number, y: number, text: string, mode: string) { return this.go("text", x, y, text, mode); }
  pinch(cx: number, cy: number, from: number, to: number, ms: number) { return this.go("pinch", cx, cy, from, to, ms); }
  scroll(x: number, y: number, down: boolean, steps: number) { return this.go("scroll", x, y, down, steps); }
  async close() { this.closed = true; }
  ops(name: string) { return this.calls.filter((c) => c[0] === name).map((c) => c.slice(1)); }
}
```

`start()` 的 `over` 增加 `watchdogMs?: number` 与 `inputOpenError?: string`；`source` 增加 `openInput`，每次调用创建一个新 lane 并 push 到 `lanes`，返回 `{ lane, close: async () => { lane.closed = true; } }`（`inputOpenError` 非空时直接 throw）；Harness 增加 `lanes(): FakeInputLane[]`、`openInputs(): number`。

```ts
describe("LiveServer: takeover", () => {
  it("lets one tab take control and tells every tab", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    await until(() => a.texts.some((t) => t.type === "hello"));
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    await until(() => b.texts.some((t) => t.type === "control" && t.state === "controlled"));
    const hello = a.texts.find((t) => t.type === "hello")!;
    const ctrl = a.texts.find((t) => t.type === "control" && t.state === "controlled")!;
    expect(ctrl.clientId).toBe(hello.clientId);
    expect(hello.clientId).toBeTypeOf("string");
    // The greeting was sent at attach, before this tab took control.
    expect(hello.control).toEqual({ state: "readonly" });
  });

  it("refuses a second takeover while one tab controls", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    b.send({ type: "control", action: "take" });
    await until(() => b.texts.some((t) => t.type === "control" && t.reason === "busy"));
    expect(b.texts.some((t) => t.type === "control" && t.state === "controlled")).toBe(false);
  });

  it("arbitrates two take requests sent in the same tick", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    b.send({ type: "control", action: "take" });
    const all = () => [...a.texts, ...b.texts];
    await until(() => all().some((t) => t.type === "control" && t.reason === "busy"));
    await until(() => all().some((t) => t.type === "control" && t.state === "controlled"));
    const controlled = all().filter((t) => t.type === "control" && t.state === "controlled");
    expect(new Set(controlled.map((t) => t.clientId)).size).toBe(1);
    expect(all().filter((t) => t.type === "control" && t.reason === "busy")).toHaveLength(1);
  });

  it("refuses takeover when the input lane cannot open", async () => {
    const h = await start({ inputOpenError: "no free port" });
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.reason === "error"));
    expect(a.texts.some((t) => t.type === "control" && t.state === "controlled")).toBe(false);
  });

  it("routes pointer, key, text and matrix input from the controller", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    a.send({ type: "input", action: "move", x: 11, y: 21 });
    a.send({ type: "input", action: "up", x: 11, y: 21 });
    a.send({ type: "input", action: "key", key: "back" });
    a.send({ type: "input", action: "text", text: "abc", x: 5, y: 6 });
    a.send({ type: "input", action: "pinch", cx: 100, cy: 200, half: 60 });
    a.send({ type: "input", action: "wheel", x: 10, y: 20, dy: 100 });
    const lane = h.lanes()[0]!;
    await until(() => lane.ops("scroll").length === 1);
    expect(lane.ops("touchDown")).toEqual([[10, 20]]);
    expect(lane.ops("touchMove")).toEqual([[11, 21]]);
    expect(lane.ops("touchUp")).toEqual([[11, 21]]);
    expect(lane.ops("key")).toEqual([[2]]);
    expect(lane.ops("text")).toEqual([[5, 6, "abc", "typing"]]);
    expect(lane.ops("pinch")).toEqual([]); // first pinch is the baseline
    expect(lane.ops("scroll")).toEqual([[10, 20, true, 1]]);
  });

  it("ignores input from a tab that does not control", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    b.send({ type: "input", action: "down", x: 1, y: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.lanes()[0]!.ops("touchDown")).toEqual([]);
  });

  it("releases control and lifts the pointer when the controller disconnects", async () => {
    const h = await start();
    const a = await connect(h.port);
    const b = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]!.ops("touchDown").length === 1);
    a.close();
    await until(() => b.texts.some((t) => t.type === "control" && t.state === "readonly"));
    expect(h.lanes()[0]!.ops("touchUp")).toEqual([[10, 20]]);
  });

  it("returns to read-only when the input lane fails", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    h.lanes()[0]!.fail = true;
    a.send({ type: "input", action: "down", x: 1, y: 1 });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "readonly" && t.reason === "error"));
  });

  it("re-opens the input lane on the next takeover", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    h.lanes()[0]!.fail = true;
    a.send({ type: "input", action: "down", x: 1, y: 1 });
    await until(() => a.texts.some((t) => t.type === "control" && t.reason === "error"));
    // The failed lane is retried after a short backoff.
    await new Promise((r) => setTimeout(r, 520));
    a.send({ type: "control", action: "take" });
    await until(() => h.openInputs() === 2);
    await until(() => a.texts.filter((t) => t.type === "control" && t.state === "controlled").length >= 2);
  });

  it("lifts a held pointer after the watchdog timeout", async () => {
    const h = await start({ watchdogMs: 40 });
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]!.ops("touchUp").length === 1);
  });

  it("cancels and closes the input lane when the server closes", async () => {
    const h = await start();
    const a = await connect(h.port);
    a.send({ type: "control", action: "take" });
    await until(() => a.texts.some((t) => t.type === "control" && t.state === "controlled"));
    a.send({ type: "input", action: "down", x: 10, y: 20 });
    await until(() => h.lanes()[0]!.ops("touchDown").length === 1);
    await h.server.close();
    expect(h.lanes()[0]!.ops("touchUp").length).toBeGreaterThan(0);
    expect(h.lanes()[0]!.closed).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/live-server.test.ts`
Expected: FAIL — take 没有响应 / `openInput` 未被调用。

- [ ] **Step 3: 实现**

`server.ts`：
1. `Client` 增加 `id: string`；`attach` 分配 `c${n++}`。
2. `hello(clientId?)` 增加 `clientId`（仅传入时）与 `control: this.controlState()`；`sendHello(client)` 传 `client.id`。
3. `start()` 保存 `watchdogMs`，并在后台 `void this.ensureInput().catch(() => undefined)` 预开写通道。
4. `ensureInput()`：已有 session 返回；`now < inputRetryAt` 抛错；并发共享 `inputOpening`；失败设 `inputRetryAt = now + 5000`。
5. `onClientMessage` 先处理 `control`/`input`：
   - take：`void this.takeControl(client)`。`taking` 已为真说明另一个 take 正在开通道 → 立即回 `busy`；已有 controller → 回 `busy`（`by: controller.id`）；否则置 `taking=true` 并 `await ensureInput()`，成功则 `controller=client`，`input = new LiveInput({lane, bounds: () => this.screen?.display ?? null, focusPoint: () => focusedCenter(this.screen), holdMs: this.watchdogMs, onError: ...})`，启动 watchdog 与 stats 定时器，广播 controlled（带 `clientId: client.id`）；失败 → 回 error；最后 `taking=false`。
   - release：只有 controller 能释放 → `releaseControl("released")`。
   - input：非 controller 直接 return；`input` 按 action 分发；文本 `String(message.text).slice(0, 2000)`，x/y 都是有限数时作为显式 point 传给 `input.type(text, point)`；其余数字用 `Number.isFinite` 校验，否则丢弃该消息。
6. `async releaseControl(reason?)`：先摘掉 `controller`/`input` 并清两个定时器；广播 `{state:"readonly", reason}`；再 `await held?.cancel()`（页面立即回只读，抬指针在后台落完）。
7. `dropClient`：若 `controller === client` → `void this.releaseControl("disconnected")`（在删除 client 之前调用，保证广播能到其他人）。
8. lane 失败回调：`void this.releaseControl("error")`；`void session.close()`；`inputSession=null`；`inputRetryAt = now + 500`。
9. `close()`：`await this.releaseControl("closed")`，再 `await this.inputSession?.close()`，然后走现有录制/cast/server 关闭。
10. 定时器 `.unref?.()`，和现有 graceTimer 一致。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/live-server.test.ts`
Expected: PASS（新增 11 个，原有全部通过）。

- [ ] **Step 5: 提交**

```bash
git add src/live/server.ts test/unit/live-server.test.ts
git commit -m "feat(live): takeover arbitration and input routing on a second lane"
```

---

### Task 6: 页面接管交互

**Files:**
- Modify: `src/live/player.ts`
- Test: `test/unit/live-cli.test.ts`

**Interfaces:**
- Consumes: 协议 `control`/`input`（Task 5）。
- Produces（页面元素 id）：`takeover`、`control-state`、`input-ms`、`keys`、`send-text`、`key-back`、`key-home`、`key-enter`、`key-delete`、`touch`。
- 行为：只读时节点框可点；接管时 `#boxes` 失活、画布 `pointer-events` 接收事件；Esc 退出；Ctrl+滚轮缩放；滚轮滚动；两指缩放；文本 300 ms 空闲 flush。

- [ ] **Step 1: 写失败的测试**

在 `test/unit/live-cli.test.ts` 的 `describe("PLAYER_HTML")` 追加：

```ts
it("has the takeover controls and input bar", () => {
  for (const id of ["takeover", "control-state", "input-ms", "keys", "send-text",
    "key-back", "key-home", "key-enter", "key-delete", "touch"]) {
    expect(PLAYER_HTML).toContain(`id="${id}"`);
  }
});

it("handles the control and input messages the server sends", () => {
  expect(PLAYER_HTML).toContain('msg.type === \'control\'');
  expect(PLAYER_HTML).toContain("action: 'take'");
  expect(PLAYER_HTML).toContain("action: 'release'");
  expect(PLAYER_HTML).toContain("action: 'pinch'");
});

it("only sends input while this tab controls", () => {
  expect(PLAYER_HTML).toContain("function sendInput");
  expect(PLAYER_HTML).toContain("controlledId");
  expect(PLAYER_HTML).toContain("clientId");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/live-cli.test.ts`
Expected: FAIL — `id="takeover"` 不存在。

- [ ] **Step 3: 实现**

`player.ts`：
- header 加 `#takeover` 按钮、`#control-state` 徽标、`#input-ms`；stage 内加 `#touch` 涟漪层；stage 下加 `#keys` 输入条（含 `#send-text` 与四个系统键按钮）。
- CSS：琥珀变量（沿用 `--warn`）；在 `#stage` 上加 `.controlled` 类；`.controlled #frame` 描边、`.controlled .box { pointer-events:none }`（规则必须落在子元素上，父级的 none 会被 `.box{pointer-events:auto}` 覆盖）、`.controlled canvas { cursor:crosshair }`；`#keys` 默认 `display:none`，`.controlled #keys` 时 `display:flex`。
- JS：
  - 保存 `clientId`（来自 hello）与 `controlled`（服务器广播的 clientId）。
  - `takeover.onclick` → 发送 take 或 release；`Esc` → release。
  - 画布：`pointerdown/move/up/cancel/lostpointercapture`，`setPointerCapture`，坐标按 `canvas.width/rect.width` 换算并取整；move 用 16 ms 门限；两指进入 pinch（先发 up，再每 120 ms 发 `half`）。
  - Ctrl+wheel → pinch（`half *= exp(-deltaY*0.002)`，clamp 20..短边/2）；普通 wheel → `{action:"wheel",dy}`，累计不节流（服务器合并）。
  - 文本：`input` 事件 300 ms debounce；`compositionstart` 清除 timer 并置组合标志；`compositionend` 重新计时；Enter → flush + `key:"enter"`；`#send-text` → flush；四个按钮 → key。每次 flush 的 `text` 消息带上最后一次画布按下的点（`x/y`，没有就不带），服务器再按焦点输入框优先处理。
  - 收到 `control`：更新徽标/按钮/输入条；`stats` 更新 `#input-ms`（`输入 ${p50} ms`）；`reason` 显示 toast。
  - 接管时记录最后一帧时间；30 s 没有新帧就 toast「画面已断开，可退出接管」，不自动退出（输入通道可能仍然健康）。
  - release/tab 关闭：`sendBeacon` 不可用（WS），直接 `ws.close()`；服务器会处理。
- 不引入任何外部资源；所有按钮带 `title`/`aria-label`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/live-cli.test.ts`
Expected: PASS（新增 3 个，原有全部通过）。

- [ ] **Step 5: 手动冒烟**

Run: `npx tsx src/index.ts live --no-open`（真机），浏览器打开地址；确认只读时框可点、接管后画布可点、Esc 退出。此步只用眼睛确认，不截图提交。

- [ ] **Step 6: 提交**

```bash
git add src/live/player.ts test/unit/live-cli.test.ts
git commit -m "feat(live): takeover button, pointer input and keyboard bar"
```

---

### Task 7: 验收脚本骨架与前五个场景

**Files:**
- Create: `scripts/acceptance-live.ts`
- Modify: `src/live/cli.ts`（`source` 增加 `openInput`）
- Generated: `docs/acceptance/live/report.md`、`docs/acceptance/live/screenshots/`

**Interfaces:**
- Consumes: `startLive`、`LiveServer` 的 WS 协议、`src/cast/ws.js` 的 `buildHandshake/decodeFrames/encodeTextFrame`。
- Produces: `npx tsx scripts/acceptance-live.ts --target <id>`；退出码 0 全过，1 有失败；报告包含每个场景的 PASS/FAIL、耗时与证据路径。

- [ ] **Step 1: 写脚本骨架（此时会失败）**

脚本结构：
- 预检：先用 `Device.connect({ deviceId })` 打开一次设备，`assertCapturable(dev.hypium)`（从 `scripts/acceptance.ts` 导入），`dev.hdc.shell("aa start -b com.zhihu.hmos -a EntryAbility")`，然后 `dev.dispose()`；再 `startLive({ deviceId }, { ...liveOptions({}), httpPort: 0 })`。
- WS 客户端类：`connect(url)` 完成握手；`send(obj)`；`texts` 收集；`until(pred, ms)`；`hello()`；`nodes()`（最近一条）；`shot(name)`（发 `{type:"shot"}`，等 `saved`，把文件复制到 `docs/acceptance/live/screenshots/<name>.jpg`）。
- `tap(x,y)`、`longPress(x,y)`、`swipe(x1,y1,x2,y2)`、`typeText(s)`、`key(k)`、`pinch(cx,cy,halves[])` 全部只发 WS 消息。
- 场景 1-5：
  1. 只读保护：未 take 发 down → 等 300 ms → 用 `JSON.stringify(nodes)` 与之前快照比对，必须相同。
  2. 接管：`take` → controlled；第二个客户端 take → `reason:"busy"`。
  3. 点击：用 `nodes` 找一个 `clickable` 且 label 非空的节点中心 → tap → 等新的 `nodes` → 断言 label 集合或 bundle 变化；从 control 消息的 `stats` 记录 p50/p95，并断言 p50 ≤ 20 ms、p95 ≤ 50 ms。
  4. 长按：长按同一节点 → 等新 `nodes` → 断言节点数变化（弹层）；`key("back")` 关闭。
  5. 滚动：`down/move/up` 画一条竖线 → 等新 `nodes` → 断言可见 label 集合变化。
- 报告：先写标题、环境（8 位 `tag`，不写序列号）、表格行；每个场景失败也继续跑完并写 FAIL。

Run: `npx tsx scripts/acceptance-live.ts --target <id>`
Expected: 失败（`startLive` 的 source 还没有 `openInput`，take 返回 error）。

- [ ] **Step 2: 在 `startLive` 里接上写通道**

`src/live/cli.ts` 的 `source` 增加：

```ts
openInput: () => device.openInputLane(),
```

`live` 总是允许接管；只读用户不会触发它，服务器只是在启动时预开连接，让首次 take 不用等 fport。

- [ ] **Step 3: 运行脚本确认前五个场景**

Run: `npx tsx scripts/acceptance-live.ts --target <id>`
Expected:
```
PASS readonly guard
PASS takeover (cold < 1500 ms)
PASS tap (p50 ≤ 20 ms, p95 ≤ 50 ms)
PASS long press
PASS scroll
```
若知乎不在前台或屏幕锁着，脚本应先 `assertCapturable`（复用现有 acceptance 的规则：锁屏就 `hypium.unlock`，解不开则中止）并 `hdc shell aa start -b com.zhihu.hmos -a EntryAbility`。

- [ ] **Step 4: 提交**

```bash
git add scripts/acceptance-live.ts src/live/cli.ts
git commit -m "feat(acceptance): live takeover runner with core scenarios"
```

---

### Task 8: 键盘、系统键、双指、稳定性与演示截图

**Files:**
- Modify: `scripts/acceptance-live.ts`
- Generated: `docs/acceptance/live/report.md`

**Interfaces:**
- Consumes: 场景 1-5 的 WS 客户端与报告器；`HdcRunner`（只用来 `aa start`）。
- Produces: 场景 6-9 + `docs/acceptance/live/demo/1-feed.jpg` … `4-image.jpg`（全屏原图，供官网用 CSS 裁掉状态栏；人工审核后再拷贝）。

- [ ] **Step 1: 加场景 6-9（先写断言，运行看失败）**

6. 键盘：tap 搜索框 → `text("鸿蒙")` + `key("enter")` → 等 `nodes`，断言 label 集合包含「鸿蒙」或 bundle 不变但节点数变化；截图 `keyboard.jpg`，同时存 `demo/3-search.jpg`。
7. 系统键：`key("back")` → 节点变化；`key("home")` → 等 `nodes`，断言 bundle 变为桌面（label 含「设置」等系统应用）；用 `new HdcRunner({ deviceId }).shell("aa start -b com.zhihu.hmos -a EntryAbility")` 重新打开。
8. 双指：打开一条带图的内容 → 点图进入查看器 → 连发 3 段 `pinch`（half 80 → 120 → 160）→ 截图前后各一张，人工/像素比对图片区域变化；存 `demo/4-image.jpg`；再 `key("back")`。
9. 稳定性：先空转 60 s 记基线帧率（只数二进制帧）；take 后跑 10 分钟、每 500 ms 一次混合输入（滚动 70%、搜索框文本 15%、返回 15%；**不点任意卡片**，避免误触点赞/评论），全程数帧；断言控制期间帧率 ≥ 基线的 90%。中途关闭控制 tab → 断言收到 readonly、随后新 tab take 成功（ack ≤ 300 ms）、继续滚动有效；记录 `stats` 的 p50/p95。

Run: `npx tsx scripts/acceptance-live.ts --target <id>`
Expected: 场景 6-9 FAIL（未实现）。

- [ ] **Step 2: 实现场景**

按键与文本都复用 Task 7 的 `send`；双指用 `pinch(cx, cy, [80,120,160])`（首段只记基线，后两段真正注入）；稳定性循环按 500 ms 节拍跑 10 分钟，每 10 次检查一次 `readonly` 广播；WS 客户端在收到二进制帧时计数，基线窗口与控制窗口按实际时长换算 fps。

演示截图：在场景 3（推荐流）、4（文章）、6（搜索）、8（图片查看器）各存一张到 `docs/acceptance/live/demo/`，文件名 `1-feed.jpg`、`2-article.jpg`、`3-search.jpg`、`4-image.jpg`。

- [ ] **Step 3: 运行确认 9/9**

Run: `npx tsx scripts/acceptance-live.ts --target <id>`
Expected: `pass 9, fail 0`，报告写入 `docs/acceptance/live/report.md`。

- [ ] **Step 4: 人工检查截图**

逐张看 `docs/acceptance/live/screenshots/` 与 `demo/`：无锁屏、无通知、无账号/聊天内容，只保留公开内容页；不合格就删掉重跑。报告里的「浏览器人工检查」两项在真实页面里各做一次并打勾。

- [ ] **Step 5: 提交**

```bash
git add scripts/acceptance-live.ts docs/acceptance/live
git commit -m "feat(acceptance): keyboard, keys, pinch and stability for live takeover"
```

---

### Task 9: 官网接管动画

**Files:**
- Modify: `site/index.html`、`site/styles.css`、`site/main.js`
- Add: `site/assets/control/1-feed.jpg` … `4-image.jpg`（从 `docs/acceptance/live/demo/` 人工审核后拷贝）

**Interfaces:**
- Consumes: 4 张真机截图。
- Produces: `#control` 区块；无 JS 时显示第一帧与说明；`prefers-reduced-motion` 时不动。

- [ ] **Step 1: 加区块与样式（先写会失败的检查）**

在 `#showcase` 前插入：

```html
<section id="control" class="section control reveal">
  <h2>在浏览器里接管手机</h2>
  <p class="section-lede">点「接管」之后，画布就是设备：点击、长按、拖动、滚动、双指缩放、键盘输入都走一条独立的输入通道。下面的画面来自真机上的知乎。</p>
  <div class="control-demo" data-control-demo>
    <div class="control-phone">
      <img class="control-frame is-on" src="assets/control/1-feed.jpg" alt="知乎推荐流">
      <img class="control-frame" src="assets/control/2-article.jpg" alt="知乎文章页">
      <img class="control-frame" src="assets/control/3-search.jpg" alt="知乎搜索结果">
      <img class="control-frame" src="assets/control/4-image.jpg" alt="知乎图片查看器">
      <span class="control-cursor" aria-hidden="true"></span>
      <span class="control-ripple" aria-hidden="true"></span>
      <span class="control-badge">接管中</span>
    </div>
    <ol class="control-steps">
      <li>点开一条内容</li><li>下滑浏览</li><li>输入「鸿蒙」</li><li>双指放大图片</li>
    </ol>
  </div>
</section>
```

CSS：`.control-phone { overflow:hidden; aspect-ratio: 1216 / 2569; }`；`.control-frame { position:absolute; left:0; width:100%; top:-4.4%; }`（裁掉状态栏与底部手势条）；`opacity` 切换；光标用 12 px 圆点和一小段尾迹；涟漪 300 ms；`.control-badge` 琥珀底。窄屏单列。裁剪比例以第一张图实测为准，调完用眼睛确认状态栏不可见。

- [ ] **Step 2: 写时间线（先运行看不动）**

`site/main.js`：`IntersectionObserver` 进入视口后启动；用 `setTimeout`/`requestAnimationFrame` 依次：
1. 2.2 s：光标从右下移到第一张卡片，涟漪，切到第 2 帧；
2. 2.6 s：向上滚动的光标位移，2.6 s 后切到第 3 帧；
3. 2.2 s：光标点到搜索框，逐字显示「鸿蒙」，2.4 s 后切到第 4 帧；
4. 2.4 s：两指缩放手势（两个小圆点向外），停在放大帧；
5. 循环回第 1 帧。
`matchMedia('(prefers-reduced-motion: reduce)')` 为真时只显示第一帧。

- [ ] **Step 3: 本地验证**

Run: `python -m http.server 7100 -d site`
Expected：`#control` 首屏不抖；动画按顺序切 4 帧后循环；低动态模式静止；无 404。手动看一遍，不需要截图提交。

- [ ] **Step 4: 提交**

```bash
git add site/index.html site/styles.css site/main.js site/assets/control
git commit -m "feat(site): takeover demo animation from real screenshots"
```

---

### Task 10: 文档与版本

**Files:**
- Modify: `README.md`（live 小节）、`docs/13-stage-log.md`、`CHANGELOG.md`、`package.json`（0.9.0）
- Modify: `docs/09-capability-gaps-roadmap.md`（把「live 只读」从缺口里移走）

- [ ] **Step 1: 更新 README 与 roadmap**

README 的 live 段落加入：默认只读；点「接管」后可点击/长按/拖动/滚动/键盘/返回/Home/双指缩放；输入走第二条通道，不阻塞布局读取；失败回只读。roadmap 删掉或改写对应缺口。

- [ ] **Step 2: stage log 与 CHANGELOG**

stage log 记一轮：双通道实测数字、矩阵分段、键盘模式、验收结果（不带序列号）。CHANGELOG 顶部加 0.9.0 条目。

- [ ] **Step 3: 版本号**

`package.json` 改为 `"version": "0.9.0"`；不运行 `npm publish`。

- [ ] **Step 4: 全量验证**

Run: `npm test && npx tsc --noEmit`
Expected: 全绿、无类型错误。

Run: `npx tsx scripts/acceptance.ts --targets <id>`
Expected: 原有 16 项能力仍 PASS（回归）。

- [ ] **Step 5: 提交**

```bash
git add README.md docs CHANGELOG.md package.json
git commit -m "docs: live takeover, acceptance report and 0.9.0"
```

---

## 完成标准

- `npm test` 全绿，`tsc --noEmit` 无错误。
- `scripts/acceptance-live.ts` 9/9；截图人工检查过；报告在 `docs/acceptance/live/report.md`。
- 原有 16 项能力验收通过。
- 官网 `#control` 动画可用，低动态模式静止。
- 没有把真机序列号、个人截图或 token 写进任何跟踪文件。
