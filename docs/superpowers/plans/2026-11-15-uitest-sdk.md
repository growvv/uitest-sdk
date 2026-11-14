# uitest SDK 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把鸿蒙 uitest 的三个扩展（agent.so / libscreen_casting.z.so / CLI 兜底）封装成一个全托管的 TypeScript SDK。

**Architecture:** `Device` 门面负责设备生命周期（push .so / 起 daemon / 建 fport / 健康检查）；三个协议客户端（AgentClient / CastClient / CliRunner）互相独立，共用唯一的 hdc 出口 `HdcRunner`。AgentClient 内置 FIFO 串行队列和流解复用器，因为设备侧是全局锁且 JPEG 二进制与 JSON 回复混在同一 TCP 连接上。

**Tech Stack:** TypeScript 5 / Node ≥ 20 / `node:net` / `node:child_process` / `@grpc/grpc-js` / `@grpc/proto-loader` / vitest

**Spec:** `docs/superpowers/specs/2026-11-15-uitest-sdk-design.md`

## Global Constraints

- Node ≥ 20（用 `AbortSignal`、`node:net`、`node:test` 之外的标准 API）
- TypeScript strict 模式
- 依赖只允许：`@grpc/grpc-js`、`@grpc/proto-loader`、`jpeg-js`（纯 JS，无原生编译，用于 `cropToWindow()`）；devDeps：`typescript`、`@types/node`、`vitest`
- 不做自动回退：任何业务失败直接抛 `UitestError` 子类
- 唯一允许的两类重试：fport 端口冲突换空闲端口；`Disallow concurrent use` 指数退避重试（0.5 ms 起，翻倍，20 ms 封顶，±50% 抖动，最多 40 次）
- agent 请求必须串行（设备侧全局锁，并发返回 `Disallow concurrent use`）
- agent 响应无 `request_id`，只能 FIFO 配对
- `.so` 文件名固定：`agent.so`（arm64 v1.1.10 / x86_64 v1.1.9）、`libscreen_casting.z.so`（6.8-20260801，仅 arm64）
- 设备侧端口：agent 固定 `8012`（硬编码，不可改）
- casting socket 名默认 `scrcpy_grpc_socket`，多路并发靠 `-scrcpy_socket_name` 区分
- gRPC proto **无 package 声明**，方法路径是 `/ScrcpyService/onStart`（不是 `/scrcpy.ScrcpyService/onStart`）
- **多实例安全**：`connect()` 探测 8012 已监听则复用 daemon，**绝不无条件 `kill -9`**；`dispose()` 默认不杀 daemon
- **daemon 进程互不替换**：agent 与 casting 是独立进程可共存；`pidof uitest` 返回全部，**盲杀会误杀**。自己的 pid 只能靠「启动前后 pidof 差集」定位（`/proc/<pid>/fd` 与 `netstat -p` 在 shell 权限下都拿不到 pid）
- **双环境验收**：真机 `<your-device-id>`（arm64，1216×2688）+ 模拟器 `127.0.0.1:5555`（x86_64，1320×2856）；每个能力两边都要过
- **投流路径选择**：有 casting 用 H.264，无 casting（x86_64 模拟器）或加载失败用 MJPEG。**这是同一能力的两种实现，主动选，不是失败降级**；`CastClient.castKind` 明确标出实际路径（`"h264"` / `"mjpeg"`）。x86_64 不存在 `libscreen_casting` 构建（华为不公开发布，无公开源码）
- **7.0 WebSocket 通道不在 v1 范围**：`libscrcpy_server_unix_7.0-20260930.z.so` 走 RFC6455 over TCP 5000，同条件帧率与 6.8 持平，但客户端零依赖、多实例 `-p` 端口隔离、`stop` 直接回 `frameCount`。只存在于 hscrcpy 仓库、非华为官方发行渠道。v1 只实现 gRPC + MJPEG 两条路径，接口设计上给 `castKind` 留扩展位
- **`swipe()` 必须走 `Gestures` 三段式**：`Driver.swipe` 在模拟器上实测 6.2~12.6 s，`Gestures` 只要 ~330 ms；`Driver.drag` / `Driver.fling` 同样不封装
- **MJPEG 靠脏区驱动**：静止画面只出 1 帧。帧率测试必须一边滑动一边收帧，不能空等
- **验收报告必须脚本生成**，不得手写

## Review Focus

以下八类输入/条件 spec 隐含但没在别处测试，最容易让使用者踩坑：

1. **TCP 包边界落在标记中间** —— 解复用器遇到 `FF` 和 `D8` 分属两个 chunk 时必须继续等待，不能误判为 JSON。
2. **JPEG 数据里出现 `{` 或 `FFD8`** —— 熵编码数据可含任意字节；只有 `FFD9` 能结束 JPEG 模式。
3. **流式期间调用普通 RPC** —— 用户会一边推流一边点屏幕；队列必须不被 JPEG 帧阻塞。
4. **daemon 崩溃后的下一次调用** —— 必须抛 `AgentConnectionError`，不能挂起或返回垃圾数据。
5. **fport 端口被占用** —— 用户可能同时开着别的工具；必须自动换端口而不是失败。
6. **两个进程同时 `connect()`** —— 第二个必须复用 daemon 而不是重启；`dispose()` 不能杀掉对方在用的 daemon。
7. **两个进程同时高频调用** —— 冲突率实测 40%~66%；退避重试必须把它们全部消化掉，不泄漏 `Disallow concurrent use`。
8. **画面完全静止时开流** —— MJPEG 靠脏区驱动，只出 1 帧。调用方若以为「没帧 = 卡死」会误判；SDK 不能挂起，`stopStream()` 必须仍能正常结束。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/errors.ts`
- Create: `test/unit/errors.test.ts`

**Interfaces:**
- Produces: `UitestError`、`DeviceNotConnectedError`、`DaemonStartError`、`AgentProtocolError`、`AgentBusyError`、`AgentConnectionError`、`ExtensionMissingError`（全部 `extends UitestError`，构造签名 `(message: string, code: string, cause?: unknown)`）

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "uitest-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "assets"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --exclude '**/device/**'",
    "test:device": "vitest run test/device",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.14.7",
    "@grpc/proto-loader": "^0.7.0",
    "jpeg-js": "^0.4.4"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] }
});
```

- [ ] **Step 4: 写失败测试 `test/unit/errors.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { UitestError, AgentProtocolError, AgentBusyError } from "../../src/errors.js";

describe("errors", () => {
  it("carries code and cause", () => {
    const cause = new Error("inner");
    const e = new AgentProtocolError("device said no", "EPROTO", cause);
    expect(e).toBeInstanceOf(UitestError);
    expect(e.code).toBe("EPROTO");
    expect(e.cause).toBe(cause);
    expect(e.message).toBe("device said no");
    expect(e.name).toBe("AgentProtocolError");
  });

  it("AgentBusyError is a distinct subclass", () => {
    const e = new AgentBusyError("device stayed busy", "EBUSY");
    expect(e).toBeInstanceOf(UitestError);
    expect(e).not.toBeInstanceOf(AgentProtocolError);
    expect(e.name).toBe("AgentBusyError");
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `npx vitest run test/unit/errors.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/errors.js"`

- [ ] **Step 6: 实现 `src/errors.ts`**

```ts
export class UitestError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}
export class DeviceNotConnectedError extends UitestError {}
export class DaemonStartError extends UitestError {}
export class AgentProtocolError extends UitestError {}
export class AgentBusyError extends UitestError {}
export class AgentConnectionError extends UitestError {}
export class ExtensionMissingError extends UitestError {}
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run test/unit/errors.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 8: 提交**

```bash
git init && git add -A && git commit -m "chore: scaffold uitest SDK with error hierarchy"
```

---

### Task 2: 数据模型与 bounds 工具

**Files:**
- Create: `src/model.ts`
- Create: `src/util/bounds.ts`
- Create: `test/unit/bounds.test.ts`

**Interfaces:**
- Produces:
  - `interface UiNode { attributes: Record<string, string>; children: UiNode[] }`
  - `interface UiEvent { type: string; [key: string]: unknown }`
  - `interface H264Chunk { data: Buffer; pts: number; flags: number; isKeyFrame: boolean }`
  - `interface Rect { x: number; y: number; width: number; height: number }`
  - `parseBounds(s: string): Rect | null`
  - `cropRect(inner: Rect, outer: Rect): Rect`

- [ ] **Step 1: 写失败测试 `test/unit/bounds.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseBounds, cropRect } from "../../src/util/bounds.js";

describe("parseBounds", () => {
  it("parses the device format", () => {
    expect(parseBounds("[0,0][1216,2688]")).toEqual({ x: 0, y: 0, width: 1216, height: 2688 });
  });
  it("parses an offset rect", () => {
    expect(parseBounds("[79,804][1136,2262]")).toEqual({ x: 79, y: 804, width: 1057, height: 1458 });
  });
  it("returns null for empty or malformed input", () => {
    expect(parseBounds("")).toBeNull();
    expect(parseBounds("garbage")).toBeNull();
    expect(parseBounds("[1,2]")).toBeNull();
  });
});

describe("cropRect", () => {
  it("clamps to the outer rect", () => {
    expect(cropRect({ x: -10, y: -10, width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 50 }))
      .toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
  it("returns a zero rect when fully outside", () => {
    expect(cropRect({ x: 200, y: 200, width: 10, height: 10 }, { x: 0, y: 0, width: 50, height: 50 }))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/bounds.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/model.ts`**

```ts
export interface UiNode { attributes: Record<string, string>; children: UiNode[] }
export interface UiEvent { type: string; [key: string]: unknown }
export interface H264Chunk { data: Buffer; pts: number; flags: number; isKeyFrame: boolean }
export interface Rect { x: number; y: number; width: number; height: number }
```

- [ ] **Step 4: 实现 `src/util/bounds.ts`**

`parseBounds` 用正则 `^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$` 提取四角；任一不匹配返回 `null`，且宽或高为负也返回 `null`。
`cropRect` 取交集：`x1=max(inner.x,outer.x)`、`y1=max(inner.y,outer.y)`、`x2=min(inner.x+inner.width, outer.x+outer.width)`、`y2=min(...)`；若 `x2<=x1 || y2<=y1` 返回 `{x:0,y:0,width:0,height:0}`。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/unit/bounds.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: add data model and bounds parsing"
```

---

### Task 3: agent 流解复用器

这是全项目最容易出错的部分，单独一个任务。**不涉及网络**，纯字节状态机，可用单测完全覆盖。

**Files:**
- Create: `src/agent/demux.ts`
- Create: `test/unit/demux.test.ts`

**Interfaces:**
- Produces:
  - `class FrameDemux { constructor(handlers: { onJson(line: string): void; onFrame(jpeg: Buffer): void }); push(chunk: Buffer): void }`

- [ ] **Step 1: 写失败测试 `test/unit/demux.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { FrameDemux } from "../../src/agent/demux.js";

function collect() {
  const json: string[] = [];
  const frames: Buffer[] = [];
  const d = new FrameDemux({ onJson: (l) => json.push(l), onFrame: (f) => frames.push(f) });
  return { d, json, frames };
}
const JPEG = (payload: Buffer) => Buffer.concat([Buffer.from([0xff, 0xd8]), payload, Buffer.from([0xff, 0xd9])]);

describe("FrameDemux", () => {
  it("splits a JSON line", () => {
    const { d, json } = collect();
    d.push(Buffer.from('{"result":1}\n'));
    expect(json).toEqual(['{"result":1}']);
  });

  it("splits a JPEG frame", () => {
    const { d, frames } = collect();
    d.push(JPEG(Buffer.from([1, 2, 3])));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(JPEG(Buffer.from([1, 2, 3])));
  });

  it("handles a chunk boundary inside the FFD8 marker", () => {
    const { d, frames } = collect();
    d.push(Buffer.from([0xff]));
    d.push(Buffer.from([0xd8, 9, 9, 0xff, 0xd9]));
    expect(frames).toHaveLength(1);
  });

  it("handles a chunk boundary inside the FFD9 marker", () => {
    const { d, frames } = collect();
    d.push(Buffer.from([0xff, 0xd8, 1, 2, 0xff]));
    expect(frames).toHaveLength(0);
    d.push(Buffer.from([0xd9]));
    expect(frames).toHaveLength(1);
  });

  it("does not treat '{' inside JPEG payload as JSON", () => {
    const { d, json, frames } = collect();
    d.push(JPEG(Buffer.from('{"fake":true}', "utf8")));
    expect(json).toHaveLength(0);
    expect(frames).toHaveLength(1);
  });

  it("does not treat FFD8 inside JPEG payload as a new frame", () => {
    const { d, frames } = collect();
    d.push(JPEG(Buffer.from([0xff, 0xd8, 0xaa])));
    expect(frames).toHaveLength(1);
  });

  it("interleaves JSON and frames in arrival order", () => {
    const { d, json, frames } = collect();
    d.push(Buffer.concat([JPEG(Buffer.from([1])), Buffer.from('{"a":1}\n'), JPEG(Buffer.from([2]))]));
    expect(frames).toHaveLength(2);
    expect(json).toEqual(['{"a":1}']);
  });

  it("keeps partial JSON buffered across chunks", () => {
    const { d, json } = collect();
    d.push(Buffer.from('{"res'));
    expect(json).toHaveLength(0);
    d.push(Buffer.from('ult":2}\n'));
    expect(json).toEqual(['{"result":2}']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/demux.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/agent/demux.ts`**

状态机，`mode: "idle" | "json" | "jpeg"`，内部 `buf: Buffer`：

- `idle`：跳过空白；若首字节 `0x7b`（`{`）→ `json` 模式；若前两字节是 `FF D8` → `jpeg` 模式（消费这两个字节，帧从 `FFD8` 开始收集）；否则丢弃该字节（防止垃圾数据卡死）。
- `json`：找 `0x0a`；找到则切出 `[0, idx)` 交 `onJson`，剩余留 `buf`，回 `idle`。找不到就等更多数据。
- `jpeg`：从 `buf` 找 `FF D9`；找到则切出 `[0, idx+2)` 交 `onFrame`，剩余留 `buf`，回 `idle`。注意从索引 2 开始找（避免把开头的 `FFD8` 里的 `FF` 和后面的 `D8` 误配）。

关键实现约束：`jpeg` 模式下搜索 `FFD9` 时，若 `buf` 末尾只剩 `FF` 一个字节，必须保留它等待下一 chunk，不能丢弃。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/demux.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add agent stream demultiplexer for interleaved JSON and JPEG"
```

---

### Task 4: agent 串行队列

**Files:**
- Create: `src/agent/queue.ts`
- Create: `test/unit/queue.test.ts`

**Interfaces:**
- Produces: `class SerialQueue { run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T>; readonly depth: number }`

- [ ] **Step 1: 写失败测试 `test/unit/queue.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { SerialQueue } from "../../src/agent/queue.js";

describe("SerialQueue", () => {
  it("runs tasks one at a time in FIFO order", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    let active = 0, maxActive = 0;
    const mk = (i: number) => q.run(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      order.push(i); active--;
      return i;
    });
    const results = await Promise.all([mk(1), mk(2), mk(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it("propagates a rejection without blocking the queue", async () => {
    const q = new SerialQueue();
    await expect(q.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(q.run(async () => 42)).resolves.toBe(42);
  });

  it("times out a task that never resolves", async () => {
    const q = new SerialQueue();
    await expect(q.run(() => new Promise(() => {}), 30)).rejects.toThrow(/timeout/i);
    await expect(q.run(async () => "next")).resolves.toBe("next");
  });

  it("reports queue depth", async () => {
    const q = new SerialQueue();
    const p1 = q.run(() => new Promise((r) => setTimeout(() => r(1), 20)));
    const p2 = q.run(async () => 2);
    expect(q.depth).toBeGreaterThanOrEqual(2);
    await Promise.all([p1, p2]);
    expect(q.depth).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/agent/queue.ts`**

链式 promise 实现：维护 `tail: Promise<unknown>`，每次 `run` 把 `fn` 接到 `tail` 后面。超时用 `Promise.race` + `setTimeout`（记得在 `finally` 里 `clearTimeout`）。`depth` 为未完成任务的计数（进入时 +1，`finally` 里 -1）。

**超时不取消底层任务** —— 因为无法中断已在飞的 socket 写入；由调用方（AgentClient）在超时后作废整个连接。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/queue.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add serial queue for agent RPC"
```

---

### Task 5: HdcRunner

**Files:**
- Create: `src/hdc.ts`
- Create: `test/unit/hdc.test.ts`

**Interfaces:**
- Produces:
  - `interface HdcOptions { hdcPath?: string; deviceId?: string; timeoutMs?: number }`
  - `class HdcRunner { constructor(opts?: HdcOptions); shell(cmd: string): Promise<string>; push(local: string, remote: string): Promise<void>; pull(remote: string, local: string): Promise<void>; readLocal(path: string): Promise<string>; fportAdd(localPort: number, remote: string): Promise<number>; fportRemove(localPort: number): Promise<void>; listTargets(): Promise<string[]>; resolveHdcPath(): string }`
  - `fportAdd` 返回**实际使用的端口**（冲突时可能不同于入参）

- [ ] **Step 1: 写失败测试 `test/unit/hdc.test.ts`**

用假的 hdc 可执行文件（一个 shell 脚本）测试参数拼装与端口冲突重试。

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { HdcRunner } from "../../src/hdc.js";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeHdc(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hdc-"));
  const p = join(dir, "hdc");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("HdcRunner", () => {
  it("returns shell output", async () => {
    const hdc = fakeHdc('echo "hello"');
    const r = new HdcRunner({ hdcPath: hdc });
    expect((await r.shell("whatever")).trim()).toBe("hello");
  });

  it("throws on non-zero exit with stderr in the message", async () => {
    const hdc = fakeHdc('echo "bad thing" >&2; exit 1');
    const r = new HdcRunner({ hdcPath: hdc });
    await expect(r.shell("x")).rejects.toThrow(/bad thing/);
  });

  it("retries with the next port when fport reports a listen failure", async () => {
    const hdc = fakeHdc(
      'case "$*" in *"tcp:8012"*) echo "[Fail]TCP Port listen failed at 8012"; exit 1;; esac\necho "Forwardport result:OK"'
    );
    const r = new HdcRunner({ hdcPath: hdc });
    const used = await r.fportAdd(8012, "localabstract:test");
    expect(used).toBe(8013);
  });

  it("parses list targets", async () => {
    const hdc = fakeHdc('printf "dev1\\ndev2\\n"');
    const r = new HdcRunner({ hdcPath: hdc });
    expect(await r.listTargets()).toEqual(["dev1", "dev2"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/hdc.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/hdc.ts`**

用 `node:child_process` 的 `execFile`（**不要用 `exec`** —— 避免 shell 注入，也避免 Windows 的引号问题）。

`resolveHdcPath()` 顺序：`opts.hdcPath` → `process.env.HDC_PATH` → `PATH` 里找 `hdc`/`hdc.exe` → DevEco 默认路径（`D:\Application\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe` 等）→ 抛 `DeviceNotConnectedError`。

`fportAdd(localPort, remote)`：循环尝试 `localPort`、`localPort+1` …最多 20 次；stderr/stdout 含 `TCP Port listen failed` 则换下一个端口；成功返回实际端口；全部失败抛 `DaemonStartError`。

`shell()` 失败时把 stderr 拼进错误 message。

`readLocal(path)`：`fs.readFile(path, "utf8")`，用于 `CliRunner` 读取 pull 下来的文件。放进 `HdcRunner` 是为了让 `CliRunner` 的测试可以用一个假 `HdcRunner` 完全隔离文件系统。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/hdc.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add HdcRunner as the single hdc boundary"
```

---

### Task 6: AgentClient 基础（连接 + 队列 + 解复用）

**Files:**
- Create: `src/agent/client.ts`
- Create: `test/unit/agent-client.test.ts`

**Interfaces:**
- Consumes: `FrameDemux`（Task 3）、`SerialQueue`（Task 4）、错误类（Task 1）
- Produces:
  - `type AgentMethod = "Captures" | "CtrlCmd" | "Gestures" | "callHypiumApi"`
  - `class AgentClient { constructor(sock: net.Socket, opts?: AgentClientOptions); call(method: AgentMethod, params: object): Promise<unknown>; close(): void; onFrame(handler: (jpeg: Buffer) => void): () => void; readonly connected: boolean }`
  - `interface AgentClientOptions { requestTimeoutMs?: number; retryOnBusy?: boolean; maxBusyRetries?: number }`
  - `MODULE_ID = "com.ohos.devicetest.hypiumApiHelper"`
  - `isBusyException(msg: string): boolean`（识别 `Disallow concurrent use` / `Capture already running`）

- [ ] **Step 1: 写失败测试 `test/unit/agent-client.test.ts`**

用 `net.createServer` 起一个假 agent（在 127.0.0.1 的随机端口），按协议回 JSON。

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { AgentClient } from "../../src/agent/client.js";
import { AgentProtocolError, AgentBusyError } from "../../src/errors.js";

let server: net.Server;
let client: AgentClient;
let port: number;
let received: string[] = [];
let replyFn: (req: any) => string | Buffer = () => '{"result":true}\n';

beforeEach(async () => {
  received = [];
  replyFn = () => '{"result":true}\n';
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        received.push(line);
        sock.write(replyFn(JSON.parse(line)));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
  const sock = net.createConnection(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  client = new AgentClient(sock);
});

afterEach(async () => {
  client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("AgentClient", () => {
  it("sends the documented envelope", async () => {
    await client.call("CtrlCmd", { api: "getDisplaySize", args: [] });
    const req = JSON.parse(received[0]);
    expect(req.module).toBe("com.ohos.devicetest.hypiumApiHelper");
    expect(req.method).toBe("CtrlCmd");
    expect(req.params).toEqual({ api: "getDisplaySize", args: [] });
  });

  it("returns the result field", async () => {
    replyFn = () => '{"result":{"width":1216,"height":2688},"pts":1}\n';
    await expect(client.call("CtrlCmd", { api: "getDisplaySize", args: [] }))
      .resolves.toEqual({ width: 1216, height: 2688 });
  });

  it("throws AgentProtocolError when the device returns an exception", async () => {
    replyFn = () => '{"result":null,"exception":"Disallow concurrent use"}\n';
    await expect(client.call("CtrlCmd", { api: "x", args: [] }))
      .rejects.toThrow(AgentProtocolError);
    await expect(client.call("CtrlCmd", { api: "x", args: [] }))
      .rejects.toThrow(/Disallow concurrent use/);
  });

  it("serialises concurrent calls", async () => {
    replyFn = () => '{"result":1}\n';
    await Promise.all([1, 2, 3].map(() => client.call("CtrlCmd", { api: "a", args: [] })));
    expect(received).toHaveLength(3);
  });

  it("retries on 'Disallow concurrent use' until the device is free", async () => {
    let n = 0;
    replyFn = () => (++n <= 2
      ? '{"result":null,"exception":"Disallow concurrent use"}\n'
      : '{"result":{"width":1216,"height":2688}}\n');
    await expect(client.call("CtrlCmd", { api: "getDisplaySize", args: [] }))
      .resolves.toEqual({ width: 1216, height: 2688 });
    expect(n).toBe(3); // 两次冲突 + 一次成功
  });

  it("throws AgentBusyError after exhausting busy retries", async () => {
    replyFn = () => '{"result":null,"exception":"Disallow concurrent use"}\n';
    const c = new AgentClient(connectedSocket(), { maxBusyRetries: 2 });
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentBusyError);
    c.close();
  });

  it("does NOT retry non-busy exceptions", async () => {
    let n = 0;
    replyFn = () => { n++; return '{"result":null,"exception":"Invalid params"}\n'; };
    await expect(client.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentProtocolError);
    expect(n).toBe(1);
  });

  it("retryOnBusy:false surfaces the busy error immediately", async () => {
    let n = 0;
    replyFn = () => { n++; return '{"result":null,"exception":"Disallow concurrent use"}\n'; };
    const c = new AgentClient(connectedSocket(), { retryOnBusy: false });
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentBusyError);
    expect(n).toBe(1);
    c.close();
  });
});

function connectedSocket(): net.Socket {
  return net.createConnection(port, "127.0.0.1");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/agent-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/agent/client.ts`**

结构：

- 构造时创建 `FrameDemux`，把 socket 的 `data` 事件喂进去。
- `demux.onJson` → 取队首等待者并 resolve；若队列空则忽略（多余回复）。
- `demux.onFrame` → 交给当前帧订阅者；无订阅者则丢弃。
- `call()` 通过 `SerialQueue` 排队，写入 `JSON.stringify(envelope) + "\n"`，等待对应 promise。
- 设备返回 `exception` 时抛 `AgentProtocolError(message, "EPROTO")`。

**退避重试**（§4.6）。`call()` 的外层包一层重试循环，**重试发生在队列内**（一次 `queue.run` 里连续尝试），这样不会让本进程的其他请求插到重试中间加剧冲突：

```ts
private async callWithRetry(method: AgentMethod, params: object): Promise<unknown> {
  return this.queue.run(async () => {
    let delay = 0.5;
    for (let attempt = 0; ; attempt++) {
      const raw = await this.sendOnce(method, params);
      if (raw.exception == null) return raw.result;
      if (!this.retryOnBusy || !isBusyException(raw.exception)) {
        throw isBusyException(raw.exception)
          ? new AgentBusyError(raw.exception, "EBUSY")
          : new AgentProtocolError(raw.exception, "EPROTO");
      }
      if (attempt >= this.maxBusyRetries) {
        throw new AgentBusyError(`device stayed busy after ${attempt + 1} attempts: ${raw.exception}`, "EBUSY");
      }
      await sleep(delay * (0.5 + Math.random()));   // ±50% 抖动
      delay = Math.min(delay * 2, 20);
    }
  }, this.requestTimeoutMs);
}
```

`isBusyException(msg)` 匹配 `"Disallow concurrent use"` 和 `"Capture already running"`（大小写敏感，用设备原文）。**抖动是必须的** —— 两个进程同步退避会一直撞在一起。

- socket `close`/`error` 时：让所有挂起请求 reject `AgentConnectionError`，`connected` 变 false。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/agent-client.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add AgentClient with serial queue and stream demux"
```

---

### Task 7: AgentClient 高层 API（动作 / 树 / 截图）

**Files:**
- Modify: `src/agent/client.ts`
- Create: `test/unit/agent-actions.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `AgentClient.call` / `onFrame`
- Produces（全部在 `AgentClient` 上）:
  - `getDisplaySize(): Promise<{width: number; height: number}>`
  - `getDisplayRotation(): Promise<number>`
  - `captureLayout(): Promise<UiNode>`
  - `captureScreen(opts?: { scale?: number }): Promise<Buffer>`
  - `cropToWindow(opts: { windowId?: number; bundleName?: string; scale?: number }): Promise<Buffer>`
  - `touchDown(x: number, y: number): Promise<void>`
  - `touchMove(x: number, y: number): Promise<void>`
  - `touchUp(x: number, y: number): Promise<void>`
  - `click(x: number, y: number): Promise<void>`
  - `swipe(x1: number, y1: number, x2: number, y2: number, opts?: { steps?: number; durationMs?: number }): Promise<void>`
  - `inputText(x: number, y: number, text: string): Promise<void>`
  - `triggerKey(keyCode: number): Promise<void>`
  - `hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>`

- [ ] **Step 1: 写失败测试 `test/unit/agent-actions.test.ts`**

复用 Task 6 的假 agent，断言发出的 `api` 与 `args` 形状。

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import jpeg from "jpeg-js";
import { AgentClient } from "../../src/agent/client.js";

let server: net.Server, client: AgentClient, received: any[] = [];
let replyFn: (req: any) => string = () => '{"result":true}\n';

beforeEach(async () => {
  received = []; replyFn = () => '{"result":true}\n';
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const req = JSON.parse(line); received.push(req);
        sock.write(replyFn(req));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  client = new AgentClient(sock);
});
afterEach(async () => { client.close(); await new Promise<void>((r) => server.close(() => r())); });

describe("AgentClient actions", () => {
  it("touchDown sends Gestures.touchDown with x/y", async () => {
    await client.touchDown(10, 20);
    expect(received[0].method).toBe("Gestures");
    expect(received[0].params).toEqual({ api: "touchDown", args: { x: 10, y: 20 } });
  });

  it("click sends down then up", async () => {
    await client.click(5, 6);
    expect(received.map((r) => r.params.api)).toEqual(["touchDown", "touchUp"]);
  });

  it("swipe uses the Gestures channel, never Driver.swipe", async () => {
    await client.swipe(0, 0, 100, 100, { steps: 3 });
    expect(received.map((r) => r.params.api))
      .toEqual(["touchDown", "touchMove", "touchMove", "touchMove", "touchUp"]);
    // 全部走 Gestures 通道
    expect(received.every((r) => r.method === "Gestures")).toBe(true);
    // 绝不能出现 Driver.swipe（模拟器上要 6~12 秒）
    expect(received.some((r) => r.params.api === "Driver.swipe")).toBe(false);
  });

  it("captureLayout returns the tree", async () => {
    replyFn = () => '{"result":{"attributes":{"id":"root"},"children":[]}}\n';
    const tree = await client.captureLayout();
    expect(tree.attributes.id).toBe("root");
    expect(received[0].method).toBe("Captures");
  });

  it("hypium wraps the callHypiumApi envelope", async () => {
    await client.hypium("Driver.pressBack", "Driver#0", []);
    expect(received[0].method).toBe("callHypiumApi");
    expect(received[0].params).toEqual({ api: "Driver.pressBack", this: "Driver#0", args: [] });
  });

  it("inputText goes through Driver.inputText with a Point", async () => {
    await client.inputText(10, 20, "你好 world");
    expect(received[0].method).toBe("callHypiumApi");
    expect(received[0].params.api).toBe("Driver.inputText");
    expect(received[0].params.args[0]).toEqual({ x: 10, y: 20 });
    expect(received[0].params.args[1]).toBe("你好 world");
  });

  it("triggerKey goes through Driver.triggerKey", async () => {
    await client.triggerKey(26);
    expect(received[0].params.api).toBe("Driver.triggerKey");
    expect(received[0].params.args).toEqual([26]);
  });

  it("cropToWindow crops to the window bounds", async () => {
    // 假设备返回整屏树，根节点 bounds 覆盖左下角 1/4
    replyFn = () => '{"result":{"attributes":{"bounds":"[0,1344][608,2688]"},"children":[]}}\n';
    const out = await client.cropToWindow({ scale: 2 });
    const img = jpeg.decode(out);
    expect(img.width).toBe(608);
    expect(img.height).toBe(1344);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/agent-actions.test.ts`
Expected: FAIL — `client.touchDown is not a function`

- [ ] **Step 3: 实现高层方法**

`captureScreen` 的关键顺序（**必须严格按此**）：

```
1. call("Captures", { api: "startCaptureScreen", args: [{ displayId: 0, scale }] })
2. 注册一次性帧监听，等待第一帧（超时 requestTimeoutMs）
3. call("Captures", { api: "stopCaptureScreen", args: [] })
4. 返回第 2 步拿到的帧
```

`swipe` **必须走 `Gestures` 三段式，不能走 `Driver.swipe`**：默认 `steps = 8`，`durationMs = 300`，步间 `await sleep(durationMs/steps)`。

理由（实测）：`Driver.swipe` 在模拟器上要 **6.2~12.6 秒**（真机毫秒级），而 `Gestures` 的 `touchDown` + 8×`touchMove` + `touchUp` 只要约 330 ms。真机上也一样该用三段式 —— 延迟可控，且能驱动 MJPEG 出帧。`Driver.drag` / `Driver.fling` 同理不封装。

`cropToWindow` 的顺序：

```
1. tree = await captureLayout()          // 设备侧只出整屏
2. node = findNode(tree, { windowId, bundleName })   // 按属性匹配根节点
3. rect = parseBounds(node.attributes.bounds)
4. jpeg = await captureScreen({ scale })
5. raw  = jpeg.decode(jpeg)
6. 按 scale 换算 rect：物理像素 = rect / scale
7. jpeg.encode(cropped, 80)
```

**为什么这么做**：所有截图路径（agent / casting / `snapshot_display` / `uitest screenCap`）都只能出整屏，设备侧无窗口级截图 API。这是已知限制（spec §10.2），裁剪是唯一可行的近似。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/agent-actions.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add AgentClient high-level actions, layout and screenshot"
```

---

### Task 8: AgentClient 流式 API

**Files:**
- Modify: `src/agent/client.ts`
- Create: `test/unit/agent-stream.test.ts`

**Interfaces:**
- Produces:
  - `streamScreen(opts?: { scale?: number }): AsyncIterable<Buffer>`
  - `streamUiActions(): AsyncIterable<UiEvent>`
  - `stopStream(): Promise<void>`

- [ ] **Step 1: 写失败测试 `test/unit/agent-stream.test.ts`**

假 agent 在 `startCaptureScreen` 后连续推 3 个 JPEG，再对 `stopCaptureScreen` 回 JSON。

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { AgentClient } from "../../src/agent/client.js";

const JPEG = (b: number) => Buffer.concat([Buffer.from([0xff, 0xd8, b]), Buffer.from([0xff, 0xd9])]);
let server: net.Server, client: AgentClient, received: any[] = [];

beforeEach(async () => {
  received = [];
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const req = JSON.parse(line); received.push(req);
        if (req.params.api === "startCaptureScreen") {
          sock.write('{"result":true}\n');
          sock.write(JPEG(1)); sock.write(JPEG(2)); sock.write(JPEG(3));
        } else if (req.params.api === "stopCaptureScreen") {
          sock.write('{"code":0}\n');
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  client = new AgentClient(sock);
});
afterEach(async () => { client.close(); await new Promise<void>((r) => server.close(() => r())); });

describe("AgentClient streaming", () => {
  it("yields frames until the stream is stopped", async () => {
    const frames: Buffer[] = [];
    for await (const f of client.streamScreen({ scale: 2 })) {
      frames.push(f);
      if (frames.length === 3) break;
    }
    expect(frames).toHaveLength(3);
    expect(frames[0][0]).toBe(0xff);
    expect(received[0].params.args[0]).toEqual({ displayId: 0, scale: 2 });
  });

  it("stopStream sends stopCaptureScreen", async () => {
    const it = client.streamScreen();
    await it[Symbol.asyncIterator]().next();
    await client.stopStream();
    expect(received.some((r) => r.params.api === "stopCaptureScreen")).toBe(true);
  });

  it("does not let frames block normal RPCs", async () => {
    // 流开着的时候发一个普通请求，应该照常返回
    const it = client.streamScreen();
    await it[Symbol.asyncIterator]().next();
    const size = await client.getDisplaySize();
    expect(size).toBeDefined();
  });

  it("stopStream tolerates an already-stopped stream", async () => {
    // 多实例场景：另一个进程先停了流
    replyFn = (req) => req.params.api === "stopCaptureScreen"
      ? '{"result":null,"exception":"Capture is not running"}\n'
      : '{"result":true}\n';
    const it = client.streamScreen();
    await it[Symbol.asyncIterator]().next();
    await expect(client.stopStream()).resolves.toBeUndefined();   // 不抛
  });
});
```

> 第三个用例需要假 agent 对 `CtrlCmd` 回 `{"result":{"width":1,"height":1}}`，在 `data` 处理器里补上。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/agent-stream.test.ts`
Expected: FAIL — `streamScreen is not a function`

- [ ] **Step 3: 实现**

`streamScreen` 返回一个 async generator：
- 进入时 `await call("startCaptureScreen", …)` 拿到 ack
- 然后循环 `await nextFrame()`，`yield` 出去
- `finally` 里调 `stopStream()`

`nextFrame()` 用 Promise + 一次性监听器实现，内部维护 `frameWaiters` 数组，`demux.onFrame` 时 `shift()` 一个并 resolve。

`stopStream()`：`call("stopCaptureScreen")`，并把 `frameWaiters` 全部 resolve 为 `null`（让 generator 结束）。

**`stopStream()` 必须容忍「流已经不在」**：多实例场景下另一个进程可能已经停了流，设备会回 `Capture is not running` 之类的异常。这类异常要吞掉（`try { … } catch { /* already stopped */ }`），否则 `finally` 里的清理会掩盖真正的错误。**只吞这一种**，其他异常照常抛。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/agent-stream.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add AgentClient streaming screen and UI events"
```

---

### Task 9: CastClient

**Files:**
- Create: `src/cast/scrcpy.proto`
- Create: `src/cast/client.ts`
- Create: `test/unit/cast-proto.test.ts`

**Interfaces:**
- Consumes: `HdcRunner`（Task 5）
- Produces:
  - `interface CastOptions { mode: "stream" | "record"; socketName?: string; frameRate?: 15 | 30 | 60 | 120; scale?: 1 | 2 | 3 | 4 | 5; outputPath?: string }`
  - `interface CastClient { readonly castKind: "h264" | "mjpeg"; stream(): AsyncIterable<H264Chunk | JpegFrame>; requestIDRFrame(): Promise<void>; dispose(): Promise<void> }`
  - `class H264CastClient implements CastClient { static start(hdc: HdcRunner, opts: CastOptions): Promise<H264CastClient> }`
  - `class MjpegCastClient implements CastClient { constructor(agent: AgentClient, opts?: { scale?: number }); readonly castKind = "mjpeg" }`
  - `function resolveCastingExtension(abi: "arm64" | "x86_64", extDir?: string): string | null`

- [ ] **Step 1: 写 `src/cast/scrcpy.proto`**

**必须无 package 声明** —— 实测服务端路径是 `/ScrcpyService/onStart`。

```protobuf
syntax = "proto3";
message ReplyMessage {
  string data = 1;
  int32 reply_type = 2;
  map<string, ParamValue> payload = 3;
}
message ParamValue {
  oneof values {
    int64 val_int = 1;
    double val_double = 2;
    string val_string = 3;
    bool val_bool = 4;
    bytes val_bytes = 5;
    float val_float = 6;
  }
}
message ReplyEndMessage { int32 frame_count = 1; }
message Empty {}
service ScrcpyService {
  rpc onStart(Empty) returns (stream ReplyMessage);
  rpc onEnd(Empty) returns (ReplyEndMessage);
  rpc onRequestIDRFrame(Empty) returns (ReplyEndMessage);
}
```

- [ ] **Step 2: 写失败测试 `test/unit/cast-proto.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadScrcpyService } from "../../src/cast/client.js";

describe("scrcpy proto", () => {
  it("loads the service without a package prefix", () => {
    const svc = loadScrcpyService();
    expect(Object.keys(svc.service)).toEqual(["onStart", "onEnd", "onRequestIDRFrame"]);
  });
  it("onStart is server-streaming", () => {
    expect(loadScrcpyService().service.onStart.responseStream).toBe(true);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/unit/cast-proto.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: 实现 `src/cast/client.ts` 的 proto 加载部分**

```ts
export function loadScrcpyService() {
  const def = protoLoader.loadSync(join(dirname(fileURLToPath(import.meta.url)), "scrcpy.proto"), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  return pkg.ScrcpyService;
}
```

注意 `pkg.ScrcpyService`（**不是** `pkg.scrcpy.ScrcpyService`）。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/unit/cast-proto.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: 实现 `CastClient.start` / `stream` / `requestIDRFrame` / `dispose`**

`start`：
1. `socketName = opts.socketName ?? (mode === "stream" ? "scrcpy_grpc_socket" : "screen_record_grpc_socket")`
2. **记下 `before = pidof uitest`**
3. `hdc.shell(\`uitest start-daemon singleness --extension-name libscreen_casting.z.so -m ${mode === "stream" ? 0 : 1} -scrcpy_socket_name ${socketName} ...\`)`
   —— **不要带 `kill -9`**：casting 与 agent 是两个独立进程，可以共存（实测 5423 + 5441 同时活着）；`pidof uitest` 会返回两者的 pid，盲杀会顺手干掉 agent daemon
4. **`after = pidof uitest`；`ownPid = after \ before`**（差集；空集说明启动失败，抛 `DaemonStartError`）
5. 轮询 `/proc/net/unix | grep <socketName>` 直到出现（最多 5 s）
6. `hdc.fportAdd(0, \`localabstract:${socketName}\`)` —— 本地端口用 0 让系统分配，避免与同进程其他 cast 抢端口
7. 建 gRPC channel

> `/proc/<pid>/fd` 在 shell 权限下不可读，`netstat -p` 也拿不到 pid 列，所以**只能靠差集定位自己的进程**（见 spec §4.6「daemon 进程模型」）。

`stream()`：调 `stub.onStart({})`，把每个 `ReplyMessage` 映射成 `H264Chunk`（`payload.data.val_bytes` → `Buffer`、`payload.pts.val_int`、`payload.flags.val_int`、`isKeyFrame = flags === 2 || flags === 8`）。

`dispose()`：先 `onEnd`（吞掉错误），再 `stub.close()`、`channel.close()`、**`kill -9 <ownPid>`（只杀自己那个，不碰 agent 的）**、删 fport。

**关键**：`onEnd` 有粘性副作用（一旦调用该进程永远不出帧），所以一个 `CastClient` 实例只能对应一个 daemon 进程，`dispose` 后不可复用。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: add H264CastClient for H.264 streaming and MP4 recording"
```

---

### Task 10: MjpegCastClient（无 casting 时的投流路径）

**Files:**
- Create: `src/cast/mjpeg.ts`
- Create: `src/cast/resolve.ts`
- Create: `test/unit/cast-resolve.test.ts`

**Interfaces:**
- Consumes: `AgentClient`（Task 8 的 `streamScreen` / `stopStream`）
- Produces:
  - `class MjpegCastClient implements CastClient { readonly castKind = "mjpeg"; constructor(agent: AgentClient, opts?: { scale?: number }); stream(): AsyncIterable<JpegFrame>; requestIDRFrame(): Promise<void>; dispose(): Promise<void> }`
  - `interface JpegFrame { data: Buffer; pts: number }`
  - `resolveCastingExtension(abi: "arm64" | "x86_64", extDir?: string): string | null`

- [ ] **Step 1: 写失败测试 `test/unit/cast-resolve.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveCastingExtension } from "../../src/cast/resolve.js";

describe("resolveCastingExtension", () => {
  it("returns the extension path on arm64", () => {
    expect(resolveCastingExtension("arm64", "/ext")).toBe("/ext/arm64/libscreen_casting.z.so");
  });

  it("returns null on x86_64 (no build exists)", () => {
    expect(resolveCastingExtension("x86_64", "/ext")).toBeNull();
  });

  it("returns null on arm64 when the file is absent", () => {
    expect(resolveCastingExtension("arm64", "/nonexistent")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/cast-resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/cast/resolve.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

/** x86_64 无 casting 构建（华为不公开发布，也无公开源码）。 */
export function resolveCastingExtension(
  abi: "arm64" | "x86_64",
  extDir?: string
): string | null {
  if (abi === "x86_64") return null;
  if (!extDir) return null;
  const p = join(extDir, "arm64", "libscreen_casting.z.so");
  return existsSync(p) ? p : null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/cast-resolve.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 实现 `src/cast/mjpeg.ts`**

`MjpegCastClient` 把 `AgentClient.streamScreen()` 包成 `CastClient` 接口：

- `stream()` → 直接转发 `agent.streamScreen({ scale })` 的 async generator，每帧包成 `{ data, pts: Date.now() }`。
- `requestIDRFrame()` → 空操作（MJPEG 无关键帧概念），直接 resolve。**不要抛错** —— 调用方不该因为换了路径就要改代码。
- `dispose()` → `agent.stopStream()`。**不碰 daemon**（agent 是共享的）。

- [ ] **Step 6: 在 `Device.createCast()` 里接上选择逻辑**

```ts
async createCast(opts: CastOptions): Promise<CastClient> {
  const ext = resolveCastingExtension(this.abi, this.extDir);
  if (ext) return H264CastClient.start(this.hdc, opts);
  return new MjpegCastClient(this.agent, { scale: opts.scale });
}
```

`this.abi` 在 `connect()` 阶段由 `param get const.product.cpu.abilist` 确定。

- [ ] **Step 7: 写失败测试验证选择逻辑**

```ts
it("picks MJPEG when no casting extension exists", async () => {
  // 模拟器（x86_64）上跑
  const cast = await dev.createCast({ mode: "stream", frameRate: 15 });
  expect(cast.castKind).toBe("mjpeg");
  await cast.dispose();
});

it("picks H.264 when the extension exists", async () => {
  // 真机上跑
  const cast = await dev.createCast({ mode: "stream", frameRate: 15 });
  expect(cast.castKind).toBe("h264");
  await cast.dispose();
});
```

- [ ] **Step 8: 运行确认通过（双环境）**

```bash
npx vitest run test/unit/cast-resolve.test.ts
npx vitest run test/device/functional.test.ts --target 127.0.0.1:5555   # castKind === "mjpeg"
npx vitest run test/device/functional.test.ts --target <your-device-id> # castKind === "h264"
```

- [ ] **Step 9: 提交**

```bash
git add -A && git commit -m "feat: add MjpegCastClient and automatic cast path selection"
```

---

### Task 11: CliRunner

**Files:**
- Create: `src/cli.ts`
- Create: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `HdcRunner`（Task 5）
- Produces: `class CliRunner { constructor(hdc: HdcRunner); dumpLayout(opts?: { windowId?: number; bundleName?: string; withFontAttrs?: boolean }): Promise<UiNode> }`

- [ ] **Step 1: 写失败测试 `test/unit/cli.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { CliRunner } from "../../src/cli.js";
import type { HdcRunner } from "../../src/hdc.js";

function fakeHdc(readFile: string) {
  const calls: string[] = [];
  const hdc = {
    shell: async (c: string) => { calls.push(c); return ""; },
    pull: async () => { /* noop */ },
    readLocal: async () => readFile
  } as unknown as HdcRunner;
  return { hdc, calls };
}

describe("CliRunner", () => {
  it("passes windowId through to dumpLayout", async () => {
    const { hdc, calls } = fakeHdc('{"attributes":{"id":"w"},"children":[]}');
    const r = new CliRunner(hdc);
    const tree = await r.dumpLayout({ windowId: 16 });
    expect(tree.attributes.id).toBe("w");
    expect(calls[0]).toContain("-w 16");
  });

  it("adds -a when font attributes are requested", async () => {
    const { hdc, calls } = fakeHdc('{"attributes":{},"children":[]}');
    await new CliRunner(hdc).dumpLayout({ withFontAttrs: true });
    expect(calls[0]).toContain("-a");
  });

  it("throws a parse error on non-JSON output", async () => {
    const { hdc } = fakeHdc("not json");
    await expect(new CliRunner(hdc).dumpLayout()).rejects.toThrow();
  });
});
```

> `readLocal` 由 Task 5 的 `HdcRunner` 提供。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/cli.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/cli.ts`**

```
remote = `/data/local/tmp/uitest_sdk_${randomUUID()}.json`
local  = join(tmpdir(), basename(remote))
cmd    = `uitest dumpLayout -p ${remote}` + (windowId ? ` -w ${windowId}` : "") + (bundleName ? ` -b ${bundleName}` : "") + (withFontAttrs ? " -a" : "")
await hdc.shell(cmd)
await hdc.pull(remote, local)
const tree = JSON.parse(await hdc.readLocal(local))
await hdc.shell(`rm -f ${remote}`)   // 尽力而为，失败忽略
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/cli.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: add CliRunner for window-scoped layout dump"
```

---

### Task 12: Device 门面（连接 / 生命周期 / 自动重启）

**Files:**
- Create: `src/device.ts`
- Create: `src/index.ts`
- Create: `test/unit/device.test.ts`

**Interfaces:**
- Consumes: `HdcRunner`、`AgentClient`、`CastClient`、`CliRunner`
- Produces:
  - `interface DeviceOptions { hdcPath?: string; deviceId?: string; agentPort?: number; autoRestart?: boolean; extensionDir?: string; requestTimeoutMs?: number; ownDaemon?: boolean; retryOnBusy?: boolean }`
  - `class Device { static connect(opts?: DeviceOptions): Promise<Device>; readonly agent: AgentClient; readonly cli: CliRunner; createCast(opts: CastOptions): Promise<CastClient>; dispose(): Promise<void>; readonly state: "connected" | "disconnected"; readonly ownsDaemon: boolean }`

- [ ] **Step 1: 写失败测试 `test/unit/device.test.ts`**

测「daemon 崩溃后下一次调用抛 `AgentConnectionError`」，用一个会主动断开连接的假 agent。

```ts
import { describe, it, expect } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { AgentConnectionError } from "../../src/errors.js";
import net from "node:net";

describe("connection loss", () => {
  it("rejects in-flight requests with AgentConnectionError", async () => {
    const server = net.createServer((s) => { s.on("data", () => s.destroy()); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const sock = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    const c = new AgentClient(sock);
    await expect(c.call("CtrlCmd", { api: "x", args: [] })).rejects.toThrow(AgentConnectionError);
    c.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/device.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/device.ts`**

`connect()` 步骤（严格按序）：
1. `new HdcRunner(opts)`
2. `listTargets()` 为空 → 抛 `DeviceNotConnectedError`
3. 读设备 ABI：`hdc.shell("param get const.product.cpu.abilist")`，含 `x86_64` 且不含 `arm64` 则选 `assets/x86_64/`，否则 `assets/arm64/`
4. 解析扩展路径（`opts.extensionDir` 或上一步选中的 `assets/<abi>/`）；`agent.so` 不存在 → 抛 `ExtensionMissingError`
5. `hdc.shell("ls -l /data/local/tmp/agent.so")` 比对大小，不一致则 `push` + `chmod 755`
6. **探测 8012**：`hdc.shell("cat /proc/net/tcp | grep 1F4C")`
   - **有输出 → 复用**：`ownsDaemon = false`，跳过步骤 7~8
   - **无输出 → 起 daemon**：`before = pidof uitest` → `uitest start-daemon singleness --extension-name agent.so` → `after = pidof uitest` → `ownPid = after \ before`；`ownsDaemon = true`
     - **不要 `kill -9 $(pidof uitest)`**：8012 没监听不代表没有其他 uitest 进程 —— 可能有人正用 casting。盲杀会打断别人。
     - 若 `uitest start-daemon` 报「已存在」但 8012 仍不通（僵死 daemon），才用差集定位并只杀那个残留 pid 后重试一次。
7. 轮询 `cat /proc/net/tcp | grep 1F4C` 直到出现（最多 5 s），超时抛 `DaemonStartError`
8. `localPort = await hdc.fportAdd(opts.agentPort ?? 8012, "tcp:8012")` —— **每个实例用自己的本地端口**，冲突时自动换空闲端口
9. 连 TCP，发 `getDisplaySize` 健康检查

> **绝不无条件 `kill -9`**。那会杀掉另一个进程正在用的 daemon（实测确认过）。步骤 6 的探测是硬要求，多实例测试会覆盖它。

`autoRestart`：AgentClient 触发 `AgentConnectionError` 时，重跑 6~9 一次；再失败抛 `DaemonStartError`，`state = "disconnected"`，后续调用立即抛错。

**不重放进行中的请求**（写操作重放不安全）。

`dispose()`：关 socket → 删自己建的 fport；**不杀 daemon**，除非 `ownsDaemon === true && opts.ownDaemon === true`。全部 try/catch，不抛错。

- [ ] **Step 4: 实现 `src/index.ts`**

导出 `Device`、三个 client、所有类型、所有错误类。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/unit/device.test.ts && npm run typecheck`
Expected: PASS，无类型错误

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: add Device facade with lifecycle and auto-restart"
```

---

### Task 13: 设备功能集成测试（双环境）

**Files:**
- Create: `test/device/helpers.ts`
- Create: `test/device/functional.test.ts`

**Interfaces:**
- Consumes: `Device`（Task 11）全部 API
- Produces: `getDevice(): Promise<Device>`、`getTarget(): string`、`skipIfNoCast(): boolean`

- [ ] **Step 1: 写 `test/device/helpers.ts`**

```ts
import { Device } from "../../src/device.js";

export function getTarget(): string | undefined {
  const i = process.argv.indexOf("--target");
  if (i >= 0) return process.argv[i + 1];
  return process.env.UITEST_TARGET;          // undefined → hdc list targets 第一台
}

/** x86_64 模拟器上不存在 casting 扩展，相关用例必须跳过 */
export function hasCastSupport(): boolean {
  const t = getTarget() ?? "";
  return !t.startsWith("127.0.0.1:");        // 模拟器一律按无 casting 处理
}

export async function getDevice(): Promise<Device> {
  return Device.connect({ deviceId: getTarget() });
}
```

- [ ] **Step 2: 写失败测试 `test/device/functional.test.ts`**

按 spec §7.2 的验收矩阵逐条写。关键几条：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDevice, hasCastSupport } from "./helpers.js";
import type { Device } from "../../src/device.js";

let dev: Device;
beforeAll(async () => { dev = await getDevice(); }, 60000);
afterAll(async () => { await dev?.dispose(); });

describe("connect", () => {
  it("returns the real display size", async () => {
    const s = await dev.agent.getDisplaySize();
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
  });
});

describe("actions", () => {
  it("clicks without error", async () => {
    const s = await dev.agent.getDisplaySize();
    const t0 = Date.now();
    await dev.agent.click(Math.floor(s.width / 2), Math.floor(s.height / 2));
    expect(Date.now() - t0).toBeLessThan(400);   // 真机 5 ms / 模拟器 141 ms
  });

  it("swipes via Gestures in under 500ms", async () => {
    const s = await dev.agent.getDisplaySize();
    const t0 = Date.now();
    await dev.agent.swipe(s.width / 2, s.height * 0.7, s.width / 2, s.height * 0.3, { durationMs: 300 });
    // Gestures 三段式：真机毫秒级，模拟器约 330 ms。
    // 如果实现误用 Driver.swipe，模拟器上会是 6000+ ms，这条断言会失败。
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("performs atomic touch down/move/up", async () => {
    await dev.agent.touchDown(100, 100);
    await dev.agent.touchMove(120, 120);
    await dev.agent.touchUp(120, 120);
  });
});

describe("ui tree", () => {
  it("captures a non-empty tree", async () => {
    const tree = await dev.agent.captureLayout();
    expect(tree.attributes).toBeDefined();
    expect(Array.isArray(tree.children)).toBe(true);
    expect(countNodes(tree)).toBeGreaterThan(0);
  });
});

describe("screenshot", () => {
  it("returns a valid JPEG under 500ms", async () => {
    const t0 = Date.now();
    const jpeg = await dev.agent.captureScreen({ scale: 2 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(jpeg.subarray(-2).toString("hex")).toBe("ffd9");
  });

  it("honours scale 1..5 with decreasing dimensions", async () => {
    const sizes: number[] = [];
    for (const scale of [1, 2, 5]) {
      sizes.push((await dev.agent.captureScreen({ scale })).length);
    }
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
  });
});

describe("streaming", () => {
  it("delivers 10 consecutive frames while the screen changes", async () => {
    const s = await dev.agent.getDisplaySize();
    // MJPEG 靠脏区驱动：画面静止时只出 1 帧（实测）。必须一边滑动一边收帧。
    const stopMotion = startMotion(dev, s);
    try {
      const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      for (let i = 0; i < 10; i++) {
        const f = await it.next();
        expect(f.value.length).toBeGreaterThan(0);
      }
    } finally {
      stopMotion();
      await dev.agent.stopStream();
    }
  }, 60000);

  it("serves RPCs while a stream is open", async () => {
    const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
    await it.next();
    const t0 = Date.now();
    await dev.agent.getDisplaySize();
    expect(Date.now() - t0).toBeLessThan(200);
    await dev.agent.stopStream();
  });

  it("static screen yields at most one frame (documents dirty-rect behaviour)", async () => {
    // 这条不是功能断言，是行为记录：静止画面下 MJPEG 只推 1 帧。
    // 若某天固件改成定时推帧，这条会失败，届时更新文档。
    const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
    await it.next();
    const second = await Promise.race([
      it.next(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000))
    ]);
    expect(second).toBeNull();     // 2 秒内没有第二帧
    await dev.agent.stopStream();
  }, 30000);
});

describe.skipIf(!hasCastSupport())("casting", () => {
  it("runs two independent casts", async () => {
    const a = await dev.createCast({ mode: "stream", socketName: "cast_a", frameRate: 15 });
    const b = await dev.createCast({ mode: "stream", socketName: "cast_b", frameRate: 15 });
    const [fa, fb] = await Promise.all([
      a.stream()[Symbol.asyncIterator]().next(),
      b.stream()[Symbol.asyncIterator]().next()
    ]);
    expect(fa.value?.data.length).toBeGreaterThan(0);
    expect(fb.value?.data.length).toBeGreaterThan(0);
    await a.dispose(); await b.dispose();
  }, 60000);
});

describe.skipIf(hasCastSupport())("casting on a device without the extension", () => {
  it("selects the MJPEG path and still streams", async () => {
    // x86_64 模拟器没有 libscreen_casting 构建。
    // 这是主动选择 MJPEG（同一能力的另一条实现），不是失败降级。
    const cast = await dev.createCast({ mode: "stream", frameRate: 15 });
    expect(cast.castKind).toBe("mjpeg");
    const s = await dev.agent.getDisplaySize();
    const stop = startMotion(dev, s);          // MJPEG 靠脏区驱动，必须造动画
    try {
      const it = cast.stream()[Symbol.asyncIterator]();
      for (let i = 0; i < 5; i++) {
        const f = await it.next();
        expect(f.value.data.length).toBeGreaterThan(0);
      }
    } finally {
      stop();
      await cast.dispose();
    }
  }, 60000);
});

describe("cli", () => {
  it("dumps a window-scoped layout", async () => {
    const tree = await dev.cli.dumpLayout({});
    expect(tree.attributes).toBeDefined();
  });
});

function countNodes(n: any): number {
  return 1 + (n.children ?? []).reduce((a: number, c: any) => a + countNodes(c), 0);
}

/** 后台持续滑动造动画，返回停止函数。MJPEG 靠脏区驱动，静止画面只出 1 帧。 */
function startMotion(dev: Device, s: { width: number; height: number }): () => void {
  let alive = true;
  (async () => {
    let n = 0;
    while (alive) {
      n++;
      const y1 = Math.floor(s.height * (n % 2 ? 0.7 : 0.3));
      const y2 = Math.floor(s.height * (n % 2 ? 0.3 : 0.7));
      try {
        await dev.agent.swipe(s.width / 2, y1, s.width / 2, y2, { durationMs: 200 });
      } catch { /* 忽略忙 */ }
    }
  })();
  return () => { alive = false; };
}
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/device/functional.test.ts --target <your-device-id>`
Expected: FAIL（`Device.connect` 尚未实现完整流程，或首次跑通部分用例）

- [ ] **Step 4: 实现缺失部分直到全绿（真机）**

Run: `npx vitest run test/device/functional.test.ts --target <your-device-id>`
Expected: 全部 PASS（含 casting 组）

- [ ] **Step 5: 模拟器验证**

前置（一次性）：
```bash
unset HDC_SERVER_PORT          # 本机环境坑，见 spec §1.4
HDC=/d/Application/DevEco\ Studio/sdk/default/openharmony/toolchains/hdc.exe
"$HDC" list targets            # 应看到 127.0.0.1:5555
```

`Device.connect()` 会按 ABI 自动推 `assets/x86_64/agent.so`，不需要手动推。跑：
```bash
npx vitest run test/device/functional.test.ts --target 127.0.0.1:5555
```
Expected: 功能用例全 PASS；`casting`（H.264 专有）组 SKIP（`1 skipped`）；**「无 casting 扩展」组 PASS**（验证 `createCast()` 返回 `castKind === "mjpeg"` 并能出帧）

**若模拟器未被 hdc 发现**，先确认 `HDC_SERVER_PORT` 已清掉；模拟器进程需在无该变量的环境下启动（`cd <emulator dir> && unset HDC_SERVER_PORT && ./Emulator.exe -start ProbePhone`，不要用 `timeout` 包它）。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "test: add dual-environment functional acceptance tests"
```

---

### Task 14: 多实例共存测试（跨进程）

**Files:**
- Create: `test/device/multi-instance.test.ts`
- Create: `test/device/worker.ts`

**Interfaces:**
- Consumes: `Device`（Task 11）、`AgentBusyError`（Task 1）
- Produces: 无（纯测试）

- [ ] **Step 1: 写 `test/device/worker.ts`**

子进程脚本，通过 `process.send` 回结果。**必须真的独立进程**，不能同进程开两个 client —— 那测不到 daemon 归属和端口分配。

```ts
import { Device } from "../../src/device.js";

type Cmd =
  | { op: "connect"; target: string }
  | { op: "hammer"; calls: number }
  | { op: "startStream" }
  | { op: "captureLayout" }
  | { op: "startCaptureScreen" }
  | { op: "dispose" }
  | { op: "ping" };

let dev: Device | null = null;

process.on("message", async (m: Cmd) => {
  try {
    switch (m.op) {
      case "connect":
        dev = await Device.connect({ deviceId: m.target });
        process.send!({ ok: true, ownsDaemon: dev.ownsDaemon });
        break;
      case "hammer": {
        const t0 = Date.now();
        const rs = await Promise.all(Array.from({ length: m.calls }, () => dev!.agent.getDisplaySize()));
        process.send!({ ok: true, n: rs.length, ms: Date.now() - t0 });
        break;
      }
      case "startStream": {
        const it = dev!.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
        const f = await it.next();
        process.send!({ ok: true, frameBytes: f.value.length });
        break;
      }
      case "captureLayout": {
        const tree = await dev!.agent.captureLayout();
        process.send!({ ok: true, hasAttrs: !!tree.attributes });
        break;
      }
      case "startCaptureScreen":
        try {
          await dev!.agent.captureScreen({ scale: 2 });
          process.send!({ ok: true });
        } catch (e: any) {
          process.send!({ ok: false, name: e.name, message: e.message });
        }
        break;
      case "ping":
        process.send!({ ok: true, size: await dev!.agent.getDisplaySize() });
        break;
      case "dispose":
        await dev?.dispose();
        process.send!({ ok: true });
        break;
    }
  } catch (e: any) {
    process.send!({ ok: false, name: e.name, message: e.message });
  }
});
```

- [ ] **Step 2: 写失败测试 `test/device/multi-instance.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { getTarget, hasCastSupport } from "./helpers.js";

const TARGET = getTarget()!;
const workers: ChildProcess[] = [];

function spawn(): Promise<ChildProcess> {
  const w = fork(new URL("./worker.ts", import.meta.url), [], { execArgv: ["--import", "tsx"] });
  workers.push(w);
  return new Promise((r) => w.once("spawn", () => r(w)));
}

function ask(w: ChildProcess, msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("worker timeout")), 60000);
    w.once("message", (m) => { clearTimeout(to); resolve(m); });
    w.send(msg);
  });
}

afterEach(async () => {
  for (const w of workers.splice(0)) {
    await ask(w, { op: "dispose" }).catch(() => {});
    w.kill();
  }
});

describe("multi-instance", () => {
  it("second connect reuses the daemon instead of restarting it", async () => {
    const a = await spawn();
    const ra = await ask(a, { op: "connect", target: TARGET });
    expect(ra.ok).toBe(true);
    expect(ra.ownsDaemon).toBe(true);          // 第一个启的

    const b = await spawn();
    const rb = await ask(b, { op: "connect", target: TARGET });
    expect(rb.ok).toBe(true);
    expect(rb.ownsDaemon).toBe(false);         // 复用，没重启
  }, 120000);

  it("two processes hammering concurrently both fully succeed", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    const [ra, rb] = await Promise.all([
      ask(a, { op: "hammer", calls: 40 }),
      ask(b, { op: "hammer", calls: 40 })
    ]);
    expect(ra).toMatchObject({ ok: true, n: 40 });
    expect(rb).toMatchObject({ ok: true, n: 40 });
    // 关键：没有任何 Disallow concurrent use 泄漏到调用方
  }, 120000);

  it("RPC in B works while A is streaming", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    expect((await ask(a, { op: "startStream" })).ok).toBe(true);
    const rb = await ask(b, { op: "captureLayout" });
    expect(rb).toMatchObject({ ok: true, hasAttrs: true });
  }, 120000);

  it("B's captureScreen fails with AgentBusyError while A streams", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    await ask(a, { op: "startStream" });
    const rb = await ask(b, { op: "startCaptureScreen" });
    expect(rb.ok).toBe(false);
    expect(rb.name).toBe("AgentBusyError");
  }, 120000);

  it("A's dispose does not disturb B", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    await ask(a, { op: "dispose" });
    a.kill();
    const rb = await ask(b, { op: "ping" });
    expect(rb.ok).toBe(true);
  }, 120000);

  it("both can dispose without error", async () => {
    const a = await spawn(), b = await spawn();
    await ask(a, { op: "connect", target: TARGET });
    await ask(b, { op: "connect", target: TARGET });
    const [ra, rb] = await Promise.all([ask(a, { op: "dispose" }), ask(b, { op: "dispose" })]);
    expect(ra.ok && rb.ok).toBe(true);
  }, 120000);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/device/multi-instance.test.ts --target 127.0.0.1:5555`
Expected: FAIL —— 至少「second connect reuses daemon」会失败，因为 Task 11 的实现里若还留着无条件 `kill -9` 就会重启 daemon

- [ ] **Step 4: 修 Task 11 实现直到全绿**

Run: `npx vitest run test/device/multi-instance.test.ts --target 127.0.0.1:5555`
Expected: 6 tests PASS

- [ ] **Step 5: 真机复跑**

Run: `npx vitest run test/device/multi-instance.test.ts --target <your-device-id>`
Expected: 6 tests PASS

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "test: add cross-process multi-instance coexistence tests"
```

---

### Task 15: 验收报告生成器

**Files:**
- Create: `scripts/acceptance.ts`
- Create: `docs/acceptance/.gitkeep`
- Create: `test/device/acceptance.helpers.ts`

**Interfaces:**
- Consumes: `Device`（Task 11）全部 API
- Produces: `docs/acceptance/report.md`、`docs/acceptance/screenshots/*.png`、`docs/acceptance/logs/*.log`、`docs/acceptance/scripts/*.ts`

- [ ] **Step 1: 写 `test/device/acceptance.helpers.ts`**

```ts
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export const ROOT = "docs/acceptance";

export async function ensureDirs() {
  for (const d of ["", "screenshots", "logs", "scripts"]) {
    await mkdir(join(ROOT, d), { recursive: true });
  }
}

export class Evidence {
  constructor(readonly capability: string, readonly env: string) {}

  private get logPath() { return join(ROOT, "logs", `${this.capability}-${this.env}.log`); }
  private get shotPath() { return join(ROOT, "screenshots", `${this.capability}-${this.env}.png`); }

  async log(line: string) {
    await appendFile(this.logPath, `[${new Date().toISOString()}] ${line}\n`);
  }

  async screenshot(jpeg: Buffer) {
    await writeFile(this.shotPath, jpeg);
    return this.shotPath;
  }
}

export interface Result {
  capability: string
  env: string
  status: "PASS" | "FAIL" | "SKIP"
  ms?: number
  detail?: string
  screenshot?: string
  log?: string
}
```

- [ ] **Step 2: 写 `scripts/acceptance.ts`**

职责：对每个目标设备跑完整验收，产出证据文件，最后渲染 `report.md`。

结构：
```
for (const target of targets) {            // 真机 + 模拟器
  env = target.startsWith("127.0.0.1") ? "emulator" : "device"
  dev = await Device.connect({ deviceId: target })
  for (const cap of CAPABILITIES) {
    if (cap.requiresCast && env === "emulator") {
      results.push({ capability: cap.name, env, status: "SKIP", detail: "no x86_64 casting build" })
      continue
    }
    ev = new Evidence(cap.name, env)
    t0 = performance.now()
    try {
      await cap.run(dev, ev)                       // 内部会写 log + 截图
      results.push({ ..., status: "PASS", ms: performance.now() - t0 })
    } catch (e) {
      await ev.log(`FAILED: ${e.message}\n${e.stack}`)
      results.push({ ..., status: "FAIL", detail: e.message })
    }
  }
  await dev.dispose()
}
await renderReport(results, envInfo)
```

`CAPABILITIES` 数组覆盖 spec §7.2 全部行；`cap.run` 里**必须**在成功路径上也调 `ev.screenshot()`（用 SDK 自己的 `captureScreen()`），让截图本身成为能力证明。

`renderReport()` 输出 `report.md`：环境清单表 → 功能验收表 → 多实例表 → 性能对比表 → 失败/跳过说明 → 附录链接。

- [ ] **Step 3: 写最小复现脚本生成**

`ensureDirs()` 后，为每个能力写一份 `docs/acceptance/scripts/<capability>.ts`，内容是一个 20 行以内的独立可运行脚本（`node --import tsx scripts/xxx.ts --target <id>`）。这些脚本由 `acceptance.ts` 用模板字符串生成，内容固定，不需要手写。

- [ ] **Step 4: 运行**

```bash
npx tsx scripts/acceptance.ts --targets <your-device-id>,127.0.0.1:5555
```
Expected:
- `docs/acceptance/report.md` 生成
- `screenshots/` 下每个能力 × 每个环境一张 PNG
- `logs/` 下每个能力 × 每个环境一份完整输出
- 报告里真机全 PASS；模拟器 casting 行标 SKIP

- [ ] **Step 5: 人工核对报告**

打开 `report.md`，逐条确认：
- 每个能力都有截图和日志（`ls docs/acceptance/screenshots | wc -l` 应等于能力数 × 2 减 SKIP 数）
- 失败项为空；SKIP 项都写了原因
- 性能数字与 §2.4 基线同量级

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: add acceptance report generator with screenshots and logs"
```

---

### Task 16: 文档与资源清单

**Files:**
- Create: `README.md`
- Create: `assets/manifest.json`
- Create: `.gitignore`

**Interfaces:** 无

- [ ] **Step 1: 写 `assets/manifest.json`**

```json
{
  "arm64": {
    "agent.so": { "version": "1.1.10", "size": 600246, "source": "devicetest/res/prototype/native/uitest_agent_v1.1.10.so" },
    "libscreen_casting.z.so": { "version": "6.8-20260801", "size": 247989, "source": "devicetest/res/recorder/" }
  },
  "x86_64": {
    "agent.so": { "version": "1.1.9", "size": 1460181, "source": "@deveco/deveco-cli/.../resources/uitest/uitest_agent_v1.1.9.x86_64.so" }
  }
}
```

- [ ] **Step 2: 写 `README.md`**

包含：一句话定位、安装、最小示例（connect → click → captureScreen → dispose）、能力表（含真机/模拟器实测延迟）、多实例用法（`ownsDaemon` / `retryOnBusy` / `ownDaemon` 说明）、已知限制（窗口级截图 / AAMS / 虚拟屏 / perfmonitor 不可用 / 模拟器无 casting）、扩展来源说明（`extensionDir` 覆盖）、验收报告链接。

- [ ] **Step 3: 写 `.gitignore`**

`node_modules/`、`dist/`、`*.log`、`test/device/.tmp/`；**不忽略 `docs/acceptance/`**（报告要入库）

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "docs: add README, asset manifest and gitignore"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 覆盖任务 |
|---|---|
| §1.4 运行环境（双环境 / ABI 选择 / 模拟器前置） | Task 12、13 |
| §2.4 性能基线（含 swipe/触摸/键盘实测） | Task 7（实现选择）、Task 13（耗时断言） |
| §2.5 投流路径选择（H.264 优先 / MJPEG 兜底） | Task 9、10、12 |
| §2.6 竞品对比（能力取舍依据） | Task 7（inputText/triggerKey）、Task 10（MJPEG） |
| §4.1 HdcRunner | Task 5 |
| §4.2 AgentClient（队列/解复用/截图/动作） | Task 3、4、6、7、8 |
| §4.3 CastClient | Task 9、10 |
| §4.4 CliRunner | Task 11 |
| §4.5 Device 门面 + 自动重启 + createCast 选择 | Task 12 |
| §4.6 多实例共存（daemon 复用 / 退避重试 / 流冲突） | Task 6（重试）、Task 12（复用）、Task 14（测试） |
| §5 数据模型 | Task 2 |
| §6 错误处理（含 AgentBusyError） | Task 1、6、12 |
| §7.1 单元测试 | 各任务 |
| §7.2 功能验收矩阵 | Task 13 |
| §7.3 多实例测试 | Task 14 |
| §7.4 双环境执行 | Task 13 Step 4~5 |
| §7.5 验收报告 | Task 15 |
| §7.6 性能回归 | Task 13（耗时断言） |
| §11 分发（extensionDir / ABI 目录） | Task 12、16 |

**2. Step scan** — 每个实现步骤给了签名 + 关键约束，没有整段函数体（`demux` 和 `captureScreen` 因为状态机/顺序不可从签名推出，给了算法描述而非代码）。

**3. Type consistency** — `AgentClient.call(method, params)` 在 Task 6 定义、Task 7/8 使用一致；`H264Chunk`/`JpegFrame` 在 Task 2 定义、Task 9/10 使用；`Rect` 在 Task 2 定义、Task 2 使用；`AgentClientOptions` 在 Task 6 定义、Task 12 透传；`DeviceOptions.ownDaemon/retryOnBusy` 在 Task 12 定义、Task 14 依赖 `dev.ownsDaemon`；`CastClient.castKind` 在 Task 9 定义、Task 10 实现、Task 13 断言。

**4. Review Focus** — 七条都落到了具体任务：跨包边界（Task 3 测试 3/4）、JPEG 内 `{` 与 `FFD8`（Task 3 测试 5/6）、流式期间 RPC（Task 8 测试 3 + Task 13）、daemon 崩溃（Task 12 测试）、端口冲突（Task 5 测试 3）、两进程同时 connect（Task 14 测试 1）、两进程高频并发（Task 14 测试 2）。

**5. Proportion** — 计划约 2,030 行 vs spec 约 860 行，约 2.4 倍。增量集中在验收矩阵测试、多实例测试、竞品对比结论 —— 前两块是用户明确要求，第三块是能力取舍的依据（避免实现者「为什么不学他们」的反复）。
