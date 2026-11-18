# uitest-mirror 设计（产品 B）

**日期**：2026-11-18
**状态**：已确认，待实现
**上游**：`docs/superpowers/specs/2026-11-18-core-products-design.md` §6、§7

## 1. 目标

在 `uitest-sdk` 仓库里加第四个包 `uitest-mirror@0.1.0`——鸿蒙版 scrcpy。一条命令打开设备窗口，键鼠直接操作，可录制，可脚本化；独立 semver、独立发版、独立验收报告（带截图）上官网。

**成功标准**：

- `npm i -g uitest-mirror && uitest-mirror` 打开一个无地址栏的设备窗口，点击/拖拽/滚动/键盘落到真机
- 与 `uitest-phone` 的租约互斥：设备被 agent 持有时打印持有者 8 位标签并退出，不静默接管
- 有 9 条验收用例、每台设备一张截图，报告进 `docs/acceptance/mirror-0.1.0/` 并生成官网页
- core 只加 API、不破坏既有产品；四个包同一次发版

## 2. 已确认的决策

1. **v0.1.0 完整对标 spec §6.1**，包括 `--max-size` 和 `--stay-awake`。这两个能力 core 现在没有，需要补进 core 并单独发 core 版本。
2. **窗口逻辑提升到 core 的 viewer 子路径**。`--app` 无边框窗口是 viewer 的能力，不是 console 的产品 UX；console 删掉自己那份，改用 core 的。
3. **CLI 用 scrcpy 风格命名**：`--serial` / `--max-fps` / `--max-size` / `--bit-rate` / `--no-control` / `--stay-awake` / `--window-title`。内部映射到 core 的 `deviceId` / `frameRate` / `scale`。
4. **mirror 不复用 `parseArgv`**，自己解析。`parseArgv` 会把 `--device` 当全局 flag 静默吞掉，导致过「两个设备指向错手机」的缺陷。mirror 只认 `--serial`，未知 flag 一律报错。
5. **mirror 持租约**（`lease: true`）。人正在驱动设备，与 agent 的租约互斥。
6. **不静默回退传输**。`--transport ws` 没有 7.0 扩展就报错退出。

## 3. 包与依赖

```
uitest-sdk 0.11.0
   ├── uitest-phone   0.10.2
   ├── uitest-console 0.1.2
   └── uitest-mirror  0.1.0   ← 新包
```

- 四个包都发版：core 有新增，console 删了自己的窗口实现，mirror 是新的。phone 没有源码改动，但依赖范围必须从 `~0.10.1` 提到 `~0.11.0`——npm workspaces 在范围与工作区版本不符时会去 registry 找不存在的版本。
- 允许的边只有 `product → uitest-sdk`。`scripts/check-layers.mjs` 的 `PRODUCTS` 和 `scripts/gen-acceptance-pages.mjs` 的 `PRODUCT_NAMES` 已经写了 `uitest-mirror`，基础设施零改动。

## 4. core 的四处新增

### 4.1 `openAppWindow`（`uitest-sdk/viewer`）

从 `packages/console/src/window.ts` 提升，保留 `appWindowCommand` 与 `openWindow` 的名字和签名，新增可选的 `size`：

```ts
export type Browser = "edge" | "chrome";
export interface WindowCommand { command: string; args: string[] }

export function appWindowCommand(
  browser: Browser,
  url: string,
  platform?: NodeJS.Platform,
  size?: string,               // "1100,900"
): WindowCommand;

export interface OpenWindowOptions {
  browser?: Browser;
  platform?: NodeJS.Platform;
  size?: string;
  spawn?: (command: string, args: string[]) => unknown;
  print?: (line: string) => void;
}
export function openWindow(url: string, opts?: OpenWindowOptions): { opened: boolean; command?: string };
```

console 删除 `src/window.ts` 与 `test/unit/window.test.ts`，改从 `uitest-sdk/viewer` 导入；对应测试搬进 core 的 `test/unit/window.test.ts`，并新增一条 `size` 用例。

### 4.2 `recents` 键

> **验收实测修正（0.1.0）：本节原方案不可行。** 原稿写的是 `KEY_CODES` 与 `KEYS` 各加 `recents: 187`，并声称它来自 `oh_key_code.h` 的 `KEYCODE_APP_SWITCH`。真机上 187（AOSP 的 `APP_SWITCH`）无任何反应，`oh_key_code.h` 里也没有 `APP_SWITCH`；`KEYCODE_VIRTUAL_MULTITASK`（2210）和 `KEYCODE_TASKMANAGER`（2717）同样无反应。HarmonyOS 的最近任务不是按键，而是**从底边向上滑并按住**：实测 3.5 s 停留 4/4 打开最近任务，2 s 则每次都回桌面。
>
> 落地方式：`LiveInput.key("recents")` 发送这条手势（`RECENTS_HOLD_MS = 3500`，14 步）；`selector.ts` 的 `KEYS` **不**加 `recents`，`key recents` 因此会报未知键，而不是静默什么都不做。播放器的第四个按钮保留，消息仍是 `{ action: "key", key: "recents" }`。
>
> 原稿的「设备不响应就从 help 移除」因此没有触发——设备响应的是手势，不是按键。

### 4.3 `Session.keepAwake(seconds?)`

```ts
keepAwake(seconds?: number): Promise<{ restore(): Promise<void> }>;
```

包住已有的 `device.hypium.setSleepTime(seconds)` / `restoreSleepTime()`（`power-shell timeout -o <ms>` / `-r`）。默认 3600 秒。`restore()` 幂等。进程被强杀时 `-o` 会留在设备上，README 写明用 `power-shell timeout -r` 复位。

### 4.4 `CastOptions.maxSize`

```ts
/** 最长边上限（像素）。按传输解析成各自的 scale；与 scale 同给即 EBADARG。 */
maxSize?: number;
```

新增并导出：

```ts
export function resolveCastScale(
  transport: "grpc" | "ws" | "mjpeg",
  longestEdge: number,
  opts: { scale?: number; maxSize?: number },
): number;
```

规则（两种传输的 scale 语义不同，必须分开算）：

| 传输 | 语义 | 解析 |
|---|---|---|
| grpc / ws | 整数除数，扩展只收 1..5 | `ceil(longest / maxSize)`，clamp 1..5 |
| mjpeg | 0..1 的小数 | `maxSize / longest`，clamp 0.05..1，保留两位 |

- 需要的除数 > 5 → `EBADARG`，消息给出该设备能达到的最小最长边（`ceil(longest/5)`）
- `scale` 与 `maxSize` 同时给 → `EBADARG`，不猜谁优先
- `createCast` 在构造客户端前调用它；解析需要一次 `getDisplaySize`（实测 7 ms）

## 5. uitest-mirror

### 5.1 CLI

```
uitest-mirror [--serial <id>] [--transport grpc|ws|mjpeg] [--max-fps N]
              [--bit-rate N] [--max-size N] [--record <file>]
              [--no-control] [--stay-awake] [--window-title <text>]
              [--port N] [--state-dir dir] [--ws-extension <path>] [--help]
```

| flag | 映射 | 默认 |
|---|---|---|
| `--serial` | `connect({ deviceId })` | 唯一连接的那台 |
| `--transport` | `CastOptions.transport` | `grpc` |
| `--max-fps` | `frameRate`，只收 15/30/60/120 | 30 |
| `--bit-rate` | `bitRate` | 8_000_000 |
| `--max-size` | `maxSize` | 不设 |
| `--record` | `recordPath` | 不录 |
| `--no-control` | `input.mode: "off"`，`features.control: false` | 可控制 |
| `--stay-awake` | `keepAwake(3600)` | 关 |
| `--window-title` | 页面标题 | `uitest-mirror` |
| `--port` | viewer 端口 | `0`（内核分配） |

`--max-fps` 收非四值即报错并列出允许值，不静默取整——扩展对其它值会静默回 2（跟随显示刷新），那是让人以为设了 15 fps 却拿到 60 fps 的坑。

### 5.2 流程

1. 解析 flag（未知即错）
2. `connect({ deviceId, task: "mirror", lease: true, stateDir })`
3. `LeaseHeldError` → 打印持有者 task + 8 位标签，退出码 1
4. `--stay-awake` → `keepAwake(3600)`
5. `createViewerSource(session.core, session.device, { stateDir, layout: false, cast: { transport, frameRate, bitRate, maxSize, scale }, recordPath })`
6. `startViewerServer({ port, host: "127.0.0.1", privacy: false, source, features: { inspect: false, capture: false, record: true, control: !noControl, privacy: false }, input: { mode: noControl ? "off" : "always", open } })`
7. `openAppWindow(url, { size })`；没有 Edge/Chrome 就打印 URL
8. 等 `waitForStop`（stdin close + SIGINT/SIGTERM），然后按逆序关闭

窗口尺寸按设备宽高比算：`900` 高、宽度取整到 100 的倍数，钳在 500..1400。

### 5.3 结构

```
packages/mirror/src/
  bin.ts       # --version / 退出码
  cli.ts       # 解析、startMirror()、waitForStop
  version.ts
```

`startMirror(opts, connect)` 与 `consoleMain` 同形：可注入 `connect`，测试不需要真设备。没有 `page.ts`——mirror 只用 core 的播放器，不加任何 HTML。

## 6. 错误与并发

| 情况 | 行为 |
|---|---|
| 设备被 agent 持有 | `lease_held`，打印持有者 task 和 tag，退出 1 |
| `--transport ws` 无扩展 / x86_64 | `ENOCAST`，退出 1，不回退 grpc |
| `--max-size` 超过设备能缩到的极限 | `EBADARG`，给出最小可达尺寸 |
| 端口被占用 | 关闭 session（含租约）后退出 1 |
| 第二个 mirror 实例 | 端口默认 0，不撞；租约冲突照常报错 |

- 不盲杀 daemon：mirror 只关闭自己 `connect()` 打开的东西
- 退出路径统一 `waitForStop`；Windows 上 `child.kill()` 不跑 handler，所以 stdin close 也算停止信号
- `--stay-awake` 的恢复是尽力而为，README 写明手动复位命令

## 7. 测试

**单元**（`packages/mirror/test/unit/`）：
- `cli.test.ts`：每个 flag 的映射；未知 flag 报错；`--max-fps 45` 报错并列出允许值；`--serial` 进 `deviceId` 而不是被吞
- `start.test.ts`：假 device + 假 viewer，断言 features、input mode、端口、`--no-control` 时 `control:false`
- `window-size.test.ts`：宽高比换算

**core**：
- `window.test.ts`（搬入 + `size` 用例）
- `cast-scale.test.ts`：整数除数表、mjpeg 小数、越界、双给报错
- `key-recents.test.ts`：`parseKeyName("recents")` → 187；页面按钮存在并发 `key: "recents"`
- `keep-awake.test.ts`：`-o` 与 `-r` 各一次，`restore()` 幂等

**设备**：9 条验收用例，见下。

## 8. 验收

新脚本 `scripts/acceptance-mirror.ts`，沿用现有 schema 与 `capturePage`，两台设备（标签 `7544d645` / `6c585f5b`），从打包后的 tarball 启动。

| # | 用例 | 判据 | 证据 |
|---|---|---|---|
| 1 | 窗口打开 | 页面 canvas 有帧，fps > 0 | 浏览器截图 |
| 2 | 点击落设备 | 点计算器数字，设备布局树出现该数字 | 浏览器 + 设备截图 |
| 3 | 键盘文本 | 输入 `123`，设备出现 `123` | 浏览器 + 设备截图 |
| 4 | 拖拽/滚动 | 历史列表滚动一格 | 设备截图 |
| 5 | Back / Home / Recents | 三个键各一次，布局树确认切换 | 设备截图 ×3 |
| 6 | 录制 | `--record` 产出可解析 MP4，大小 > 0 | 日志 + 文件 |
| 7 | `--max-size 1024` | 帧宽 ≤ 1024，且解析出的 `-scale` 与表一致 | 日志 |
| 8 | `--no-control` | 页面无键位区，注入被拒 | 浏览器截图 |
| 9 | 租约冲突 | 第二个实例退出非 0 且打印持有者 tag | 日志 |

`--stay-awake` 并入用例 6 的日志断言（启动后 `timeout -o` 出现，退出后 `-r` 出现）。

隐私：截图逐张人工检查，锁屏/通知栏/账户信息一律不上官网。

## 9. 发版与站点

1. core 0.11.0 → phone 0.10.2 → console 0.1.2 → mirror 0.1.0，各自 tag、Release、npm publish
2. 每个产品各自跑验收，报告进 `docs/acceptance/<product>-<version>/`
3. `node scripts/gen-acceptance-pages.mjs` 生成 `site/acceptance-mirror-0.1.0.html` 并更新 hub
4. 站点新增 mirror 的产品条目、文档段和 changelog 条目；`check-site` 钉住这些文案
5. 干净目录从 npmjs 安装四个包验证

## 10. 范围外

- 原生桌面壳（spec §6.2 已后置）
- 音频、相机、OTG
- MCP、skill、审批、inspect UI、自动化命令
- 多窗口/多设备同时镜像
- 键位自定义映射
