# uitest-sdk API 文档

面向 Node.js 的鸿蒙 `uitest` 扩展 SDK：UI 自动化、整屏截图、窗口截图、MJPEG / H.264 投流与 MP4 录制。
一条 TCP 长连接（`agent.so`）负责所有交互；H.264 投流与录制走另一条 gRPC 通道（`libscreen_casting.z.so`）。

- 实测数字见 [benchmarks.md](benchmarks.md) 与 [../docs/acceptance/report.md](acceptance/report.md)。
- 已知限制见 [README](../README.md#已知限制)。

## 目录

1. [安装与前提](#1-安装与前提)
2. [快速开始](#2-快速开始)
3. [核心概念](#3-核心概念)
4. [Device](#4-device)
5. [AgentClient：UI 自动化](#5-agentclientui-自动化)
6. [投流与录制](#6-投流与录制)
7. [UI 树与窗口](#7-ui-树与窗口)
8. [工具类](#8-工具类)
9. [错误](#9-错误)
10. [并发与生命周期](#10-并发与生命周期)
11. [示例](#11-示例)

## 1. 安装与前提

```bash
npm install uitest-sdk
```

- **Node.js ≥ 20**
- **hdc**：DevEco Studio 自带的 `hdc` 在 `PATH` 上，或设置 `HDC_PATH`，或在 `Device.connect({ hdcPath })` 里指定。
- **一台设备**：真机或模拟器，`hdc list targets` 能看到。
- **扩展文件**：已随 npm 包发布在 `assets/` 下（`arm64/agent.so`、`arm64/libscreen_casting.z.so`、`x86_64/agent.so`），
  `Device.connect()` 会自动推送缺失的那份。默认目录取自包自身位置，与进程的工作目录无关；
  要换成本地构建的扩展时传 `extensionDir`。
- **H.264 与录制需要 arm64 设备**：x86_64 模拟器只有 MJPEG（见 [6. 投流与录制](#6-投流与录制)）。

## 2. 快速开始

```ts
import { Device } from "uitest-sdk";

const dev = await Device.connect(); // 或 Device.connect({ deviceId })
try {
  const { width, height } = await dev.agent.getDisplaySize();

  await dev.agent.click(width / 2, height / 2);
  await dev.agent.swipe(width / 2, height * 0.7, width / 2, height * 0.3);

  const jpeg = await dev.agent.captureScreen(); // 608×1344 JPEG
  console.log(`captured ${jpeg.length} bytes`);
} finally {
  await dev.dispose();
}
```

可运行的 JavaScript 版：[examples/quickstart.mjs](../examples/quickstart.mjs)。

## 3. 核心概念

### 坐标

所有触摸坐标都用**逻辑显示坐标**（`getDisplaySize()` 返回的那套，例如 1216×2688）。
`captureScreen()` 默认按 `scale: 0.5` 出图（608×1344）；要把截图上的点换回显示坐标，
乘以 `display.width / image.width`，`cropToWindow()` 内部就是这么做的。

### 扩展与 daemon

`Device.connect()` 依次完成：读 ABI → 推送对应 `agent.so`（必要时也推 casting 扩展）→
如果没有 daemon 在监听 8012 就拉起一个 → 建 `hdc fport` 隧道 → 连上 TCP → 用一次
`getDisplaySize()` 做健康检查。任何一步失败都会清掉自己建立的隧道与 daemon，然后抛错。

### 失败即报错

每个失败都是 `UitestError` 的子类，带稳定的 `code`（见 [9. 错误](#9-错误)）。
SDK 不做静默降级：能走 H.264 就走 H.264，走不了会明确告诉你走的是 MJPEG，而不是先试后换。

## 4. Device

```ts
import { Device } from "uitest-sdk";

const dev = await Device.connect(options?: DeviceOptions);
```

### `DeviceOptions`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `hdcPath` | `string` | 自动查找 | `hdc` 可执行文件路径；查找顺序：`HDC_PATH` → `PATH` → 常见 DevEco 安装位置 |
| `deviceId` | `string` | 唯一设备 | 多设备时必须指定（或设 `HDC_TARGET`） |
| `agentPort` | `number` | `8012` | 本地隧道起始端口；被占用时向后找空位 |
| `autoRestart` | `boolean` | `true` | 连接断开后，下一次调用自动重建传输；正在进行的请求不会重放 |
| `extensionDir` | `string` | 包内 `assets/` | 本地扩展目录，按 `<dir>/<abi>/agent.so` 查找 |
| `requestTimeoutMs` | `number` | `30000` | 单次请求超时；超时后连接会被丢弃（避免迟到的回复配错请求） |
| `ownDaemon` | `boolean` | `false` | 为 `true` 时，`dispose()` 杀掉「本实例拉起的那一个」daemon |
| `retryOnBusy` | `boolean` | `true` | 设备全局锁冲突时按抖动退避重试 |

### 属性与方法

| 成员 | 类型 | 说明 |
|---|---|---|
| `dev.agent` | `AgentClient` | 长连接客户端，见第 5 节 |
| `dev.cli` | `CliRunner` | 走 `uitest dumpLayout` 的窗口级工具，见第 7 节 |
| `dev.state` | `"connected" \| "disconnected"` | `dispose()` 后变为 `disconnected`，再调用会抛 `EDISPOSED` |
| `dev.ownsDaemon` | `boolean` | 本次连接是否由自己拉起 daemon |
| `dev.resolveCastExtension()` | `string \| null` | 该 ABI 的 casting 扩展路径；`null` 表示没有 |
| `dev.createCast(opts)` | `Promise<CastClient>` | 见第 6 节 |
| `dev.dispose()` | `Promise<void>` | 关连接、撤销自己的 fport；`ownDaemon: true` 时再杀掉自己的 daemon |

## 5. AgentClient：UI 自动化

所有方法都是 `await` 的 Promise，失败抛 `UitestError`。

### 显示

```ts
await dev.agent.getDisplaySize();     // { width: 1216, height: 2688 }
await dev.agent.getDisplayRotation(); // 0 / 1 / 2 / 3
```

### 触摸

```ts
await dev.agent.click(x, y);
await dev.agent.touchDown(x, y);
await dev.agent.touchMove(x, y);
await dev.agent.touchUp(x, y);
await dev.agent.swipe(x1, y1, x2, y2, { steps?: number; durationMs?: number });
```

- `click` = `touchDown` + `touchUp`，实测 8–30 ms。
- `swipe` 默认 `steps: 8`、`durationMs: 300`；它是 touchDown + N 次 touchMove + touchUp 的**三段式**，
  不用 `Driver.swipe`（后者在模拟器上要 6–12 秒）。中途失败时会先 `touchUp` 再抛错，不会把手指留在屏幕上。
- 坐标必须是整数（SDK 在边界处四舍五入）。

### 文本与按键

```ts
await dev.agent.inputText(x, y, "hello"); // hypium Driver.inputText，730–1540 ms
await dev.agent.triggerKey(keyCode);      // hypium Driver.triggerKey
```

### 截图

```ts
const jpeg = await dev.agent.captureScreen();          // 608×1344 JPEG Buffer，107–193 ms
const jpeg2 = await dev.agent.captureScreen({ scale: 1 }); // 1.1.10 上 scale 无效，仍返回 608×1344
```

实现是「起一次采集流 → 取第一帧 → 停止」，这是设备上最快的整屏路径。

### 连续取帧（MJPEG）

```ts
for await (const jpeg of dev.agent.streamScreen({ scale: 0.5 })) {
  // jpeg 是完整的 JPEG Buffer
  if (done) break;
}
```

采集是脏区驱动的：**静止画面只出 1 帧**然后不再出帧，这不是卡死。断开循环会自动 `stopStream()`。

### UI 事件流

```ts
for await (const ev of dev.agent.streamUiActions()) {
  console.log(ev.type, ev);
}
```

只上报**真实用户输入**；通过 agent 注入的合成触摸不会回传。`stopCaptureUiAction` 会关闭会话，
同一连接上的后续流需要重新建立。

### 事件与低层接口

```ts
const off = dev.agent.onFrame((jpeg) => void 0); // 采集流里的每一帧
const offClose = dev.agent.onClose((err) => void 0); // 传输断开时触发一次
dev.agent.connected; // boolean
dev.agent.close();   // 主动关闭；之后不再重连

await dev.agent.call("CtrlCmd", { api: "getDisplaySize", args: [] }); // 任意协议方法
await dev.agent.hypium("Driver.screenCapture", "Driver#0", []);      // 任意 hypium API
```

`call` 的 `method` 只能是 `"Captures" | "CtrlCmd" | "Gestures" | "callHypiumApi"`。

## 6. 投流与录制

```ts
const cast = await dev.createCast({
  mode: "stream",      // "stream" | "record"
  frameRate: 60,       // 15 | 30 | 60 | 120，默认 30
  scale: 2,            // 1..5 整数缩小因子，默认 1
});
for await (const chunk of cast.stream()) {
  // H.264: { data, pts, flags, isKeyFrame }；MJPEG: { data, pts }
  if (chunk.isKeyFrame) { /* 从这里开始解码 */ }
}
await cast.requestIDRFrame(); // H.264 专用；MJPEG 上是 no-op
await cast.dispose();
```

### `CastOptions`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `"stream" \| "record"` | 必填 | `record` 只支持 arm64（需要 casting 扩展） |
| `frameRate` | `15 \| 30 \| 60 \| 120` | `30` | 扩展只认这四个值，其它值会被设备侧静默重置 |
| `scale` | `1..5` | `1` | 整数缩小因子；越界抛 `EBADARG` |
| `outputPath` | `string` | — | `record` 必填，`dispose()` 时把 MP4 拉到这里 |
| `bitRate` | `number` | `8_000_000` | 编码码率 |
| `iFrameInterval` | `number` | `2000` | 关键帧间隔 |
| `screenId` | `number` | `0` | |
| `socketName` | `string` | 内部常量 | 覆盖抽象 socket 名；这是同机跑多个投流的唯一方式 |
| `durationMs` | `number` | — | `record`：录制时长 |

### `CastClient`

| 成员 | 说明 |
|---|---|
| `castKind` | `"h264"` 或 `"mjpeg"`，**显式选择的结果** |
| `stream()` | `AsyncIterable<H264Chunk \| JpegFrame>` |
| `requestIDRFrame()` | 请求一个关键帧（H.264）；MJPEG 无操作 |
| `dispose()` | 结束投流；录制模式下关闭 muxer 并拉回文件 |

### 选择规则

- `resolveCastExtension()` 非空 → H.264（gRPC over Unix abstract socket，实测 15–89 fps）。
- 为空（x86_64 模拟器）→ MJPEG（`castKind === "mjpeg"`，10–16 fps）。
- x86_64 上请求 `mode: "record"` 直接抛 `ExtensionMissingError`，不会返回一个「录不到东西」的客户端。

### 录制

```ts
const cast = await dev.createCast({ mode: "record", frameRate: 30, outputPath: "out.mp4" });
// 让画面动起来：静止画面不会产生新帧
await cast.dispose(); // 关闭 muxer → 等待设备写完 → 拉回 out.mp4
```

设备侧文件路径写死在扩展里（`/data/local/tmp/mytest.mp4`），不可改。
编码器是**起停驱动**的：`createCast` 返回时已经在录，`dispose()` 后才完成。

## 7. UI 树与窗口

### 整屏 UI 树

```ts
const tree = await dev.agent.captureLayout(); // { attributes, children }
console.log(tree.attributes.bundleName, tree.children.length);
```

### 窗口截图

设备不提供窗口级截图，SDK 的做法是「整屏采集 + 按节点 bounds 裁剪」：

```ts
const jpeg = await dev.agent.cropToWindow({ bundleName: "com.huawei.hmos.settings" });
const jpeg2 = await dev.agent.cropToWindow({ windowId: 12, scale: 1 });
```

找不到窗口抛 `ENOWINDOW`，节点没有可解析的 bounds 抛 `ENOBOUNDS`。

### 窗口级 UI 树

`agent.captureLayout()` 永远返回整屏。要按窗口过滤，用 `cli.dumpLayout`（一次 shell + pull，约 1.5 s）：

```ts
const tree = await dev.cli.dumpLayout({ windowId: 12 });
const tree2 = await dev.cli.dumpLayout({ bundleName: "com.huawei.hmos.settings", withFontAttrs: true });
```

### 找节点

```ts
import { parseBounds, type UiNode } from "uitest-sdk";

function find(node: UiNode, pred: (n: UiNode) => boolean): UiNode | null {
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return null;
}

const tree = await dev.agent.captureLayout();
const target = find(tree, (n) => n.attributes.text === "设置");
const bounds = target && parseBounds(target.attributes.bounds ?? "");
if (bounds) {
  await dev.agent.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}
```

`attributes` 是设备原样给出的字符串字典（`text`、`type`、`bounds`、`bundleName` 等）。

## 8. 工具类

| 导出 | 说明 |
|---|---|
| `parseBounds("[x1,y1][x2,y2]")` | 解析成 `{ x, y, width, height }`，格式不对返回 `null` |
| `cropRect(inner, outer)` | 求交集矩形；无交集返回零矩形 |
| `FrameDemux({ onJson, onFrame })` | 把「一行 JSON + 裸 JPEG」的混合流拆开，`push(chunk)` 喂数据，`reset()` 重置 |
| `SerialQueue` | 串行队列，`run(fn)` 保证同一时刻只有一个请求在途，`depth` 是排队长 |
| `HdcRunner` | hdc 封装：`shell`、`push`、`pull`、`readLocal`、`fportAdd`、`fportRemove`、`listTargets` |
| `CliRunner` | 见第 7 节 |
| `isBusyException(msg)` | 判断设备返回的是不是「全局锁被占用」 |
| `MODULE_ID` | 扩展模块名 `com.ohos.devicetest.hypiumApiHelper` |
| `CASTING_EXTENSION` | `libscreen_casting.z.so` |
| `resolveCastingExtension(abi, dir)` | 该 ABI 的 casting 扩展路径，没有返回 `null` |
| `loadScrcpyService()` | 加载 `scrcpy.proto` 的 gRPC service 构造器（低层用） |
| `H264CastClient` / `MjpegCastClient` | 低层客户端；正常用 `dev.createCast()`，它们会自己管 daemon 与端口 |

## 9. 错误

所有错误继承 `UitestError`，带 `code` 与可选 `cause`。

| 类 | 典型 code | 触发条件 |
|---|---|---|
| `DeviceNotConnectedError` | `ENODEVICE` / `ENOHDC` / `EHDC` / `EDISPOSED` | 没有设备、找不到 hdc、hdc 命令失败、Device 已 dispose |
| `ExtensionMissingError` | `ENOEXT` / `ENOCAST` | 本地没有对应 ABI 的 `agent.so`；x86_64 上请求录制 |
| `DaemonStartError` | `ENODAEMON` / `EPORT` / `ENOSOCKET` / `ENORECORD` | daemon 拉不起来、端口耗尽、投流 socket 没出现、录制文件没出现 |
| `AgentProtocolError` | `EPROTO` / `ETIMEDOUT` / `EBADJSON` / `ENOWINDOW` / `ENOBOUNDS` / `EBADARG` | 设备返回异常、请求超时、输出不是 JSON、找不到窗口/边界、参数非法 |
| `AgentBusyError` | `EBUSY` | 设备全局锁被其它进程占着且重试耗尽；或该设备已有采集流（立即失败，不等待） |
| `AgentConnectionError` | `ECONN` | 连接不可用、请求超时后连接被丢弃、关闭后继续调用 |

## 10. 并发与生命周期

- **一条连接一个在途请求**：`SerialQueue` 串行化；断开后 `autoRestart` 会用新 socket 重连，**不重放**失败中的请求。
- **全局锁冲突**：只有 `Disallow concurrent use` 会退避重试（0.5 s 起，抖动后翻倍，最多 40 次）。
- **采集冲突**：设备同一时刻只允许一条采集流。`Capture already running` 立刻抛 `AgentBusyError`，
  不会等、不会抢占。同一进程里请把截图与投流串行起来，或者用 `socketName` 分开投流。
- **daemon 归属**：`pidof uitest` 会列出所有 uitest 进程，别人拉起的不归你杀。
  SDK 只认「本次连接前后新增的、且只有一个」的 pid；`ownDaemon: true` 时才会在 `dispose()` 杀掉它。
- **超时即断连**：请求超时后连接被丢弃（回复没有请求 id，迟到的回复会配错请求），下一次调用走重连。
- **进程退出前 `dispose()`**：撤销 fport；否则本地会留下隧道。

## 11. 示例

### 点击与滑动

```ts
const { width, height } = await dev.agent.getDisplaySize();
await dev.agent.click(width / 2, height / 2);
await dev.agent.swipe(width / 2, height * 0.8, width / 2, height * 0.2, { durationMs: 200 });
await dev.agent.inputText(width / 2, height * 0.5, "hello");
```

### 截图并换算坐标

```ts
const { width } = await dev.agent.getDisplaySize();
const jpeg = await dev.agent.captureScreen(); // 默认 scale 0.5 → 608×1344
const factor = width / 608; // 1216 / 608 = 2，截图坐标 × 2 = 显示坐标
```

> `scale` 参数在 agent 1.1.10 上不生效，永远返回 608×1344；换算时直接用
> `display.width / 608`，不要相信传入的 `scale`。

### 按文本点按钮

见第 7 节「找节点」。

### 只截一个应用窗口

```ts
const jpeg = await dev.agent.cropToWindow({ bundleName: "com.huawei.hmos.settings" });
```

### 投流并解码

```ts
const cast = await dev.createCast({ mode: "stream", frameRate: 30 });
try {
  for await (const chunk of cast.stream()) {
    if ("isKeyFrame" in chunk && chunk.isKeyFrame) {
      // H.264 Annex-B：从这里开始送解码器
    }
  }
} finally {
  await cast.dispose();
}
```

### 录制 10 秒

```ts
const cast = await dev.createCast({ mode: "record", frameRate: 30, outputPath: "demo.mp4" });
await new Promise((r) => setTimeout(r, 10_000));
await cast.dispose();
```

### 多设备并行

```ts
const ids = ["<device-a>", "<device-b>"];
const devices = await Promise.all(ids.map((deviceId) => Device.connect({ deviceId })));
try {
  await Promise.all(devices.map((d) => d.agent.click(100, 100)));
} finally {
  await Promise.all(devices.map((d) => d.dispose()));
}
```

### 低层 hypium

```ts
await dev.agent.hypium("Driver.screenCapture", "Driver#0", []);
```

---

生成于 2026-11-15。行为与数字对应的源码版本：`0.1.0`。
