# uitest-sdk

[官网](https://growvv.github.io/uitest-sdk/) · [宣传视频](https://growvv.github.io/uitest-sdk/#video) · [GitHub](https://github.com/growvv/uitest-sdk) · MIT

把鸿蒙 `uitest` 的设备侧扩展（`agent.so` / `libscreen_casting.z.so`）封装成 TypeScript SDK：
一条长连接做 UI 自动化，一条 gRPC 通道做 H.264 投流与 MP4 录制。

```bash
npm install uitest-sdk
```

```ts
import { Device } from "uitest-sdk";

const dev = await Device.connect({ deviceId: "<your-device-id>" });
try {
  const { width, height } = await dev.agent.getDisplaySize();
  await dev.agent.click(width / 2, height / 2);
  const jpeg = await dev.agent.captureScreen();   // ~110 ms
  await dev.agent.swipe(width / 2, height * 0.7, width / 2, height * 0.3);
} finally {
  await dev.dispose();
}
```

`Device.connect()` 会按设备 ABI 推送对应的 `agent.so`、必要时拉起 daemon、建立 fport 隧道，
并做一次 `getDisplaySize()` 健康检查。任何业务失败直接抛 `UitestError` 子类，不做静默兜底。

## 能力与实测延迟（真机 BRA-AL00 / 1216×2688 / uitest 7.0.0.1）

| 能力 | API | 实测 |
|---|---|---|
| 屏幕尺寸 / 旋转 | `agent.getDisplaySize()` / `getDisplayRotation()` | 毫秒级 |
| 点击 | `agent.click(x, y)` | 21~50 ms |
| 滑动（三段式） | `agent.swipe(x1, y1, x2, y2, { durationMs })` | 386~640 ms |
| 原子触摸 | `agent.touchDown/Move/Up(x, y)` | 毫秒级 |
| 文本输入 | `agent.inputText(x, y, text)` | 730~1540 ms（hypium 侧） |
| 按键 | `agent.triggerKey(keyCode)` | 毫秒级 |
| UI 树 | `agent.captureLayout()` | ~180~250 节点 |
| 整屏截图 | `agent.captureScreen()` | **107~193 ms** |
| 窗口截图 | `agent.cropToWindow({ bundleName })` | 采集 + 裁剪 |
| MJPEG 流 | `agent.streamScreen({ scale })` | 10~16 fps（需画面变化） |
| H.264 投流 | `dev.createCast({ mode: "stream" })` | 15~89 fps（随 `frameRate`） |
| MP4 录制 | `dev.createCast({ mode: "record", outputPath })` | 见下 |
| 窗口级 UI 树 | `dev.cli.dumpLayout({ windowId })` | 一次 shell + pull |

**投流路径是显式选择的**：有 `libscreen_casting` 构建（arm64）走 H.264，没有（x86_64 模拟器）
走 MJPEG。用 `cast.castKind`（`"h264"` / `"mjpeg"`）读出实际路径 —— 这是同一能力的两种实现，
不是失败降级。

### 录制

```ts
const cast = await dev.createCast({ mode: "record", frameRate: 30, outputPath: "out.mp4" });
// ...让画面动起来...
await cast.dispose();   // 关闭 muxer，拉回 out.mp4
```

录制是**起停驱动**的：`createCast` 返回时编码器已经在写，`dispose()` 关闭 muxer 并把
设备侧 `/data/local/tmp/mytest.mp4`（路径写死在扩展里，不可改）拉回 `outputPath`。
静止画面不产生样本 —— 录制期间要让 UI 动。

## 多实例

多个进程可以同时连同一台设备：

- `connect()` 探测 8012 已监听就**复用**现有 daemon，绝不无条件 `kill -9`。
- 每个实例用自己的本地端口，冲突时自动向上找空闲端口。
- 设备侧是全局锁，SDK 内部串行化请求，并对 `Disallow concurrent use` 做指数退避
  （0.5 ms 起、翻倍、20 ms 封顶、±50% 抖动、最多 40 次）。实测两进程各并发 40 次全部成功。
- **同一时刻只能有一个 capture 会话**：另一个进程会收到 `AgentBusyError`。
- `dispose()` 默认不杀 daemon。要连带杀掉自己起的那个，用 `{ ownDaemon: true }`。
- 掉线后下一次调用自动重连（`{ autoRestart: true }`）；**失败的请求不重放** —— 写操作重放不安全。

## 已知限制

- **窗口级截图不存在**。所有截图路径（agent / casting / `snapshot_display` / `uitest screenCap`）
  都只出整屏；`cropToWindow()` 是「整屏 + 按节点 bounds 裁剪」的近似。
- **`captureScreen()` 的 `scale` 参数无效**（agent 1.1.10 实测）：1、2、5 都返回 608×1344。
- **静止画面只出 1 帧**。采集是脏区驱动的，这不是卡死；`stopStream()` 随时能结束。
- **`stopCaptureUiAction` 会关闭会话**，同一连接上的后续调用会失败。UI 事件只上报真实用户输入，
  通过 agent 注入的合成触摸不会回传。
- **x86_64 没有 casting 构建**（华为不公开发布，也无公开源码），模拟器上只有 MJPEG。
- `perfmonitor.so`（HTTP 9999）与 AAMS 不在本 SDK 范围内。

## 扩展来源与覆盖

`assets/` 里打包了实测可用的版本，清单见 `assets/manifest.json`：

| ABI | 文件 | 版本 |
|---|---|---|
| arm64 | `agent.so` | 1.1.10 |
| arm64 | `libscreen_casting.z.so` | 6.8-20260801 |
| x86_64 | `agent.so` | 1.1.9 |

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
UITEST_TARGET=127.0.0.1:5555 npm run test:device   # 指定目标
npx tsx scripts/acceptance.ts --targets <id>[,<id>...]
```

最新一次真机验收：**16/16 PASS**，报告在 [`docs/acceptance/report.md`](docs/acceptance/report.md)，
含每个能力的截图、日志与可独立运行的最小复现脚本。

## 文档

调研与设计在 `docs/`：

| 文档 | 内容 |
|---|---|
| [01](docs/01-extension-abi.md) | uitest 扩展 ABI 与加载器 |
| [02](docs/02-agent-so.md) | agent.so 的完整 RPC 方法表 |
| [03](docs/03-libscreen-casting.md) | 6.8 gRPC 投流协议与四个坑 |
| [04](docs/04-perfmonitor.md) | perfmonitor.so HTTP 服务 |
| [06](docs/06-signing-xpm.md) | XPM 校验与签名机制 |
| [09](docs/09-capability-gaps-roadmap.md) | 版本矩阵、7.0 来源、能力路线图 |
| [11](docs/11-deveco-capability-inventory.md) | 118 个 hypium 方法与覆盖规划 |
| [12](docs/12-findings-classified.md) | 结论分类汇总 |
| [设计](docs/superpowers/specs/2026-11-15-uitest-sdk-design.md) | SDK 设计文档 |
