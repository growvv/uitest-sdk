# uitest-sdk

[![npm](https://img.shields.io/npm/v/uitest-sdk.svg)](https://www.npmjs.com/package/uitest-sdk)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[官网](https://growvv.github.io/uitest-sdk/) · [使用文档](https://growvv.github.io/uitest-sdk/docs.html) · [完整 API](https://growvv.github.io/uitest-sdk/api.html) · [更新日志](https://growvv.github.io/uitest-sdk/changelog.html) · [宣传视频](https://growvv.github.io/uitest-sdk/#video) · [GitHub](https://github.com/growvv/uitest-sdk) · MIT

把鸿蒙 `uitest` 的设备侧扩展（`agent.so` / `libscreen_casting.z.so`）封装成 TypeScript SDK：
一条长连接做 UI 自动化，一条 gRPC 通道做 H.264 投流与 MP4 录制。这是一个**库**——不装命令、
不起界面；要命令行和 Agent 接入用 [`uitest-phone`](https://www.npmjs.com/package/uitest-phone)，
要浏览器投屏用 [`uitest-console`](https://www.npmjs.com/package/uitest-console)。

```bash
npm install uitest-sdk
```

```ts
import { connect } from "uitest-sdk";

const session = await connect({ deviceId: "<your-device-id>" });
try {
  const screen = await session.observe.layout();        // 节点表 + display 尺寸
  const { width, height } = screen.display;
  await session.act.tap({ text: "WLAN" });              // ref / 文本 / 选择器 / On
  const shot = await session.observe.screenshot();      // 608×1344 JPEG
  await session.act.swipe({ from: { x: width / 2, y: height * 0.7 }, to: { x: width / 2, y: height * 0.3 } });
} finally {
  await session.close();
}
```

`connect()` 会按设备 ABI 推送对应的 `agent.so`、必要时拉起 daemon、建立 fport 隧道，
并做一次 `getDisplaySize()` 健康检查。任何业务失败直接抛 `UitestError` 子类，不做静默兜底。
返回的 `Session` 按用途分成 `observe` / `act` / `wait` / `cast` / `view` / `govern` 六个命名空间；
底层 `Device` 仍可经 `session.device` 拿到，高级接口走 `uitest-sdk/{commands,cast,viewer,govern,drivers}` 子路径。

可运行的 JavaScript 版本：[`examples/quickstart.mjs`](https://github.com/growvv/uitest-sdk/blob/master/examples/quickstart.mjs)（本仓库先 `npm run build`，
之后 `node examples/quickstart.mjs`）。完整 API 与示例见 [`docs/api.md`](https://github.com/growvv/uitest-sdk/blob/master/docs/api.md)。

## 能力与实测延迟（真机 BRA-AL00 / 1216×2688 / uitest 7.0.0.1）

| 能力 | API | 实测 |
|---|---|---|
| 屏幕尺寸 / 旋转 | `agent.getDisplaySize()` / `getDisplayRotation()` | 毫秒级 |
| 点击 | `agent.click(x, y)` | 21~50 ms |
| 滑动（三段式） | `agent.swipe(x1, y1, x2, y2, { durationMs })` | 386~640 ms |
| 原子触摸 | `agent.touchDown/Move/Up(x, y)` | 毫秒级 |
| 文本输入 | `agent.inputText(x, y, text)` | 730~1540 ms（hypium 侧） |
| 按键 | `agent.triggerKey(keyCode)` | 毫秒级 |
| UI 树 | `agent.captureLayout()` | ~180~430 节点 |
| 整屏截图 | `agent.captureScreen()` | **109~222 ms** |
| 窗口截图 | `agent.cropToWindow({ bundleName })` | 采集 + 裁剪 |
| MJPEG 流 | `agent.streamScreen({ scale })` | 10~16 fps（需画面变化） |
| H.264 投流 | `session.cast.open({ ... })` | 15~89 fps（随 `frameRate`） |
| MP4 录制 | `session.cast.record({ out })` | 见下 |
| 窗口级 UI 树 | `session.device.cli.dumpLayout({ windowId })` | 一次 shell + pull |
| 设备文件 | `session.device.files.list/stat/mkdir/remove/move/push/pull` | 一条 shell 或一次 `file send/recv` |
| 帧率统计 | `new FpsMeter().add()/stats()`（`uitest-sdk/cast`） | 纯客户端，按帧间隔计算 |

### 和 hdc CLI 的对比

同一台真机、同一个脚本（`scripts/bench-compare.ts`）测出的对比。CLI 数字包含 hdc 进程启动、
shell 往返与 uitest 启动——也就是手敲命令时真正付出的时间。

| 操作 | 本 SDK | hdc CLI | CLI / SDK |
|---|---|---|---|
| 点击 | 7~36 ms | 390~561 ms | **44.9~59.0×** |
| 滑动（300 ms 手势 / 600 速度） | 389~499 ms | 2630~2808 ms | **6.1~6.9×** |
| 整屏截图（含回传） | 109~294 ms | 741~988 ms | **3.8~4.5×** |

其他方式：`snapshot_display` + 回传中位 651~684 ms（约 158~194 KB）；`uitest screenCap` + 回传
中位 813~828 ms（1216×2688 PNG，约 644~701 KB）；本 SDK 的截图是 608×1344 JPEG，直接拿到字节。
对比 `snapshot_display` 的截图，SDK 快 **3.2~3.8×**；对比 `dumpLayout + pull` 的 UI 树，
`captureLayout` 快 **2.6~2.7×**；单次动作两边走同一个 agent RPC，时延持平。
连续取帧没有 CLI 等价物：`screenCap` 轮询约 1.4 fps，而 MJPEG 流 10~16 fps、H.264 投流 15~89 fps。
完整原始样本见 [`docs/benchmarks.md`](https://github.com/growvv/uitest-sdk/blob/master/docs/benchmarks.md)。

**投流路径是显式选择的**：有 `libscreen_casting` 构建（arm64）走 H.264，没有（x86_64 模拟器）
走 MJPEG。用 `cast.castKind`（`"h264"` / `"mjpeg"`）读出实际路径 —— 这是同一能力的两种实现，
不是失败降级。

H.264 有两条传输可选：默认的 6.8 gRPC（内置），或 7.0 WebSocket：

```ts
const cast = await session.cast.open({
  transport: "ws",                                    // 默认 "grpc"
  wsExtension: "./libscrcpy_server_unix_7.0-20260930.z.so",
  port: 5000,
});
```

7.0 扩展不随包分发，需要自己提供；它按文件名推到 `/data/local/tmp`，与内置的 6.8 扩展
同时存在、互不覆盖。帧率两者持平（实测 20.8~23.2 fps），ws 的收益是客户端不再需要 gRPC 运行时。
一个客户端独占一个 daemon —— `stop` 是进程级的，并发投流靠多个 `port`。

投流默认值可以存成 JSON（`CastConfig`），但合并是显式的：`session.cast.open({ ...cfg.get() })`，
配置文件不会在背后改变一次 cast。帧率统计用 `FpsMeter`（`uitest-sdk/cast`）：每来一帧 `add()`，
`stats()` 给出 `fps` / `frames` / `spanMs` / `stalledMs`，与投流实现无关，MJPEG 和 H.264 都能用。
需要显式指定传输或自己管录制时，用 `uitest-sdk/cast` 的 `createCast` / `Recording`。

### 投屏：给人在浏览器里看

```ts
const view = await session.view.open();            // http://127.0.0.1:7000/
const view2 = await session.view.open({ privacy: false, layout: false, open: false });
await view.close();                                 // 关页面，不关会话
```

一个页面里同时有画面和布局：右边是当前屏的节点表，点节点（或点画面上的框）就复制它的 ref、角色、
标签和中心坐标；画面上的编号就是 `observe` / `tap --ref` 用的那套 ref。隐私开关默认打开，密码框与
验证码在节点表和画面上都被遮住；关掉后服务端用 `redact: false` 重新读布局。多个页面同时连着时，
只要有一个还开着遮罩，共享的屏幕模型就保持遮罩。

**接管**：页面默认只读，点「接管」之后画布就是设备——点击、长按、拖动、滚动、双指缩放、
键盘输入、返回/Home 都直接落在手机上。输入走**第二条通道**（独立的 `hdc fport` 与 agent 连接），
和读布局的那条互不排队：长按 2 s 不会让节点表卡住 2 s，键盘输入也不会阻塞读屏。同一次操作
只发一份 `down/move/up`；点击注入的写通道往返 p50 3.9 ms、p95 18.9 ms
（点击场景），整轮混合输入 p50 275.4 ms（含 456 ms 的滚轮调用与文本落字）。
「接管」是独占的：另一个页面再点会被明确拒绝（`busy by c1`），不会出现两边同时点的画面；
关闭控制页、或输入出错就回到只读。按住不放但 10 s 没有移动时，服务器会替你抬起指针，
**控制权保留**——人可能只是松手没发出去，不该因此被踢出接管。失败一律回只读，不会卡在「点了没反应」。

键盘有两条规则：普通输入在停顿 300 ms 后整段落设备；拼音输入法组合期间**不上屏**，
`compositionend` 时整词落设备（拼音不会先变成英文字母再被替换）。系统键里 `back` 只弹一层页面、
不关应用；`home` 回桌面。双指缩放按两段注入（首段只记基线），在图片查看器里放大是真实渲染的。

浏览器里看手机是一个**产品**：[`uitest-console`](https://www.npmjs.com/package/uitest-console)
在同一页面上加接管按钮、审批收件箱与 Hold/Resume。这个库只提供 `view.open()` 和可复用的
viewer（`uitest-sdk/viewer`），页面本身、来源校验与解码都在里面；验收报告见
[`docs/acceptance/live/report.md`](docs/acceptance/live/report.md)。

解码全在浏览器里：H.264 走 WebCodecs `VideoDecoder`（服务端把 Annex-B 转 AVCC 并生成 `avcC`），
MJPEG（x86_64）走 `createImageBitmap`；没有 MSE、没有 fMP4 重封装。状态机是
`idle → starting → live → reconnecting → stopping → stopped`，失败后退避重启；页面重载有 5 s 宽限期，
不重开投流。背压按 socket 写队列（1 MB 水位）丢增量帧并请求 IDR。

真机 1216×2688 / 30 fps：首帧约 3.1 s（含 daemon 启动），画面持续变化时页面绘制 18.5 fps，
帧间隔中位 33 ms、p90 55 ms，每帧平均 11.6 KB。要自己起页面而不走 `session.view`，用
`uitest-sdk/viewer` 的 `startViewerServer` / `createViewerSource`，见
[`docs/api.md`](https://github.com/growvv/uitest-sdk/blob/master/docs/api.md)。

### 录制

```ts
const rec = await session.cast.record({ frameRate: 30, out: "out.mp4" });
// ...让画面动起来...
await rec.stop();   // 关闭 muxer，拉回 out.mp4
```

录制是**起停驱动**的：`cast.record` 返回时编码器已经在写，`stop()` 关闭 muxer 并把
设备侧 `/data/local/tmp/mytest.mp4`（路径写死在扩展里，不可改）拉回 `out`。
静止画面不产生样本 —— 录制期间要让 UI 动。更底层的开关（显式 `transport`、`socketName`、
`outputPath`）在 `uitest-sdk/cast` 的 `createCast` / `Recording`。

## 产品：库之上还有两个包

这个仓库按「一个库 + 两个产品」组织。库不装命令、不起界面，产品各自独立发版：

| 包 | 是什么 | 装法 |
|---|---|---|
| [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk) | 本库：连接、观察、动作、投屏、viewer、治理 | `npm install uitest-sdk` |
| [`uitest-phone`](https://www.npmjs.com/package/uitest-phone) | 无界面的设备 Agent：21 条命令的 CLI、MCP server、Agent Skill | `npm i -g uitest-phone` |
| [`uitest-console`](https://www.npmjs.com/package/uitest-console) | 人的界面：浏览器投屏、接管、审批收件箱 | `npm i -g uitest-console` |

```bash
npx uitest-phone doctor             # 探测设备与能力
npx uitest-phone observe --task "check WLAN"
uitest-console                      # 浏览器里看手机、接管、批准
```

`uitest-phone` 的 21 条命令、MCP 工具与 Skill 见它自己的 README；`uitest-console` 的
接管与收件箱见它的 README。两者都只通过本库的公开 API 工作——这里没有给产品留的后门。

## 完整 hypium API（`dev.hypium`）

上面那张表是 SDK 自己抽象出来的能力。如果要从鸿蒙 `uitest` 的角度看，`dev.hypium` 把
hypium 6.1.0.210 的 **118 个方法**（`OHOSDriver` 106 + 兼容接口 12）原样铺平，方法名改成
TypeScript 驼峰，参数和返回值都做了类型：

```ts
import { Device } from "uitest-sdk";
import { On } from "uitest-sdk/drivers";

const dev = await Device.connect();
const h = dev.hypium;

await h.click([540, 1200]);                    // 坐标：点 / 比例对 / Rect / On / 组件
await h.swipe("up", { durationMs: 300 });      // 或 h.drag([540, 2000], [540, 600])
await h.inputText(On.id("search"), "WLAN");    // On 选择器直接当 Target
await h.setDisplayRotation(1);                 // 只收 0|1|2|3，设备拒绝字符串
await h.waitForComponent(On.text("WLAN"), { timeoutMs: 5000 });
```

注入通道有四种，按目标选：单指手势（`Gestures`）、多指（`PointerMatrix`）、
鼠标/笔（Driver RPC）、组件自带动作（`Component.click`）。`HYPIIUM_CATALOG` 导出全部
118 条映射（hypium 原名 → TS 名 → 分类 → 状态），单元测试会校验它和门面一一对应，不会漂移。

每条方法都带一个诚实的实测状态，真机（BRA-AL00 / uitest 7.0.0.1）逐条跑过：

| 状态 | 数量 | 含义 |
|---|---|---|
| `verified` | 106 | 真机跑通 |
| `device` | 4 | 已实现但没做成功验收（`installApp` / `uninstallApp` / `clearAppData` / `takeScreenshot`） |
| `hardware` | 3 | 需要手写笔 / 表冠 / 触控板，没有硬件时报明确错误 |
| `unsupported` | 5 | Toast 与 UI 事件：`UIEventObserver` 在裸 RPC 通道上从不回包 |

逐条说明、示例和图示见官网的独立页面
[**完整 hypium API**](https://growvv.github.io/uitest-sdk/api.html)（由 `scripts/gen-api-page.mjs`
从 `src/hypium/catalog.ts` 生成，`node scripts/check-site.mjs` 会校验 118 条都在页面上）。
Markdown 版本在 [`docs/api.md`](https://github.com/growvv/uitest-sdk/blob/master/docs/api.md) 第 8 节。

## 多实例

多个进程可以同时连同一台设备：

- `connect()` 探测 8012 已监听就**复用**现有 daemon，绝不无条件 `kill -9`。
- 每个实例用自己的本地端口，冲突时自动向上找空闲端口。
- 设备侧是全局锁，SDK 内部串行化请求，并对 `Disallow concurrent use` 做指数退避
  （0.5 s 起、翻倍、20 s 封顶、±50% 抖动、最多 40 次）。实测两进程各并发 40 次全部成功。
- **同一时刻只能有一个 capture 会话**：另一个进程会收到 `AgentBusyError`。
- `dispose()` 默认不杀 daemon。要连带杀掉自己起的那个，用 `{ ownDaemon: true }`。
- 掉线后下一次调用自动重连（`{ autoRestart: true }`）；**失败的请求不重放** —— 写操作重放不安全。
- 客户端被强杀后守护进程会留死连接锁住设备；`connect()` 会检测并只重启 `agent.so` 那个守护进程
  （见「已知限制」）。

## 已知限制

- **窗口级截图不存在**。所有截图路径（agent / casting / `snapshot_display` / `uitest screenCap`）
  都只出整屏；`cropToWindow()` 是「整屏 + 按节点 bounds 裁剪」的近似。
- **`captureScreen()` 的 `scale` 参数无效**（agent 1.1.10 实测）：1、2、5 都返回 608×1344。
- **静止画面只出 1 帧**。采集是脏区驱动的，这不是卡死；`stopStream()` 随时能结束。
- **`stopCaptureUiAction` 会关闭会话**，同一连接上的后续调用会失败。UI 事件只上报真实用户输入，
  通过 agent 注入的合成触摸不会回传。
- **`Component.scrollSearch` 不能用**：目标不存在时设备侧一直阻塞到请求超时（30 s），
  之后全局锁仍被占住，后续所有命令都报 `Disallow concurrent use`。CLI 的 `scroll-until`
  改为逐屏翻页，未命中约 4 s 且设备保持可用。
- **`UIEventObserver.once` 尚不可用**：参数校验要求 `ComponentEventOptions`，传入合法形状后
  守护进程直接断连（实测 `agent connection closed`）。Toast/UI 事件暂不提供。
- **被 `kill -9` 的客户端会把设备锁住**：守护进程留下 `CLOSE_WAIT` 连接（`/proc/net/tcp` 状态 `08`），
  锁不会随超时释放。`connect()` 检测到「有死连接且没有活连接」时，按 `cmdline` 精确定位
  `--extension-name agent.so` 的进程并重启它（不碰 casting daemon）；识别不到 pid 时报错并给出命令，
  不会盲杀。
- **x86_64 没有 casting 构建**（华为不公开发布，也无公开源码），模拟器上只有 MJPEG。
- `perfmonitor.so`（HTTP 9999）与 AAMS 不在本 SDK 范围内。

## 扩展来源与覆盖

`assets/` 里打包了实测可用的版本，清单见 `assets/manifest.json`：

| ABI | 文件 | 版本 |
|---|---|---|
| arm64 | `agent.so` | 1.1.10 |
| arm64 | `libscreen_casting.z.so` | 6.8-20260801 |
| x86_64 | `agent.so` | 1.1.9 |

这三个文件是华为 DevEco Studio / DevEco Testing 生成并签名的设备侧扩展，不是本仓库的源码，
MIT 许可不覆盖它们。版本、大小、md5 与来源逐条记在 [`NOTICE`](https://github.com/growvv/uitest-sdk/blob/master/NOTICE)；
不想要这份再分发，删掉 `assets/` 下这三个文件，用自己的副本即可（见下）。

用自己的副本：

```ts
const dev = await Device.connect({
  extensionDir: "/path/to/dir",   // 目录下需有 arm64/ 与 x86_64/
  deviceId: "<your-device-id>",
});
```

扩展必须**华为签名**才能在真机加载（XPM 校验拒绝未签名 `.so`，见 `docs/06-signing-xpm.md`）。

## 验收

```bash
npm test                                  # 单元测试（不碰设备）
npm run test:device                       # 集成测试，需连接设备
npm run acceptance:handoff                # 真机验收 Agent 接管/交接（需先 build）
UITEST_TARGET=127.0.0.1:5555 npm run test:device   # 指定目标
npx tsx scripts/acceptance.ts --targets <id>[,<id>...]
```

`acceptance.ts` 跑之前把手机**解锁并让屏幕常亮**（`power-shell timeout -o 3600000`）。
它中途会连续推流十几分钟，屏幕自动锁上后 `streamScreen` 收不到帧、会一直等下去——实测卡在
`cropToWindow` 之后不动，`hidumper -s 3308 -a -a` 显示 `State=0`。这不是超时 bug，是没画面可推。

它会把每个能力的截图写进 `docs/acceptance/screenshots/`，这些图是要公开发布的，所以停在
**一个中性的公开页面**（设置首页、知乎热榜这类）。脚本自己在截图前会检查屏幕是否锁着并尝试
解锁，解不开（有 PIN）就中止而不是把通知栏拍下来；但页面上显示什么它管不了，提交前逐张看过。

最新一次真机验收：**16/16 PASS**（BRA-AL00，API 26，2026-11-17），报告在
[`docs/acceptance/report.md`](https://github.com/growvv/uitest-sdk/blob/master/docs/acceptance/report.md)，
含每个能力的截图、日志与可独立运行的最小复现脚本。报告覆盖的是投流、录制、布局与输入这些
原有能力；0.7.x 新增的 `inspect` / `live` / `dev.files` 不在其中，它们的实测记录在
[`docs/13-stage-log.md`](https://github.com/growvv/uitest-sdk/blob/master/docs/13-stage-log.md)。
报告里的设备 ID 是序列号的 8 位哈希，与 trace、lease 文件里的标签同源。

## 文档

调研与设计在 `docs/`：

| 文档 | 内容 |
|---|---|
| [api](https://github.com/growvv/uitest-sdk/blob/master/docs/api.md) | **完整 API 文档**：Device / AgentClient / 投流录制 / `dev.hypium` 118 个方法 / 错误码 / 并发与生命周期 |
| [benchmarks](https://github.com/growvv/uitest-sdk/blob/master/docs/benchmarks.md) | 与 hdc CLI、`snapshot_display` 的可复现实测对比 |
| [01](https://github.com/growvv/uitest-sdk/blob/master/docs/01-extension-abi.md) | uitest 扩展 ABI 与加载器 |
| [02](https://github.com/growvv/uitest-sdk/blob/master/docs/02-agent-so.md) | agent.so 的完整 RPC 方法表 |
| [03](https://github.com/growvv/uitest-sdk/blob/master/docs/03-libscreen-casting.md) | 6.8 gRPC 投流协议与四个坑 |
| [04](https://github.com/growvv/uitest-sdk/blob/master/docs/04-perfmonitor.md) | perfmonitor.so HTTP 服务 |
| [06](https://github.com/growvv/uitest-sdk/blob/master/docs/06-signing-xpm.md) | XPM 校验与签名机制 |
| [09](https://github.com/growvv/uitest-sdk/blob/master/docs/09-capability-gaps-roadmap.md) | 版本矩阵、7.0 来源、能力路线图 |
| [11](https://github.com/growvv/uitest-sdk/blob/master/docs/11-deveco-capability-inventory.md) | 118 个 hypium 方法与覆盖规划 |
| [12](https://github.com/growvv/uitest-sdk/blob/master/docs/12-findings-classified.md) | 结论分类汇总 |
| [13](https://github.com/growvv/uitest-sdk/blob/master/docs/13-stage-log.md) | 阶段记录：0.3.0 → 0.4.0 的交付、发布与架构实测 |
| [设计](https://github.com/growvv/uitest-sdk/blob/master/docs/superpowers/specs/2026-11-15-uitest-sdk-design.md) | SDK 设计文档 |
| [SECURITY](https://github.com/growvv/uitest-sdk/blob/master/SECURITY.md) | 安全说明：`live` 暴露什么、Origin 校验挡住什么、哪些不在防护范围内 |
