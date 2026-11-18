# uitest-sdk API 文档

面向 Node.js 的鸿蒙 `uitest` 扩展 SDK：UI 自动化、整屏截图、窗口截图、MJPEG / H.264 投流与 MP4 录制。
一条 TCP 长连接（`agent.so`）负责所有交互；H.264 投流与录制走另一条 gRPC 通道（`libscreen_casting.z.so`）。

这是一个**库**：没有可执行文件，也没有界面。命令行与 Agent 接入在
[`uitest-phone`](https://www.npmjs.com/package/uitest-phone)，浏览器里的投屏、接管与审批收件箱在
[`uitest-console`](https://www.npmjs.com/package/uitest-console)。两者都只用本文档里的公开 API。

- 实测数字见 [benchmarks.md](benchmarks.md) 与 [../docs/acceptance/report.md](acceptance/report.md)。
- 已知限制见 [README](../README.md#已知限制)。

## 目录

1. [安装与前提](#1-安装与前提)
2. [快速开始](#2-快速开始)
3. [核心概念](#3-核心概念)
4. [Session：按用途分类的入口](#4-session按用途分类的入口)
5. [Device 与 AgentClient](#5-device-与-agentclient)
6. [投流与录制](#6-投流与录制)
7. [Viewer：画面、inspect 与浏览器输入](#7-viewer画面inspect-与浏览器输入)
8. [UI 树与窗口](#8-ui-树与窗口)
9. [完整 hypium API](#9-完整-hypium-api)
10. [工具类](#10-工具类)
11. [错误](#11-错误)
12. [并发与生命周期](#12-并发与生命周期)
13. [示例](#13-示例)
14. [策略、审批与接管](#14-策略审批与接管)
15. [子路径一览](#15-子路径一览)

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
import { connect } from "uitest-sdk";

const session = await connect(); // 或 connect({ deviceId })
try {
  const screen = await session.observe.layout(); // { display, elements, lines, hash, ... }
  const { width, height } = screen.display;

  await session.act.tap({ text: "设置" });
  await session.act.swipe({ from: { x: width / 2, y: height * 0.7 }, to: { x: width / 2, y: height * 0.3 } });

  const shot = await session.observe.screenshot(); // 608×1344 JPEG
  console.log(`captured ${shot.path}`);
} finally {
  await session.close();
}
```

`connect()` 是 `Device.connect()` + `Session.open()` 的一步版本：失败时会先 dispose 设备，
不会留下 daemon 和 fport。要自己管设备时，两步分开写（见 [4.](#4-session按用途分类的入口)）。

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

## 4. Session：按用途分类的入口

```ts
import { connect, Device, Session } from "uitest-sdk";
import { CoreSession } from "uitest-sdk/commands";

const session = await connect({ deviceId, task: "check WLAN" }); // 一步
// 或分两步，自己管 Device 的生命周期：
const dev = await Device.connect({ deviceId });
const session2 = new Session(dev, await CoreSession.open(dev, { task: "check WLAN" }));
```

`connect()` 返回的 `Session` 把能力按**用途**分成六个命名空间，读屏的人不用猜某个方法在
device、session 还是 driver 上：

| 命名空间 | 成员 | 说明 |
|---|---|---|
| `observe` | `(opts?)`、`layout(opts?)`、`screenshot(opts?)`、`window(filter?, opts?)`、`apps()`、`inspect(opts?)` | 读：一行一元素的屏幕、节点表、截图、窗口、应用、带框的面板 |
| `act` | `tap`、`type`、`swipe`、`drag`、`fling`、`pinch`、`key`、`launch`、`longPress`、`doubleClick` | 做：全部输入动作，返回值见 [11. 错误](#11-错误)的状态表 |
| `wait` | `forText`、`forSelector`、`settle`、`scrollUntil` | 等：等出现、等稳定、逐屏翻找 |
| `cast` | `open(opts?)`、`record({ out, ... })`、`configure(settings)` | 投屏：流、录制、默认值持久化 |
| `view` | `open({ port?, host?, privacy?, layout?, open? })` | 起 core 的 viewer 页面（镜像 + 可选节点表 + 隐私开关） |
| `govern` | `policy`、`approvals.{pending, decide}`、`lease.{assert, info, hold, resume}`、`trace`、`recent(limit?)` | 治理：规则、审批、租约、记录 |

`session.device` 是底层 `Device`（见下一节），`session.core` 是底层 `Session`（`uitest-sdk/commands`
里叫 `CoreSession`）。`session.tag` 是设备序列号的 8 位哈希，`session.stateDir` / `session.task`
是这次会话的落盘目录与任务名。`session.close()` 关掉本会话开的所有 viewer、释放租约、dispose 设备。

`observe` 可以直接调用（`await session.observe({ out: "a.jpg" })`），也可以取 `.layout()` 拿节点表、
`.screenshot()` 拿路径。`act.*` 的返回值是 `ActionResult`：`status` 是 `settled` / `not_found` /
`blocked` / `approval_pending` / `lease_held` 这类**任务结果**，不是异常；真正的传输错误才抛
`UitestError`。

### `SessionOptions`

| 字段 | 默认 | 说明 |
|---|---|---|
| `task` | `"session"` | 任务名，写进租约与 trace |
| `stateDir` | `.uitest-phone` | ref、审批、租约、trace 与截图的目录 |
| `policy` | 默认审批集 | `{ readOnly?, confirm?, apps? }`，见 [14.](#14-策略审批与接管) |
| `settleMs` | 5000 | 动作后等 UI 安静的最长时间 |
| `traceShots` | `false` | 每步存一张截图 |
| `noTrace` | `false` | 不读也不写 trace 文件 |
| `approvalTtlMs` | 60000 | 人有多久回答一次审批 |
| `lease` | 自动 | `false` 不取租约（只读旁观）；`{ dir, staleMs }` 自定义租约位置 |

被别的任务占着时 `connect()` / `CoreSession.open()` 抛 `LeaseHeldError`，此时设备还没被读写。

## 5. Device 与 AgentClient

`Session` 之下是设备本身。要直接调用扩展的 RPC、或自己写一个 reader，用这两层。

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
| `dev.files` | `Files` | 设备文件：`list` / `stat` / `exists` / `mkdir` / `remove` / `move` / `push` / `pull` / `readText`，见第 9 节 |
| `dev.state` | `"connected" \| "disconnected"` | `dispose()` 后变为 `disconnected`，再调用会抛 `EDISPOSED` |
| `dev.ownsDaemon` | `boolean` | 本次连接是否由自己拉起 daemon |
| `dev.resolveCastExtension()` | `string \| null` | 该 ABI 的 casting 扩展路径；`null` 表示没有 |
| `dev.dispose()` | `Promise<void>` | 关连接、撤销自己的 fport；`ownDaemon: true` 时再杀掉自己的 daemon |

### `AgentClient`：扩展的 RPC

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
const jpeg = await dev.agent.captureScreen();          // 608×1344 JPEG Buffer，109–222 ms
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

### 投屏与实时检查：`viewer`

把设备画面和布局同时放进一个浏览器页面，给**人**看，而不是给程序消费。`session.view.open()`
起的就是它；产品要自己的页面时，直接用 `uitest-sdk/viewer` 的 `startViewerServer`：

```ts
const view = await session.view.open();            // http://127.0.0.1:7000/
const view2 = await session.view.open({ port: 0, privacy: false, layout: false });
await view.close();                                 // 关页面，不关会话
```

页面里能做的事：

- **镜像**：H.264 走浏览器自带的 WebCodecs `VideoDecoder`，MJPEG（x86_64）走 `createImageBitmap`；
  服务端把设备侧的 Annex-B 转成 AVCC，并把 SPS/PPS 拼成 `avcC` 作为 `description`，
  所以页面上没有 MSE、没有 fMP4 重封装、没有额外缓冲层。
  解码器交给浏览器挑：**不传 `hardwareAcceleration`**，有 GPU 就走硬解，没有就自动软解。
  显式写 `prefer-hardware` 反而有害——实测在 `--disable-gpu` 的 Chrome 上
  `isConfigSupported()` 返回 false、`configure()` 抛 `OperationError`，30 帧一帧都出不来（黑屏）。
  默认配置被拒时，页面会再用 `prefer-software` 重试一次，并在提示条上写「no hardware decoder, using software」。
  解码中途出错（例如收到损坏的帧）也会重开一个解码器并请求关键帧，画面能自己恢复。
- **取值**：右侧是当前屏的节点表，点节点（或点画面上的框）就复制它的 `ref` / `role` / `label` / 中心坐标；
  `JSON` 按钮复制整条节点。框上的编号与 `observe` / `tap --ref` 用的是同一套 ref。
- **隐私开关**：默认打开，密码框与验证码在**节点表和画面上都被遮住**。关掉后服务端会用
  `redact: false` 重新读布局，标签原文才出现。遮罩在 `ScreenBuilder` 里完成，所以关掉开关是
  「不遮」，不是「事后擦除」；多个页面同时连着时，只要有一个还开着遮罩，共享的屏幕模型就保持遮罩。
- **状态机**：`idle → starting → live → reconnecting → stopping → stopped`，失败从任意状态进入 `failed`，
  之后按 0.5/1/2/4/5 s 退避重启。页面重载不会重开投流：断开后保留 5 s 宽限期，宽限期内重新连上就继续出流。
- **背压**：单个 socket 的写队列超过 1 MB 就丢增量帧并请求 IDR（250 ms 内至多一次）；
  MJPEG 是整帧，直接丢。页面侧在 `decodeQueueSize > 4` 时同样丢增量帧。

```ts
import { createViewerSource, startViewerServer } from "uitest-sdk/viewer";

const source = createViewerSource(session.core, session.device, {
  stateDir: ".uitest-phone",
  cast: { frameRate: 30 },
});
const server = await startViewerServer({
  port: 0,                       // 0 → 系统分配
  privacy: true,
  graceMs: 5000,                 // 页面断开后保留投流的时间
  layoutMs: 250,                 // 两次读布局的最小间隔
  source,
});
console.log(server.port);
await server.close();
```

`ViewerServerOptions` 的全部字段：`port`、`host`（默认 `127.0.0.1`）、`privacy`（默认 `true`）、
`graceMs`、`layoutMs`、`watchdogMs`（按住不动多久自动抬起，默认 10 s）、`source`、
`features`（收窄页面提供的按钮）、`page`（换成自己的页面）、`input`（接管仲裁）与 `hooks`。

`createViewerSource` 是给自家会话用的现成 source：`layout: false` 只投屏不读布局，
`recordPath` 把录屏写到指定文件，`socketSuffix` 让多个页面各用一条投流 socket。
不想用现成的就自己实现 `ViewerSource`：`createCast()` 必填，`readScreen(redact)`、
`displaySize()`、`capture()`、`startRecording()` / `stopRecording()`、`openInput()` 都可选——
缺哪个，页面上对应的按钮就不出现。

遮罩开关通过 `ScreenBuilder.setRedact()` 在两次读之间切换，ref 不会因为开关而重编号。

**协议**（一个 WebSocket，`GET /live`）：

| 方向 | 类型 | 内容 |
|---|---|---|
| 服务端 → 页面 | text `hello` | `codec`、`description`（avcC，base64）、`width`、`height`、`state`、`privacy`、`canShot`、`canRecord`、`recording` |
| 服务端 → 页面 | text `nodes` | 节点表：`ref`、`role`、`label`、`masked`、矩形、中心、可点/可输入/可滚动 |
| 服务端 → 页面 | text `state` / `privacy` | 状态变化、遮罩开关的权威值 |
| 服务端 → 页面 | text `record` | `{recording: true, path}` 或 `{recording: false}`；出错时带 `error` |
| 服务端 → 页面 | text `saved` | `{path}`，或 `{error}`。截图与录屏完成都发这个 |
| 服务端 → 页面 | binary | `flag`(1 字节) + `pts`(4 字节大端) + AVCC（H.264）或整帧 JPEG（MJPEG） |
| 页面 → 服务端 | text | `{"type":"privacy","value":false}`、`{"type":"requestIDR"}`、`{"type":"shot"}`、`{"type":"record","action":"start"\|"stop"}` |

`canShot` / `canRecord` 由 `LiveSource` 提供了哪个回调决定：纯视频源（没有 `capture`）两个
都是 `false`，页面不显示按钮。`record` 是广播的——录屏属于设备，不属于点它的那个标签页。

`hello` 在页面连上时先发一次（此时还不知道编码格式），拿到 SPS/PPS 后再发一次带 `codec` 与 `description` 的版本。

**性能**（真机 BRA-AL00，1216×2688，`--fps 30`）：连接后首帧约 3.1 s（含投流 daemon 启动），
画面持续变化时页面绘制 **18.5 fps**，帧间隔中位 **33 ms**、p90 **55 ms**；服务端每帧平均 11.6 KB。
x86_64 的 MJPEG 路径在同一页面里 22 fps（400×800 合成源实测）。


```ts
const cast = await session.cast.open({
  frameRate: 60,       // 15 | 30 | 60 | 120，默认 30
  scale: 2,            // 1..5 整数缩小因子，默认 1
});
for await (const chunk of cast.stream()) {
  // H.264: { data, pts, flags, isKeyFrame }；MJPEG: { data, pts }
  if ("isKeyFrame" in chunk && chunk.isKeyFrame) { /* 从这里开始解码 */ }
}
await cast.requestIDRFrame(); // H.264 专用；MJPEG 上是 no-op
await cast.dispose();
```

`session.cast.open()` 与 `session.cast.record()` 用 `stateDir/cast.json` 里的默认值，再叠上本次参数。
要显式给全部字段（或自己管录制）时用 `uitest-sdk/cast` 的 `createCast(host, opts)`：
`host` 是任何有 `agent` 与 hdc 的对象，`Device` 就是一个。

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
| `transport` | `"grpc" \| "ws" \| "mjpeg"` | 按 ABI 选 | 显式选实现：`grpc` 用内置 6.8 扩展；`ws` 用 7.0 WebSocket 扩展（需 `wsExtension`）；`mjpeg` 强制 MJPEG（不能录制） |
| `wsExtension` | `string` | — | `ws` 必填：本地 7.0 `.so` 路径，按文件名推到 `/data/local/tmp` |
| `port` | `number` | `5000` | `ws` 专用：设备侧监听端口（`-p`），每个 daemon 一个端口 |
| `socketName` | `string` | 内部常量 | `grpc` 专用：覆盖抽象 socket 名，同机跑多个投流的方式 |
| `durationMs` | `number` | — | `record`：到点自动停止（等价于调 `dispose()`：关 muxer、拉回文件、杀 daemon）。不设则由调用方决定何时 `dispose()` |

### `CastClient`

| 成员 | 说明 |
|---|---|
| `castKind` | `"h264"` 或 `"mjpeg"`，**显式选择的结果** |
| `stream()` | `AsyncIterable<H264Chunk \| JpegFrame>` |
| `requestIDRFrame()` | 请求一个关键帧（H.264）；MJPEG 无操作 |
| `dispose()` | 结束投流；录制模式下关闭 muxer 并拉回文件 |

### 选择规则

`transport` 不写时按设备能力选；写了就是**显式选择**，不会在失败时换一种：

- `transport: "mjpeg"` → MJPEG（`castKind === "mjpeg"`，10–16 fps）。请求录制直接抛 `ExtensionMissingError`：MJPEG 后面没有 muxer。
- `transport: "ws"` → 7.0 WebSocket 扩展（`WsCastClient`）。没有 `wsExtension` 或文件不存在时抛 `ExtensionMissingError`；x86_64 没有 7.0 构建，同样抛错。**不会退回 gRPC。**
- 未指定时：`resolveCastExtension()` 非空 → 6.8 gRPC（`H264CastClient`）；为空（x86_64 模拟器）→ MJPEG。
- x86_64 上请求 `mode: "record"` 直接抛 `ExtensionMissingError`，不会返回一个「录不到东西」的客户端。

### 7.0 WebSocket 传输

```ts
const cast = await session.cast.open({
  transport: "ws",
  wsExtension: "./libscrcpy_server_unix_7.0-20260930.z.so",
  port: 5000,
});
```

SDK **不打包 7.0 扩展**（来源见 [09](09-capability-gaps-roadmap.md) §1.6），需要自己提供 `.so`。它按 basename 推到 `/data/local/tmp/<name>`，用 `--extension-name <name>` 加载，因此可以和内置 6.8 扩展**同时存在**、互不覆盖。

实测（真机 BRA-AL00 / uitest 7.0.0.1）：启动 0.9–1.3 s，首帧 82–137 ms，`requestIDR` 7–9 ms，`-frameRate 30` 下 20.8–23.2 fps。与 6.8 持平，优势是客户端零 gRPC 依赖。

**一个客户端独占一个 daemon**。实测 `stop` 是进程级的：任一客户端 stop，同 daemon 上另一路立刻停止出流；stop 后监听 socket 关闭，新客户端无法再连。所以并发投流靠多个 `port`（各自一个 daemon），而不是一个 daemon 多客户端。

### 录制

```ts
const rec = await session.cast.record({ frameRate: 30, out: "out.mp4" });
// 让画面动起来：静止画面不会产生新帧
await rec.stop(); // 关闭 muxer → 等待设备写完 → 拉回 out.mp4
```

设备侧文件路径写死在扩展里（`/data/local/tmp/mytest.mp4`），不可改。
编码器是**起停驱动**的：`record()` 返回时已经在录，`stop()` 后才完成。

两种传输都只录**画面变化**：静止画面下 6.8 和 7.0 都是 0 帧（8 s 实测 259 B 空文件）。
`dispose()` 会等设备侧文件大小稳定后再拉取 —— 7.0 的 muxer 在 `start` 时就建好 259 B 的头，样本到 `stop` 才落盘，看到非零就 pull 会拿到空壳。

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
import { parseBounds, type UiNode } from "uitest-sdk/drivers";

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

### 布局检查与节点高亮

`session.observe.inspect()` 读一次屏幕、截一帧，把每个元素的 `bounds` 画成方框并编号：

```ts
const r = await session.observe.inspect({ out: "layout.jpg", html: "layout.html" });
if (r.status === "settled") {
  console.log(r.nodes); // [{ index, ref, role, label, rect, state, masked }, ...]
}
```

- 图上的编号就是 `ref`，可以直接 `session.act.tap({ ref: 3 })`。
- 颜色按角色固定（`ROLE_COLORS`：`text` 蓝、`button` 绿、`input` 橙、`list` 紫……）。
- 被脱敏的元素**先涂灰再画框**，框线从不替代脱敏；节点表里 `masked: true`。
- `html` 面板是单文件：JPEG 以 base64 内嵌，没有外部资源；悬停表格行与画面上的框会互相高亮。
- 纯客户端渲染，建立在已有的 `captureLayout` 与 JPEG 截图上，不新增设备依赖。

不走 Session 时可以直接用组件：

```ts
import { Screenshot } from "uitest-sdk/drivers";
import { inspectScreen, renderPanel } from "uitest-sdk/viewer";

const shot = await Screenshot.from(jpeg, { display, rotation });
const inspection = inspectScreen(screen, shot); // { nodes, annotated, plain }
const html = renderPanel(screen, inspection);
```

`Screenshot.mark(boxes)` 是底层绘制原语：`{ rect, color, fill?, label? }`，输入是显示坐标，
内部按实际收到的帧缩放；`annotated` 就是「脱敏后的帧 + 所有框与编号」。

## 8. 完整 hypium API

设备侧的 hypium 驱动（DevEco Testing 6.1.0.210）公开 118 个方法：`OHOSDriver` 106 个，兼容层 12 个。
`dev.hypium` 把它们逐个映射成 TypeScript 方法，参数按设备实际行为定，不是照着文档猜的。

```ts
import { Device } from "uitest-sdk";
import { On, Gesture } from "uitest-sdk/drivers";

const dev = await Device.connect();
await dev.hypium.click(On.text("设置"));
await dev.hypium.waitForComponent(On.text("WLAN"), { timeoutMs: 3000 });
await dev.hypium.swipe("up", { distance: 40 });
```

### 位置参数：`Target`

凡是接受位置的参数，四种写法可以互换：

| 写法 | 例子 | 解析 |
|---|---|---|
| 绝对坐标 | `{ x: 608, y: 1344 }` | 原样使用 |
| 屏幕比例 | `[0.5, 0.5]` | 乘以显示尺寸 |
| 矩形 | `{ x, y, width, height }` | 取中心（`opts.offset` 可改） |
| 选择器 / 控件 | `On.text("保存")`、`ComponentHandle` | 设备侧取 bounds 再取中心 |

比例坐标相对整屏；给 `opts.area` 时相对那个区域。

### 通道选择

同样是「点一下」，设备上有四条路，SDK 按动作类型选最快的那条：

| 通道 | 方法 | 说明 |
|---|---|---|
| 单指 `touchDown/Move/Up` | `click`、`swipe`、`drag`、`fling`、`longClick`、`slide` | 实测最快，单次 8–30 ms |
| `PointerMatrix` | `pinchIn/Out`、`twoFingerSwipe`、`multiFingerTouch`、`injectGesture` | 多条同时轨迹，单指通道表达不了 |
| `Driver.mouse*` / `pen*` | `mouseClick`、`mouseScroll`、`penClick`、`penSwipe` 等 | 桌面形态、带按键与压感 |
| `Component.*` | `touch(On…)`、`switchComponentStatus`、`inputText(On…)` | 交给设备侧控件判定命中，不受遮挡影响 |

### 与 hypium 的差异

- `sn()` 返回设备序列号的 8 位哈希（如 `6c585f5b`），原始序列号不会出现在任何返回值、trace 或报告里。
- Toast 与 UI 事件五个方法抛 `UnsupportedError`：设备侧 `UIEventObserver` 会从 `start` 返回，但对
  `getRecentUiEvent` 永不回复（实测 30 秒超时）。
- `findImage` 只支持模板匹配（`mode: "template"`，JPEG 模板）；`sift` 需要主机侧 OpenCV，传了会明确报错。
- `setDisplayRotation` 只接受 `0/1/2/3`：设备参数校验器拒绝字符串。
- `ScreenLock.isLocked()` 读真实锁屏状态，而不是固定返回 `false`。
- `pushFile` 会把本地路径转成绝对路径再发：实测相对路径被 hdc 当成目录树，在设备上建出一个同名文件夹。

### 状态清单

`HYPIIUM_CATALOG` 导出每个方法对应的 hypium 原名与验收状态（`verified` / `device` / `host` /
`hardware` / `unsupported`）。单元测试核对它的长度与方法名，所以清单不会与驱动脱节。
全部 118 条、逐条示例与调用路径图见官网的 [完整 API](https://growvv.github.io/uitest-sdk/api.html) 页。

## 9. 工具类

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
| `H264CastClient` / `MjpegCastClient` | 低层客户端；正常用 `session.cast.open()` / `createCast()`，它们会自己管 daemon 与端口 |
| `Files` | 设备文件封装，`dev.files` 已是实例；路径按设备 shell 转义 |
| `CastConfig` / `castConfigPath(stateDir)` | 投流默认值的 JSON 持久化（`<state-dir>/cast.json`） |
| `FpsMeter` | 客户端帧率统计：`add()` / `stats()` / `reset()`，窗口默认 2000 ms |

### 文件、配置与帧率

```ts
// 设备文件：一条 shell 或一次 file send/recv
const entries = await dev.files.list("/data/local/tmp"); // [{ name, path, size, isDir, mode, mtime }]
await dev.files.mkdir("/data/local/tmp/demo dir", { parents: true });
await dev.files.push("./clip.mp4", "/data/local/tmp/demo dir/clip.mp4");
await dev.files.move("/data/local/tmp/demo dir/clip.mp4", "/data/local/tmp/demo dir/moved.mp4");
await dev.files.remove("/data/local/tmp/demo dir", { recursive: true });
const head = await dev.files.readText("/data/local/tmp/x.json", 4096); // 默认 1 MiB，上限 64 MiB

// 投流默认值的持久化：显式合并，不会偷偷改变一次投流
const cfg = await CastConfig.load(castConfigPath(stateDir));
await cfg.set({ scale: 2, frameRate: 30, bitRate: 8_000_000, transport: "ws" });
const cast = await createCast(dev, { ...cfg.toCastOptions("stream"), wsExtension: "./lib.so" });

// 任意帧流的客户端帧率
const meter = new FpsMeter({ windowMs: 2000 });
for await (const chunk of cast.stream()) {
  meter.add();
  const { fps, stalledMs } = meter.stats();
}
```

`Files.remove` 拒绝空路径与 `/`，其余路径由调用方负责。`CastConfig.load` 对损坏或手改坏的文件
是宽容的（忽略该键，不阻断运行），`CastConfig.set` 是严格的（非法值抛 `EBADARG`）。
`FpsMeter` 用帧间隔计算，至少两帧才报速率，所以刚开流时不会出现假低值。

## 10. 错误

所有错误继承 `UitestError`，带 `code` 与可选 `cause`。

| 类 | 典型 code | 触发条件 |
|---|---|---|
| `DeviceNotConnectedError` | `ENODEVICE` / `ENOHDC` / `EHDC` / `EDISPOSED` | 没有设备、找不到 hdc、hdc 命令失败、Device 已 dispose |
| `ExtensionMissingError` | `ENOEXT` / `ENOCAST` | 本地没有对应 ABI 的 `agent.so`；x86_64 上请求录制 |
| `DaemonStartError` | `ENODAEMON` / `EPORT` / `ENOSOCKET` / `ENORECORD` | daemon 拉不起来、端口耗尽、投流 socket 没出现、录制文件没出现 |
| `AgentProtocolError` | `EPROTO` / `ETIMEDOUT` / `EBADJSON` / `ENOWINDOW` / `ENOBOUNDS` / `EBADARG` | 设备返回异常、请求超时、输出不是 JSON、找不到窗口/边界、参数非法 |
| `AgentBusyError` | `EBUSY` | 设备全局锁被其它进程占着且重试耗尽；或该设备已有采集流（立即失败，不等待） |
| `AgentConnectionError` | `ECONN` | 连接不可用、请求超时后连接被丢弃、关闭后继续调用 |
| `DeviceStateError` | `ENODEVICE` / `EOFFLINE` / `EUNAUTHORIZED` | `DeviceNotConnectedError` 的子类：设备没插、离线、或没授权本机调试。带 `state`（`device_offline` / `device_needs_setup`），消息里给出下一步该做什么 |
| `AppNotFoundError` | `ENOAPP` / `EAMBIGUOUS` | 应用没装、按名字找不到、或名字匹配到多个 bundle（`EAMBIGUOUS` 会列出候选） |
| `LaunchError` | `ENOABILITY` / `ELAUNCH` | 应用没有入口 ability；或 `aa start` 失败（`aa` 可能退出码为 0 却在输出里报错） |
| `ElementNotFoundError` | `ENOTFOUND` | `require()` 的组件选择器没有匹配到任何节点，消息里带选择器 |
| `LeaseHeldError` | `ELEASE` | 设备租约在别的任务手里且对方还活着；或用 `--force` 之外的方式想抢 |
| `UnsupportedError` | `EUNSUPPORTED` | 方法在设备上不存在，或这台设备/ABI 不支持该能力；消息说明原因，不静默降级 |

`DeviceStateError.state` 与 CLI 的状态词同源（`device_offline` / `device_needs_setup`），
所以脚本里判断设备状态时不用解析英文消息。

## 11. 并发与生命周期

- **一条连接一个在途请求**：`SerialQueue` 串行化；断开后 `autoRestart` 会用新 socket 重连，**不重放**失败中的请求。
- **全局锁冲突**：只有 `Disallow concurrent use` 会退避重试（0.5 s 起，抖动后翻倍，最多 40 次）。
- **采集冲突**：设备同一时刻只允许一条采集流。`Capture already running` 立刻抛 `AgentBusyError`，
  不会等、不会抢占。同一进程里请把截图与投流串行起来，或者用 `socketName` 分开投流。
- **daemon 归属**：`pidof uitest` 会列出所有 uitest 进程，别人拉起的不归你杀。
  SDK 只认「本次连接前后新增的、且只有一个」的 pid；`ownDaemon: true` 时才会在 `dispose()` 杀掉它。
- **超时即断连**：请求超时后连接被丢弃（回复没有请求 id，迟到的回复会配错请求），下一次调用走重连。
- **进程退出前 `dispose()`**：撤销 fport；否则本地会留下隧道。

## 12. 示例

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
const cast = await session.cast.open({ frameRate: 30 });
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
const rec = await session.cast.record({ frameRate: 30, out: "demo.mp4" });
await new Promise((r) => setTimeout(r, 10_000));
await rec.stop();
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

## 13. 产品与命令行

本库不带可执行文件，也没有界面。想直接驱动手机的人用两个产品，它们只用本文档里的公开 API：

| 包 | 是什么 | 装法 |
|---|---|---|
| [`uitest-phone`](https://www.npmjs.com/package/uitest-phone) | 21 条命令的 CLI、stdio MCP server、Agent Skill；`hold` / `handoff` / `resume` / `approvals` | `npm i -g uitest-phone` |
| [`uitest-console`](https://www.npmjs.com/package/uitest-console) | 浏览器页面：镜像、节点表、接管、审批收件箱、Hold/Resume | `npm i -g uitest-console` |

```bash
npx uitest-phone doctor
npx uitest-phone observe --task "check WLAN"
npx uitest-phone approvals list
uitest-console
```

命令、状态码、审批流程与 Agent 接法写在各自的 README 里，不在这里重复：它们是产品的契约，
不是库的 API。想自己写一个这样的产品，用 `uitest-sdk/commands` 的 `COMMANDS` 与 `CommandRunner`
（命令行与 MCP 共用的同一份命令表），用 `uitest-sdk/govern` 的审批与租约，用
`uitest-sdk/viewer` 的页面。

## 14. 策略、审批与接管

策略在**碰设备之前**判定。`policy` 默认拦下四类人收不回来的动作（支付、金融、删除、发送），
凭据永久拦截；`commits`（确认 / 保存）不默认开启。

```ts
const session = await connect({ policy: { readOnly: false, confirm: ["deletes"], apps: ["com.demo"] } });
const pending = session.govern.approvals.pending();          // [{ id, command, rule, bundle, task, status, ... }]
session.govern.approvals.decide(pending[0].id, "allow", { scope: "once" });
```

| 规则 | 例子 | 默认 |
|---|---|---|
| `credentials` | 密码、password、OTP、PIN、验证码 | 永久拦截 |
| `payments` | 支付、付款、pay、checkout、transfer | 需要审批 |
| `finance` | 银行、钱包、bank、wallet、alipay | 需要审批 |
| `deletes` | 删除、delete、remove、清空 | 需要审批 |
| `sends` | 发送、send、post、提交消息 | 需要审批 |
| `commits` | 确认、保存、confirm、save | 不默认，`confirm: ["commits"]` 开启 |

### 审批是两方的事

被拦下的一步返回 `status: "approval_pending"` 和一个 `approvalId`。**只有人能写决定**：
`Approvals.decide()`（或产品的 `approvals` 命令、console 的收件箱）在
`<stateDir>/approvals/<tag>/` 里写一个 `.allow` / `.deny` 文件；请求本身是 `<id>.json`，
用完打上 `<id>.used`。`consume()` 返回 `approved` / `pending` / `denied` / `stale`。

- id 绑定命令与目标签名，一次性，默认 60 s 过期（`approvalTtlMs`）。
- 等待期间页面变了返回 `stale`，不会执行到别的东西上。
- 记住的范围是 `once` / `task` / `always`；`always` 跨任务，`resume` 只清 `task`。
- 记住的授权只跳过一次审批检查：凭据仍然永远拦截，`readOnly` 仍然拒绝改数据，`apps` 白名单外仍然被拦。
- Agent 拿到 id 也**不能自己批准**：决定文件由人这一侧的通道写，库里没有「agent 自动同意」的入口。

### 接管与交接

`govern.lease` 与 `uitest-sdk/govern` 的 `holdDevice` / `handoffDevice` / `resumeDevice`：

- `hold`：人此刻拿着手机。租约写成 `"held by a person"`，agent 的下一条动作返回 `lease_held`（退出码 2），
  不重试、不抢回；进程退出也不会让租约自己过期。
- `handoff`：agent 反向发起，遇到只有人能做的步骤（登录、验证码、解锁）时把手机交出去，
  `reason` 存进租约，之后每次 `lease_held` 都重复这个原因。
- `resume`：交还，只释放这两种租约，属于其它任务的租约不碰。

```ts
await session.govern.lease.hold();                  // 人接管
await session.govern.lease.resume();                // 交还
const info = session.govern.lease.info();           // { task, reason?, since } | null
```

设备侧的 UI 事件流**不能**用来判断「人在动手机」：`streamUiActions` 停止时会关闭采集会话、
能把 daemon 卡死，而且 agent 注入的合成触摸也会被当成手指。接管因此是人的明确声明。

### 跨进程状态

ref、审批、租约与 trace 都在 `--state-dir`（默认 `.uitest-phone/`）：

- ref 表 `<stateDir>/refs-<tag>.json`：`observe` 打印的 ref 在下一次读时仍指向同一元素。
- 审批 `<stateDir>/approvals/<tag>/`：请求、决定、已用标记各一个文件。
- 租约 `<stateDir>/leases/<tag>.lock`；设备序列号只以 8 位哈希（`tagOf`）出现。
- trace 一步一个文件；`readRecentTrace(stateDir, { limit })` 读回来，`report` 是产品在它之上的格式化。

## 15. 子路径一览

根入口只有 `connect`、`connectDevice`、`Session`、`Device`、`tagOf`、`VERSION` 和错误类。
其余按依赖面分组，import 一个子路径就等于声明用了那一层：

| 子路径 | 提供 |
|---|---|
| `uitest-sdk` | `connect` / `connectDevice` / `Session` / `Device` / `tagOf` / `VERSION` / 13 个错误类 |
| `uitest-sdk/commands` | `COMMANDS`、`CommandRunner`、`parseArgv`、`exitCodeForError`、`EXIT_CODE`、`doctor`、`renderDoctor`、`statusOf` / `actionText` / `isOk` |
| `uitest-sdk/cast` | `createCast`、`CastConfig`、`Recording`、`FpsMeter`、三种 `CastClient`、WebSocket 帧与 NAL 助手 |
| `uitest-sdk/viewer` | `startViewerServer`、`createViewerSource`、`renderPlayerPage`、`openInput`、`originAllowed`、`inspectScreen` / `renderPanel` |
| `uitest-sdk/govern` | `Policy`、`Approvals` / `Grants`、`Lease`、`holdDevice` / `handoffDevice` / `resumeDevice`、`TraceRecorder` / `readRecentTrace` |
| `uitest-sdk/drivers` | `Device`、`AgentClient`、`HypiumDriver`、`CliRunner`、`HdcRunner`、`Files`、`AppManager`、`On` / `Screenshot` / `Components` / `Gestures` / `ScreenBuilder` / `ScreenReader`、`parseBounds` / `cropRect`、`FrameDemux` / `SerialQueue` / `DevicePool` |

---

生成于 2026-11-18。行为与数字对应的源码版本：`0.10.0`。
