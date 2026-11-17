# 13 · 阶段记录（stage log）

按阶段记录交付内容、发布结果、架构实测、决策与待办。新阶段追加在文末，不覆盖旧记录。

---

## 2026-11-16 · 0.3.0 → 0.4.0

本阶段把「Agent 能做什么」和「人什么时候拿回手机」两条主线补齐：默认值更保守、人可随时接管、
屏幕上的凭据不外泄、设备状态有名字、审批可以记住、Skill 跟着包升级走。

### A. 本阶段交付

| 分类 | 内容 | 版本 |
|---|---|---|
| 安全默认值 | 默认审批集扩到 `payments,finance,deletes,sends`；`commits` 保持 opt-in；`--read-only` 拒绝改数据 | 0.3.0 |
| 接管与交接 | `hold` / `resume` 人工持租约；`handoff --reason` 让 Agent 请人接手；`lease_held` / `handoff` 退出码 2 | 0.3.0 |
| Agent 接入 | `connect` 写 `claude` / `codex` 设置文件，只改本包一项；同时写 `~/.claude/skills` 与 `~/.agents/skills` | 0.3.0 |
| 凭据脱敏 | `observe` / diff / `read-list` / `screenshot` / `--trace-shots` / `report` 共用脱敏屏幕；密码框 `••••••`，凭据语境数字等长圆点；截图盖灰块；低层 `captureLayout()` / `captureScreen()` 保持原样 | 0.4.0 |
| 设备状态 | 新增 `device_locked` / `device_needs_setup` / `device_offline`，统一退出码 2；连接阶段读 `hdc list targets -v`；锁屏用 `ScreenLockWidget` 标签兜底（真机锁屏 bundle 是 `com.ohos.sceneboard`） | 0.4.0 |
| 审批记忆 | `--approval-scope once/task/always`；按 rule + bundle 记；`resume` 清 task 留 always；记住的授权只跳过审批，不越过凭据、`--read-only`、`--apps` | 0.4.0 |
| Skill 生命周期 | 安装写 `.uitest-skill.json`（版本 + 摘要）；`mcp` 启动刷新本包写的那份；人改过/手写的不动；0.3.0 副本按发布摘要识别接管 | 0.4.0 |
| Agent 覆盖 | `connect --agent gemini`（`~/.gemini/settings.json`）与 `--agent copilot`（`~/.copilot/mcp-config.json`，`type: "local"`、`tools: ["*"]`） | 0.4.0 |

### B. 发布与验证

| 项目 | 结果 |
|---|---|
| Release commit | `2599c5b release: 0.4.0 — credential masking, device states and remembered approvals` |
| Git tag | `v0.4.0`（已推 origin）；`v0.3.0` 保持原 tag |
| GitHub Release | https://github.com/growvv/uitest-sdk/releases/tag/v0.4.0 |
| npm | `0.0.0-stage, 0.1.0, 0.2.0, 0.3.0, 0.4.0`；`latest = 0.4.0`，`0.3.0` 发在 `legacy` tag |
| npm 安装验证 | 全新目录 `npm install uitest-sdk@0.4.0` → `node_modules/.bin/uitest-phone --version` 输出 `0.4.0` |
| 官网 | master 推送后 GitHub Pages 重新发布：首页、docs、changelog 均显示 0.4.0 |
| 测试 | 434 个单元测试全过；0.3.0 tag 树 385 个全过；`tsc`、`build`、`check-site` 全绿 |

### C. 架构实测（本阶段新增，可复用）

#### C1. 「单次模式、不常驻」的准确含义

官网说「宿主侧不常驻」：每条 CLI 命令是一个新的本地进程，跑完退出；跨命令状态（refs、审批、租约、
trace）全在磁盘。但**设备侧**仍有一个 `uitest start-daemon singleness --extension-name agent.so` 进程：

```text
运行前:            pidof uitest → 空
第 1 条 status:    4.1 s，拉起 agent.so daemon
第 2 条 status:    2.7 s，复用同一个 pid
命令退出后:        daemon 仍在
```

`Device.connect` 探测 8012：没有监听就拉起，有就复用；`dispose()` 默认**不杀**（`ownDaemon: true`
才杀自己拉起的那一个）。所以「没有后台 daemon」描述的是宿主侧，不是设备侧。官网文案已按此修正。

#### C2. `uitest uiRecord` 与 agent daemon 互斥

| 顺序 | 结果 |
|---|---|
| daemon 已监听 → `uitest uiRecord record -c true` | 立即失败：`Can not connect to AAMS, RET_ERR_CONNECTION_EXIST`；记录器进程退出；agent 会话 14 次 `captureLayout` 心跳全部正常 |
| `uiRecord` 先启动 → `Device.connect` | agent 连接被关：`AgentConnectionError: agent connection closed` |

`uiRecord` 本身是 **hdc shell 拉起的常驻设备进程**（杀掉本地 hdc shell 后设备进程消失），
记录 `/data/local/tmp/record.csv`（逐行 JSON，含控件 bounds/hierarchy），合成点击也会记录。
结论：MCP 会话活着就一定有 daemon，接管期间 `uiRecord` 永远起不来；它不是接管记录的可行路径。

#### C3. 扩展内部 UI 事件流同样不可用

- 扩展 ABI：`startCapture("recordUiAction", cb)` / `stopCapture`
- daemon JSON：`Captures.startCaptureUiAction` / `stopCaptureUiAction`（即 `streamUiActions()`）

两者是同一套 `UIEventObserver`。实测 `stopCaptureUiAction` 会关闭整个会话、能把 daemon 卡死
（连续三次），且合成输入也会回传。**内部接口存在，但不能用于接管记录。**

#### C4. `captureLayout` 轮询可行

- 真机单次 **169–252 ms**，与 agent 会话正常共存（14 次心跳无失败）。
- layout 自带 `bundleName` / `abilityName` / `pagePath` / `text` / `hint` / `focused`，足以生成线性时间线。
- 两个客户端并发：首轮会撞 `Capture already running: dumpLayout`，其中一个请求可能卡满 30 s；
  之后并发正常。记录器应使用短超时 + `retryOnBusy`，并且只在租约被人持有时轮询。

### D. 决策与放弃

- **接管记录暂不做**（2026-11-16）：`uiRecord` 与 daemon 互斥，内部事件流会卡死 daemon；
  Pinky 也没有这个能力，不阻塞对齐。
- 若将来重做：用 `captureLayout` 轮询写脱敏的线性 JSONL（页面/焦点/文本变化 + hold 起止快照），
  不做 Graph；线性日志天然适合直接进上下文或做 RAG 片段。
- 不引入自动回退：记录路径要么是轮询，要么不做；不在 uiRecord 与轮询之间静默切换。

### E. 已知问题与技术债

| 问题 | 状态 / 处理 |
|---|---|
| npm staged publishing | bypass-2FA token 现在会把 `npm publish` 先放入 staged 区；`npm stage list` 在验证期间可能返回空，`npm view` 也暂时看不到新版本。本次两版最终都已上线。发版后应以 registry (`npm view ... dist-tags`) 为准再宣布 |
| `package.json` 的 `bin` 写成 `./dist/bin.js` | npm 11.20 发布时会警告并自动修正为 `dist/bin.js`；发布产物正确（已用全新安装验证）。下次发版前去掉开头的 `./` |
| npx 缓存串版本 | 用默认 mirror 安装失败后，同一 `_npx` 目录可能残留旧版本；用官方 registry + 独立 cache 全新安装验证，package 本身正常 |
| 设备侧 daemon 默认保留 | 有意的复用设计；文档已说明 `ownDaemon`。不要盲杀 `uitest` 进程，MCP 会话可能正在使用 |
| 官网「没有后台 daemon」表述 | 已改为「宿主侧不常驻；设备侧扩展按需拉起并复用」 |

### F. 下一阶段候选

来自站点「计划中」，均未承诺，按实测收益再排优先级：

1. 7.0 casting（WebSocket 分支）实验支持，作为可选传输；
2. `perfmonitor_260608.so`（HTTP 9999）性能指标接入；
3. 录制参数在设备侧可配置（当前文件路径写死在扩展里）；
4. 更多 hypium 方法的一等封装（当前可用 `agent.hypium()` 直调）；
5. （可选，若重新考虑）接管时的线性「人的操作」时间线。

### 参考

- 能力与协议：[01](01-extension-abi.md)、[02](02-agent-so.md)、[08](08-missing-capabilities.md)、[09](09-capability-gaps-roadmap.md)
- SDK 行为与命令：[api.md](api.md)

---

## 2026-11-16 · 完整 hypium API（0.5.0）

本阶段把 hypium 6.1.0.210 的公开 API 全部铺平成 SDK 门面，并为它单开一个官网页面。

### A. 交付

| 内容 | 位置 |
|---|---|
| `HypiumDriver` 门面：118 个方法（`OHOSDriver` 106 + 兼容层 12），驼峰命名、类型化参数 | `src/hypium/driver.ts` |
| 目录表：hypium 原名 → TS 名 → 分类 → 状态，单测校验与门面一一对应 | `src/hypium/catalog.ts`、`test/unit/hypium-catalog.test.ts` |
| `Gesture` / `sampleGesture`、JPEG 模板匹配（`findTemplate` / `decodeJpeg` / `cropRaster`） | `src/hypium/types.ts`、`src/hypium/image.ts` |
| `Device.hypium` 惰性 getter；`dispose()` 一并关闭 | `src/device.ts` |
| 官网独立页：118 条方法表 + 4 张 SVG 图示 + 分类示例 | `site/api.html`（`scripts/gen-api-page.mjs` 生成） |
| 页面校验：118 个 TS 名、hypium 原名、四种状态、图示文字、体积 | `scripts/check-site.mjs` |
| Markdown 版第 8 节；站点 docs 第 9 节；README 新增一节 | `docs/api.md`、`site/docs.html`、`README.md` |

### B. 真机实测状态（BRA-AL00 / 1216×2688 / uitest 7.0.0.1）

| 状态 | 数量 | 说明 |
|---|---|---|
| `verified` | 106 | 逐条在真机上跑过 |
| `device` | 4 | `installApp` / `uninstallApp` / `clearAppData` / `takeScreenshot`：已实现，没做成功验收（后三个有副作用或产物落在 shell 读不到的位置） |
| `hardware` | 3 | `touchpadSwipe` / `touchpadSwipeAndHold` / `rotateCrown`：没有对应硬件，设备直接拒绝 |
| `unsupported` | 5 | Toast 与 UI 事件：`UIEventObserver` 从 `start` 返回，但对后续查询永不回包 |

验证脚本留在 `.work-bench/hypium-accept*.mjs`（gitignored），102 个独立探针、99 条通过记录；
6 条失败里 4 条是预期内的（3 个无硬件能力、1 个卸载不存在的 bundle），
2 条是真实问题：`pushFile` 的路径缺陷（见 C）和 `inputText` 用例引用了点击后失效的控件引用（用例问题，已重解析）。

### C. 实测中发现并修掉的缺陷

| 缺陷 | 根因 | 修复 |
|---|---|---|
| `isDisplayLocked()` 解锁时返回 `true` | `hidumper` 表格按空白切分，字段名与值被拆到不同 token | 逐行读第二个字段 |
| `pushFile()` 相对路径在设备上建出同名目录 | `hdc file send` 相对路径按目录树处理 | `HdcRunner.push` 先 `resolve(local)` |
| `setDisplayRotation("left")` 被设备拒绝 | 设备参数校验器只收整数 | `Rotation` 收窄为 `0 \| 1 \| 2 \| 3`，错误信息说明原因 |

### D. 文档与发布状态

- 站点 `changelog.html` 新增「未发布」区（master 有、npm 没有），`docs.html` 第 9 节加 `未发布` 标签。
- `scripts/check-site.mjs` 现在依赖 `dist/hypium/catalog.js`。`dist/` 被 gitignore，
  所以 `.github/workflows/pages.yml` 增加了 `setup-node` + `npm ci` + `npm run build` 三步；
  否则 Pages 构建会在「catalog.js is missing」处失败。
- `package.json` 的 `bin` 仍写成 `./dist/bin.js`，npm 11 会警告并自动修正；发版前顺手去掉 `./`。

### E. 发布

| 项目 | 结果 |
|---|---|
| Release commit | `c72c9f6 feat: expose the complete hypium API and publish 0.5.0` |
| Git tag | `v0.5.0`（已推 origin） |
| npm | `latest = 0.5.0`；分阶段发布，约 4 分钟后在 registry 可见 |
| GitHub Release | https://github.com/growvv/uitest-sdk/releases/tag/v0.5.0 |
| 官网 | Pages 部署成功；`api.html` 首次上线（此前 404），三个页面都显示 0.5.0 |
| 全新安装验证 | `npm install uitest-sdk@0.5.0` → `uitest-phone --version` 输出 `0.5.0`；`HypiumDriver` / `HYPIIUM_CATALOG`(118) / `Gesture` / `UnsupportedError` 均可导入 |

发版时发现并处理：`check-site.mjs` 依赖 `dist/hypium/catalog.js`，而 Pages 工作流只跑检查不构建，
CI 会在 `catalog.js is missing` 处失败。已在工作流中补 `setup-node` + `npm ci` + `npm run build`，
并用「移走 dist」复现过该失败。

### F. 下一阶段候选

1. ~~7.0 casting（WebSocket 分支）实验支持~~ → 已在 0.6.0 完成，见下节；
2. `perfmonitor.so`（HTTP 9999）性能指标接入；
3. 录制参数设备侧可配置；
4. （可选）接管期间的线性「人的操作」时间线。

---

## 2026-11-16 · 7.0 WebSocket 投流（0.6.0）

用户的要求是「先做 7.0 casting 的 WebSocket 传输」，同时要核实一个旧结论：早先的调查说 7.0
相对 6.8 缺能力。**核实结果是旧结论有三条是错的**，本阶段先修正认知，再落实现。

### A. 重新实测（真机 BRA-AL00 / uitest 7.0.0.1 / 7.0 SO `48bb6ccb…`）

| 旧结论 | 实测 |
|---|---|
| 7.0 muxer 持续写帧，静止也录 | ❌ 8 s 静止画面：6.8 与 7.0 **都是 259 B / 0 sample**，都是脏区驱动 |
| 7.0 用 `cpd` 单独下发 SPS/PPS，可提前初始化解码器 | ❌ 格式串在二进制里，但 10 s / 195 帧 / 三种命令顺序都**没收到过 `cpd`** |
| 多实例天然隔离，一个 daemon 服务多客户端 | ⚠️ 半对：两个客户端能同时出流（113/113 帧），但 `stop` 是**进程级**的 —— 一路 stop 另一路立刻停；stop 后监听 socket 关闭，新客户端 `closed before 101`；不 stop 直接断开则留下「接受连接、回 started、0 帧」的僵尸 |
| `frameCount` 上报有 bug | ✅ 成立，但**只在录制模式**（1,318 帧报 1）；推流模式正常 |

其它已确认的协议事实（用于实现）：

```
握手   GET / + Upgrade: websocket + Sec-WebSocket-Protocol: scrcpy → 101（子协议头必需）
文本   start→started；requestIDR→idrResponse（实测 9 ms）；stop→stopped
二进制 4 字节大端长度前缀 + Annex-B；前缀 == payload.length − 4（118/118 帧一致）
NAL    实测 {1:114, 5:2, 7:2, 8:2} —— SPS/PPS 在带内，跟关键帧走
opcode 只有 1 和 2，无分片、无 ping
```

**结论：两版本能力对等，选型只看客户端成本。** 因此决定**两个版本都支持**，按 cast 显式选择，
不做自动回退（[工具选型两原则](../../../.claude/projects/-E-CodeE-vibe51-uitest-agent/memory/uitest-tooling-selection-principles.md)）。

### B. 交付

| 文件 | 内容 |
|---|---|
| `src/cast/ws.ts` | RFC6455 子集：握手构造、帧编解码、Annex-B NAL 解析、关键帧判定 |
| `src/cast/ws-client.ts` | `WsCastClient`：spawn daemon → `hdc fport tcp:<port>` → 101 → start/stop；一个客户端独占一个 daemon |
| `src/cast/types.ts` | `CastOptions` 新增 `transport` / `wsExtension` / `port` |
| `src/device.ts` | `createCast` 按 `transport` 路由；ws 无扩展或 x86_64 时抛 `ExtensionMissingError`，**不降级** |
| `src/index.ts` | 导出 `WsCastClient` 与 `buildHandshake` / `decodeFrames` / `encodeTextFrame` / `isKeyFrame` / `nalTypes` |
| 测试 | `cast-ws.test.ts`（13）、`cast-ws-client.test.ts`（9）、`device.test.ts` +2；单元 **525 通过**，真机 18 通过 / 1 跳过 |

7.0 SO **不打包**（来源与再分发条款未声明，见 [09](09-capability-gaps-roadmap.md) §1.6）。
`wsExtension` 由调用方提供，按 basename 推到 `/data/local/tmp/<name>`，与内置 6.8 共存。

### C. 实现中发现并修掉的三个缺陷

1. **录制模式从未发 `start`** —— `start` 只在 `stream()` 里发，而录制调用方从不迭代它，
   于是 muxer 从未打开，`stop` 写不出东西。改为 `start()` 里录制模式立即发 `start`。
2. **`dispose()` 先置 `disposed` 再发 `stop`** —— `command()` 见到 `disposed` 直接拒绝，
   `stop` 根本没发出去。改为先发 `stop` 再置位。
3. **`waitForFile` 看到非零就返回** —— 7.0 muxer 在 `start` 时就建好 259 B 的头，
   样本到 `stop` 才落盘。实测拉到 259 B 空壳而设备上是 140 KB。改为「大小稳定且 > 1 KB」才返回。

三个缺陷都有先失败后通过的测试。

### D. 真机验收（`Device.createCast` 端到端）

```
stream  startMs 924~1268, firstFrame 82~137 ms, 112~116 帧 / 5 s (20.8~23.2 fps),
        requestIDR 7~9 ms, dispose 187~196 ms
record  MP4 156,320 B / stsz.sample_count 128（约 6 s 连续滑动）
```

设备侧 `/data/local/tmp/libscreen_casting.z.so` 已恢复为内置 6.8（md5 `8c8df9a9…`）；
7.0 只以 `libscreen_casting_ws.z.so` 的名字存在，测试结束即删除。

### E. 文档与版本

- `docs/api.md` §6：`CastOptions` 新字段、7.0 传输小节、录制写入时机
- `docs/09-capability-gaps-roadmap.md`：修正 §1.4 三条旧结论，P0 表标记完成
- `site/`：changelog 新增 0.6.0、docs.html 投流小节与版本、index.html 版本与导出数
- `scripts/check-site.mjs`：新增 `transport: "ws"` / `wsExtension` / 单客户端规则三条断言
- 版本 `0.5.0 → 0.6.0`

### F. 发布

| 项目 | 结果 |
|---|---|
| Release commit | `e4c1dd5 release: 0.6.0 — 7.0 WebSocket casting transport` |
| Git tag | `v0.6.0`（已推 origin） |
| npm | `latest = 0.6.0`（分阶段发布，约 70 秒后可见） |
| GitHub Release | https://github.com/growvv/uitest-sdk/releases/tag/v0.6.0 |
| 官网 | Pages 部署成功（45 s）；changelog / docs / index 均显示 0.6.0 |
| 全新安装验证 | `npm install uitest-sdk@0.6.0` → `uitest-phone --version` 输出 `0.6.0`；107 个运行时导出，`WsCastClient` / `HypiumDriver` / 118 条 catalog 均可导入 |

发版时处理：旧 npm token 没有 bypass 2FA 权限（`403`），改用用户提供的、开启 bypass 的 granular token；
临时 npmrc 放在仓库外，发布完成后立即删除。

---

## 2026-11-16 · 布局检查面板与节点高亮（0.7.0）

### A. 目标

把 `captureLayout` 的树与 `captureScreen` 的帧合成一张「带框和编号的图」，编号即 ref；
另给一个人看的单文件 HTML 面板。纯客户端，零新增设备依赖。

### B. 交付

| 文件 | 内容 |
|---|---|
| `src/agent/shot.ts` | `Screenshot.mark(boxes)`：显示坐标 → 帧坐标，2px 框线、可填充、3×5 数字标签（字形只有 0–9） |
| `src/agent/inspector.ts` | `inspectScreen(screen, shot)`：先按 `masked` 脱敏再画框；`renderPanel` 生成自包含 HTML（图片 base64 + CSS 覆盖层 + 节点表） |
| `src/session.ts` | `Session.inspect({ out, html? })` → `InspectResult`（`image` / `html` / `nodes`） |
| `src/commands.ts` | 新命令 `inspect`（CLI 与 MCP 共用），默认写到 `<state-dir>/shots/inspect-<ts>.jpg` |
| `src/index.ts` | 导出 `inspectScreen` / `renderPanel` / `ROLE_COLORS` / `colorFor`，类型 `InspectNode` / `Inspection` / `InspectOptions` / `InspectResult` / `MarkBox` / `Rgb` |
| 测试 | `shot.test.ts` +5、`inspector.test.ts` 7、`commands.test.ts` +3 |

### C. 设计决定

- **编号 = ref**：不另造一套 ID，`tap --ref N` 直接可用；ref 表与 `observe` 同源。
- **脱敏先行**：`redact()` 涂灰后再 `mark()` 画框，框线永远不替代脱敏。
- **颜色按角色固定**（`ROLE_COLORS`），两次运行可比对。
- **面板不叠图**：HTML 用 CSS 覆盖层按显示坐标百分比定位，缩放窗口不错位；底图是脱敏后的原图。
- **字形只有数字**：3×5 点阵 0–9，约 40 行，不引入字体或画布依赖。
- **屏幕文本是不可信输入**：面板所有标签经 `escapeHtml`，单测覆盖 `<img onerror>`。
- **锁屏不写文件**：`device_locked` 时不截、不存，文本也不声称已保存（单测钉住）。

### D. 真机验收

```
node dist/bin.js inspect --out .work-bench/inspect/device.jpg --html …/panel.html
settled · 5 个元素 · JPEG 127,621 B · HTML 85,918 B
```

方框与编号位置正确（状态栏按钮、通知列表、通知按钮）。锁屏时第一次调用返回 `device_locked`
且不写文件，符合预期；唤醒后同一画面被判定为 `settled` —— 既有锁屏识别依赖
`ScreenLockWidgetView` 节点，节点不在树里就不判锁屏，不属于本次改动。`inspect` 只渲染
`ScreenBuilder` 给出的模型。

### E. 已知边界

- 树与帧是两次读：屏幕在这期间变化时，框可能落后于画面（与 `observe` 存截图的取舍一致）。
- 面板的框是 DOM，不是像素；带框的 JPEG 才是导出物，两者坐标同源。

---

## 2026-11-16 · 薄封装三件套：文件、配置、帧率（0.7.0）

### A. 交付

| 文件 | 内容 |
|---|---|
| `src/files.ts` + `dev.files` | `list` / `stat` / `exists` / `mkdir` / `remove` / `move` / `push` / `pull` / `readText`；解析 `ls -l`，路径按设备 shell 转义 |
| `src/config.ts` | `CastConfig`（`<state-dir>/cast.json`）与 `castConfigPath`；`load` 宽容、`set` 严格、`toCastOptions(mode)` 显式合并 |
| `src/fps.ts` | `FpsMeter`：窗口化帧间隔统计，`add()` / `stats()` / `reset()` |
| `src/util/shell.ts` | `shellQuote` 从 hypium driver 提到 util，公开导出不变 |
| 测试 | `files.test.ts` 10、`config.test.ts` 9、`fps.test.ts` 7、`device.test.ts` +1 |

### B. 设计决定

- **`Files` 只做薄封装**：每个方法一条 shell 或一次 `file send/recv`；`remove` 是唯一破坏性操作，
  拒绝空路径与 `/`；`readText` 默认上限 1 MiB、硬上限 64 MiB，避免 `cat` 大文件把进程打爆。
- **配置是显式的**：`CastConfig` 不接管 `createCast`，调用方自己展开；`load` 忽略非法值，
  `set` 抛 `EBADARG`。字段与 `CastOptions` 同型（`scale: 1..5`、`frameRate: 15|30|60|120`）。
- **配置格式是 JSON**：与 refs / approvals / traces 的状态文件一致；没有引入 INI 解析器。
- **`FpsMeter` 不依赖投流**：按帧间隔算，至少两帧才报速率；MJPEG 与 H.264 都能用。

### C. 真机验收（`dev.files`）

```
list("/data/local/tmp")          解析出 name / size / isDir / mtime（真实目录 200+ 项）
stat(内置 casting SO)            247989 B · -rw-r--r-- · 2026-11-16 14:41
mkdir(".../uitest-files-check/a b")   含空格目录创建成功
push → list → readText(40) → move → remove -rf   全部成功
```

### D. 边界

- `list` 用 `ls -l`，不显示隐藏文件；需要时传具体路径用 `stat`。
- `hdc shell` 会做行尾转换，`readText` 读到的 JSON 里是 `\r\r\n`；需要精确字节时走 `pull`。

---

## 2026-11-16 · 浏览器投屏与实时检查 `live`（0.7.0）

用户的要求分两半：普通用户能直接看到手机画面（不是拿到一串 H.264 字节），以及 `inspect` 要有
live 模式——在网页上看画面、取值、复制节点，带一个默认打开的隐私开关。两半是同一件事：
一个页面、一条 WebSocket、一路投流。

### A. 架构决定

| 决定 | 理由 |
|---|---|
| 浏览器端用 WebCodecs `VideoDecoder` | 浏览器自带的硬解路径，一帧一次 `decode()` + 一次 `drawImage`；MSE 需要 fMP4 重封装并自带缓冲，延迟不可控 |
| 服务端做 Annex-B → AVCC | `avc1` 的 `EncodedVideoChunk` 必须是长度前缀样本，`description` 必须是 `avcC`；两者都由 SPS/PPS 现算 |
| 手写 RFC6455 服务端半边 | 包内已有客户端半边（`cast/ws.ts`）与零依赖原则，服务端只需 accept-key、帧头、解掩码三件事 |
| 纯状态机独立成模块 | 转移图可单测；服务端里只留 I/O |
| 背压 = 丢增量帧 + 请求 IDR | 画面已经落后时，补一帧旧增量只会让延迟更长；关键帧一次追平 |
| 断线宽限期 5 s | 刷新页面不该重开投流 daemon（真机启动 ~1.2 s + 首帧 3 s） |

### B. 交付

| 文件 | 内容 |
|---|---|
| `src/live/ws-server.ts` | RFC6455 服务端：`acceptKey` / `buildUpgradeResponse` / 帧头（7/16/64 位）/ `decodeClientFrames`（拒未掩码的客户端帧） |
| `src/live/avc.ts` | `splitNalUnits` / `nalType` / `codecString` / `toAvcc` / `avcC` / `parameterSets` |
| `src/live/state.ts` | `LiveState`：声明式转移图、失败原因、重连计数、监听器 |
| `src/live/server.ts` | `LiveServer`：HTTP 页面 + `/live` 升级 + hello/nodes 文本 + 二进制帧 + 布局轮询节流 + 宽限期 + 退避重启 |
| `src/live/player.ts` | 单文件页面：WebCodecs 解码、MJPEG 分支、节点表、点选复制、隐私开关、fps/延迟读数 |
| `src/live/cli.ts` | `uitest-phone live`：参数校验、设备/会话、Ctrl-C 释放 |
| `src/agent/screen.ts` | `ScreenBuilderOptions.redact` 与 `setRedact()`；ref 不因开关重编号 |
| 测试 | `live-ws` 14、`live-avc` 13、`live-state` 12、`live-server` 16、`live-cli` 14、`screen` +2 |

### C. 实测中发现并修掉的三个缺陷

1. **参数集被当成可解码的关键帧**。6.8 扩展开场那一帧只有 SPS+PPS（31 B）却标 `isKeyFrame`；
   WebCodecs 直接拒绝：`An EncodedVideoChunk was marked as type 'key' but wasn't a key frame`。
   页面因此连得上、显示 live、画布全黑——最难察觉的一类故障。改为按 NAL 类型判定：
   有 IDR 才是关键帧，没有切片就整帧不发。
2. **第二个页面继承了第一个页面关掉的遮罩**。屏幕模型是共享的一个对象，谁关开关就影响所有人。
   改为「只有所有连着的页面都要求不遮才不遮」，新页面从服务端默认值起步。
3. **x86_64 的 MJPEG 被当成 H.264**。`createCast` 在没有编码器时返回 MJPEG 客户端，
   服务端把 JPEG 当 NAL 解析，页面同样黑屏。改为按 `castKind` 分流，同一信封（flag + pts + 整帧）。

后续（2026-11-16，竞品调研时复测）又发现两个同类「连着但黑屏」的缺陷，都已修：

4. **写死 `hardwareAcceleration: 'prefer-hardware'`**。这个参数是**硬要求**不是偏好：
   在没有 GPU 解码的机器上（`--disable-gpu` 的 Chrome 实测）`isConfigSupported()` 返回 false、
   `configure()` 抛 `OperationError`，**30 帧一帧都出不来**；同一台机器上不传该字段、
   或传 `prefer-software`，都能正常解 30/30 帧。改为不指定，让浏览器自己挑；
   默认配置被拒时再用 `prefer-software` 重试一次并在提示条上说明。
5. **解码器出错后永不恢复**。`onDecodeError` 只把 `decoder` 置 null 并请求 IDR，
   但没有任何地方再开一个解码器，于是 `onVideo` 里 `if (!decoder) return` 之后每帧都被丢掉，
   那发出去的 IDR 请求永远没有接收方。实测：健康 20 帧 → 一个坏帧 → 卡在 20 帧不再前进。
   改为记住最近一次 `hello`，出错时立刻重开解码器再请求关键帧；实测恢复后继续画到 40 帧。

两条都有先失败后通过的测试（`live-cli.test.ts`），并用无头 Chrome 加载真实的 `PLAYER_HTML`
验证过新旧行为：旧代码 0/30 与 20→20，新代码 30/30 与 20→40。

### D. 真机验收

```
node dist/bin.js live --port 7100 --no-open     页面 200，/nope 404
探针（模拟浏览器）：101 + accept 正确 → hello(codec avc1.640034, avcC 34 B) → nodes 57 条
                    二进制帧：flag=1 + pts + AVCC(SPS/PPS/IDR)
无头 Chrome 实测：画布 1216×2688，非黑采样 3257/3293，badge live
连续 fling 20 s：绘制 375 帧 → 18.5 fps，帧间隔中位 33 ms / p90 55 ms / 最大 625 ms
隐私：开关 → 服务端 echo privacy:false → 重新读布局（redact=false）
重载：断开 300 ms 后重连 → 无 starting，直接续流
MJPEG（400×800 合成源）：页面 22 fps，像素均值 = 源 RGB
```

### E. 边界

- `live` 进程持有设备租约：页面开着期间 Agent 命令以 `lease_held` 停下。这是有意的——投流与
  Agent 动作抢同一块屏幕，混着用会互相打断。
- 像素级遮罩只作用于节点表与框；视频流本身不做像素打码。要连画面一起遮，必须让设备侧不渲染
  （`ScreenBuilder` 的遮罩发生在模型层），这一点写进了文档而不是含糊过去。
- 布局是轮询读的（默认 250 ms 一次），滚动时框可能落后一帧；这是 `captureLayout` 的成本，不是同步机制。
- 首帧 ~3.1 s 里大部分是 casting daemon 启动；宽限期正是为了避免刷新时重复付这笔钱。

---

## 2026-11-16 · 官网「实拍」：投屏与布局检查的截图演示

用户要的是「投屏和 inspect 功能在官网有带截图的示意图，可以做动画来演示」。没有做成视频：
现有 `video/`（Remotion）每次渲染要重装依赖、且画面是重绘的示意图，而这两张图必须是真实页面。
改用「真截图 + 页面自己播放的坐标高亮」，零新依赖、零构建步骤。

### A. 素材怎么来的

两张图都不是重画的，是从真实页面按发布尺寸截的：

| 素材 | 来源 | 尺寸 |
|---|---|---|
| `site/assets/showcase/live.jpg` | 无头 Chrome 打开 `uitest-phone live` 页面，同时用 `uitest uiInput swipe` 让真机持续滚动，等 fps 读数不为 0 再截 | 1020×900 |
| `site/assets/showcase/inspect-panel.jpg` | `uitest-phone inspect --html` 产出的单文件面板，`file://` 打开后按文档高度截全 | 1280×1132 |

关键细节：`live` 页面的 fps 是 500 ms 一桶的读数，画面停下后很快归 0。
所以要「滚动 → 停 → 约 300 ms 内截图」，既让画面和节点框已经重新对齐，又还没到计数器归零。
窄一点的视口（1020 而非 1440）让手机画面在整图里占比更大，缩到网页宽度后仍看得清。

### B. 高亮为什么能对齐

页面上的黄框是绝对定位的 `<span>`，坐标是从截图时的同一个 DOM 里量出来的**视口百分比**
（`getBoundingClientRect() / innerWidth`），不是估的像素。所以换任何显示宽度都落在同一行、同一个框上。

`scripts/check-site.mjs` 钉住三件事，任何一件失守都会让高亮错位：

1. 行高亮数 = 框高亮数（每步必须成对），且说明文字步数 = 高亮组数；
2. 每条高亮都用百分比，不接受 px；
3. 标记里声明的 `width`/`height` 必须等于 JPEG 文件里真实的 SOF 尺寸——换图不改坐标就会在这里报错。

### C. 动画

`main.js` 的 `initShowcase()` 每 2 s 前进一组：右侧节点表的一行、左侧手机画面上的一个框、
下面一行说明文字同时亮起。图滚进视口才启动，滚出去就停（`IntersectionObserver`）；
`prefers-reduced-motion` 下不启动，直接停在首步。

首步的 `is-on` 写在 HTML 里而不是等 JS 加：没有 JS 的访客看到的是一个正确的高亮对，
不是空白的覆盖层。

### D. 验收

```
node scripts/check-site.mjs            site ok（含新增 6 条断言，逐条做过变异测试）
无头 Chrome @1280：高亮 inside=true，行/框各 1 个 is-on，说明可见，docW=winW=1280
无头 Chrome @390 ：docW=winW=390，无横向溢出；图改为横向滚动并显示提示
2.4 s 后：说明从 [100] 个人热点 → [101] 流量管理（动画确实在走）
变异测试：删一个框 → 「高亮不成对」；坐标改 px → 「非百分比坐标」；
          删 initShowcase → 报错；删整节 → 「missing id="showcase"」；
          首步不点亮 → 按图报错；声明尺寸改成 1440 → 「is 1020x900 but markup says 1440x900」
```

### E. 边界

- 截图里能看到真机的系统状态栏（时间、电量、信号），没有账号、WLAN 名、验证码；
  设置页停在「移动网络」，不含个人信息。
- 高亮坐标和截图是绑定的：换一张图必须重新量坐标，否则 `check-site` 会拦住。
- 这不是视频，也没有逐帧回放；它演示的是「点一行会发生什么」，不是投屏的真实流畅度——
  真实 fps 由上面的数字和 `demo.mp4` 负责。

---

## 2026-11-16 · CI 跑测试、文档对齐、`type --paste`（0.8.0）

三件事按顺序做：让 CI 真的跑测试，把文档改成与 0.7.1 的实际状态一致，再把
`InputTextMode.paste` 从 `dev.hypium` 层接到 `Session` 与 CLI。

### A. CI 先测后发

`.github/workflows/pages.yml` 原来只有 deploy 一个 job，单元测试只在 `prepublishOnly`
里跑过——所以一个坏提交能到 master，而绿色的部署什么都不说明。现在：

- 新增 `test` job：`npm ci` → `build` → `typecheck` → `test`，`deploy` 依赖它。
- `pull_request` 也触发，但 deploy 带 `if: github.event_name != 'pull_request'`：
  PR 只测不发，否则未合并的分支会覆盖线上站点。
- `concurrency.group` 改为 `pages-${{ github.ref }}`。原来单一 `pages` 组下，
  PR 的测试跑会取消 master 正在进行的部署。

### B. 文档对齐

审计发现四处漂移，都已修正：

| 位置 | 原来的说法 | 实际 |
|---|---|---|
| `docs/09` P1 表 | 六项全是 ⏳ | 四项 0.7.0 已交付（inspect/live、`dev.files`、`CastConfig`、fps），只有 live 页的截图/录屏按钮与剪贴板是缺的 |
| `docs/09` P2 表 | 录制 MP4「只需封装」 | 0.6.0 起 `createCast({ mode: "record" })` 已封装 |
| `docs/13` 两处标题 | 「（未发版）」 | 两件事都在 0.7.0 里发了 |
| `README` 验收段 | 「16/16 PASS」不带日期与范围 | 报告是 11-14 生成的，早于 0.7.0；0.7.x 的新功能不在其中，实测在本文 |

顺带修了一个真问题：`scripts/acceptance.ts` 的 `renderReport()` 把 `--targets`
的原始值写进 `docs/acceptance/report.md`，而那份报告是提交进版本库的。仓库里之所以
是 `<your-device-id>`，是生成后手改的——文件头却写着「请勿手改」。下次谁跑一次，
真实序列号就进了 git 历史。

改法：设备 ID 一栏改用 `tagOf()`（sha1 前 8 位，`session` / `trace` / `lease` / `sn()`
共用的那一个），不用 `doctor` 的 `deviceTagOf()`——后者带 `dev-` 前缀，是另一套哈希，
报告里的标签要和日志里的对得上才有用。报告本身也换成了真实标签 `6c585f5b`。

为此把 `renderReport` 与 `EnvInfo` 导出，并把脚本末尾的 `void main()` 改成
「只在被直接执行时运行」（比较 `import.meta.url` 与 `process.argv[1]`），否则
import 这个模块就会连设备并 `process.exit(2)`。三个测试：渲染结果不含序列号、
多个目标各自打标签、**已提交的报告**不含占位符也不含序列号。第三条做过变异测试。

### C. `type --paste`

`InputTextMode`（`paste` / `addition`）早就在 `model.ts` 里，`dev.hypium` 也会透传，
但 `Session.type()` 从不传 mode，CLI 也没有旗标。现在：

- `TypeOptions.paste` → `AgentClient.inputText(x, y, text, mode)` → `Driver.inputText` 的第三个参数。
- CLI `type --paste`；MCP 的 `uitest_type` 因为 schema 由 `COMMANDS` 生成，自动获得该字段。

真机实测（设置 → 搜索框，`SearchField`）：

```
36 字符：逐字符 2761 / 2776 ms，--paste 1325 / 1340 ms
中文 + emoji「蓝牙耳机🎧」：粘贴后原样在框里，没有变成 ??
```

**没有暴露 `addition`**。实测它在 `Driver.inputText` 路径上是空操作：把光标左移两位再输入，
四种组合（默认 / paste / addition / paste+addition）结果都是 `ABCDEZ`。只有在
`Component.inputText` 路径上 `addition` 才真的追加（`ABCDE` → `ABCDEZ`，默认则是替换成 `Z`）。
`Session.type` 走的是坐标路径，所以给一个什么都不做的旗标比不给更糟。

### D. 验收

```
npm run typecheck                     干净
npm test                              647/647（新增 10 个用例）
node scripts/check-site.mjs           site ok
node dist/bin.js type --ref 302 --paste --text "蓝牙耳机🎧"
                                      settled，框内为「蓝牙耳机🎧」
变异测试：报告里的标签换回占位符 → 第 3 条测试红；不传 mode → paste 测试红
```

### E. 边界

- `test/` 不在 `tsconfig` 的 include 里，所以测试文件本身不做类型检查（仓库里现有 27 处
  测试类型错误）。新增的两个测试文件单独 `tsc` 过是干净的，但把 `test/` 纳入检查是
  另一件事，没有顺手做。
- `paste` 走设备剪贴板，会让「来自剪贴板」出现在搜索历史里——这是设备行为，不是 SDK 写的。

---

## 2026-11-16 · `live` 页的截图/录屏按钮、`test/` 纳入类型检查（0.8.0）

两件事都是补上一版留下的尾巴：`live` 页面缺两个按钮，`test/` 里的类型错误没人看得见。

### A. `live` 页的截图与录屏

页头多两个按钮，由 `hello` 里的 `canShot` / `canRecord` 决定显不显示——一个纯视频源
（没有 `readScreen` 的会话）两个都没有，按钮点了没反应比不显示更糟。

| 动作 | 走的路 | 为什么 |
|---|---|---|
| Shot | `source.capture()` → `Session.observe({ out })` | 截图必须和节点表用同一套遮罩：文字里藏起来的密码不能在像素里读出来。`saveShot` 已经有这条规则和测试，复制一份就是多一个出错的地方 |
| Record | `Recording` → `createCast({ mode: "record", outputPath })` | 录屏要另起一个 daemon，因为 `onStart` 在一个进程里只能开一次 |

录屏的坑是实测出来的，不是设计出来的：

- 第一版在 `createCast` 之后又调了 `cast.stream()`，结果 MP4 只有 259 字节，`pidof uitest`
  多出两个进程。原因：record 模式的 `start()` 里已经开了 `onStart`（`onEnd` 只能关掉一个
  已经打开的 muxer），第二次 `onStart` 被扩展拒绝。现在 `Recording` 永不调用 `stream()`，
  并用 `expect(made[0].streamCalls).toBe(0)` 钉住。
- record daemon 必须和 stream daemon 并存——按录制键不能把画面停掉——所以它要有自己的
  socket（grpc 用 `uitest_live_record`）或端口（ws 用 stream 端口 +1）。
- 收尾时发现 `H264CastClient.start()` 在 `fresh.length !== 1` 时直接抛错，把刚起来的
  daemon 丢在设备上。四个孤儿 `xdevice_scrcpy` 就是这么来的。现在先 `kill -9` 再抛。
- `close()` 与一个正在进行的 stop 会各发一次 `onEnd`（真机上就是第二次 pull）。stop 现在
  存成 promise，`close()` 等它而不是再发一次；有先红后绿的测试。

### B. `test/` 与 `scripts/` 纳入类型检查

`tsconfig.json` 的 `rootDir` 是 `src`，`include` 只有 `src/**/*.ts`，所以测试文件从来没被
类型检查过，积了 27 处错误。新增 `tsconfig.test.json`（`extends` 根配置，`rootDir: "."`，
`noEmit`，include 加上 `test/` 与 `scripts/`），`npm run typecheck:tests` 跑它，CI 的 `test`
job 在 `typecheck` 之后加一步。

27 处里只有一处是真问题：`UiNode.children` 声明成必填，但设备在叶子节点上根本不发这个键，
生产代码到处写 `node.children ?? []`。改成可选后少了 7 处，其余是测试自己的毛病
（`findLast` 需要 ES2023、假的 agent 少几个方法、`approval_pending` 少 `reason`、
`Buffer<ArrayBufferLike>` 与 `Buffer<ArrayBuffer>` 的泛型不匹配）。

### C. 验收

```
npm run typecheck                    干净
npm run typecheck:tests              干净（0 错误，改前 27）
npm test                             660/660（新增 13 个用例）
node scripts/check-site.mjs          site ok
```

真机：`live` 页面按 Record，画面 fps 保持 29–30 不掉；按 Stop 得到 41,830 字节的 MP4。

---

## 2026-11-16 · 多设备与多实例：归因改用 `ps -ef`、租约认进程（0.8.0）

探索「多设备同时投屏」时，顺手挖出两个真问题。两个都不是多设备特有的——同一台设备上开两个
`live` 页面就能复现。

### A. daemon 归因：`pidof` 差集 → `ps -ef` 的 argv

原来 `H264CastClient.start()` 用「起 daemon 前后 `pidof uitest` 的差集」认自己的进程，差集
不等于 1 就报错。两个页面同时启动时，各自看到「2 个新进程」，于是两个都失败、都重试、都
把对方刚起的 daemon 杀掉——实测成了一种活锁，页面反复 `starting → failed → starting`，
设备上堆了 8 个 daemon。

试过 `cat /proc/<pid>/cmdline`（`Permission denied`）和 `/proc/<pid>/fd`（同样拒绝），最后
发现 **`ps -ef` 能读到完整 argv**：

```
shell 49575 1 0 23:18:47 ? 00:00:00 uitest start-daemon singleness ... -scrcpy_socket_name scrcpy_grpc_socket
```

所以归因改成按 argv 里的 socket 名（gRPC）或端口（WebSocket）精确匹配，见
`src/cast/daemon.ts` 的 `ownDaemon()`。匹配不到就报错，**不杀任何进程**——那些新 pid 是别人的。

`live` 也给每个进程生成了自己的 socket 名（`uitest_live_<pid>`，录制是
`uitest_live_record_<pid>`），这样两页各自一个 daemon、互不覆盖。实测两页同时 `live`、
各自 socket 名不同、都能出流。

### B. 租约：同名 task 不再算重入

`Lease.acquire()` 原来只要 task 名相同就当作重入，直接返回原 lease。而每个 `live` 都把
task 叫 `live`，于是两个**不同进程**都能拿到设备——这正是租约要防的并发驱动。

改成要求 pid + host 也相同才算重入。task 名只是给 `lease_held` 看的标签，身份是进程。
有先红后绿的测试（`lease.test.ts`「refuses the same task name from a second process」）。

### C. 多设备

不需要新代码：每台设备一个 `live` 进程、端口分开即可。`pidof` 按 target 跑，状态文件
（`refs-`/`approvals-`/`grants-`/`leases/<tag>`）都按设备 tag 分，`traces/` 的文件名带
毫秒时间戳与进程内序号。唯一要注意的是同设备别开两个页面——现在会被租约挡住。

### D. 验收

```
npm run typecheck / typecheck:tests   干净
npm test                              664/664（新增 4 个用例）
真机：两个 live 页各自 uitest_live_<pid> socket，都进入 live
真机：同 state-dir 的第二个 live       lease_held（不再静默拿到设备）
```

清理时发现 `hdc fport ls` 会堆着几十条历史转发（每次失败的启动留一条）。这是实验残留，
不是代码问题，但值得记一笔：`fport rm` 要写完整的 `local remote` 两段，只写一段不生效。

---

## 2026-11-16 · `CastOptions.durationMs` 真正生效（0.8.0）

`durationMs` 之前是一个只写在类型里、代码从不读的参数：`docs/api.md` 与官网都写着「record：
录制时长」，但 `grep` 整个 `src/cast/` 只有那一行声明。按「不生效的旗标比没有更糟」的原则，
要么实现要么删掉——选了实现。

### A. 语义

到点调 `dispose()`，也就是调用方自己会走的那条路：关 muxer（`onEnd` / `stop`）、等文件写完、
拉回本机、杀 daemon、移除端口转发。两个客户端（gRPC 6.8 / WebSocket 7.0）都实现了，定时器
`unref()`，不会为了一个录制期限把进程吊住。

### B. 顺带修的两个真问题

- **`dispose()` 不是并发安全的。** 定时器与调用方可能同时调它，而两个客户端的守卫都只在
  同步段设 `disposed`，await 期间第二个调用会穿过去——两个 `onEnd` 就是两次拉同一个文件。
  现在把进行中的 dispose 存成 promise，第二个调用等它。
- **`hdc file recv` 失败时退出码是 0。** 它只在 stdout 打 `[Fail]Error opening file: ...`。
  原来 `pull()` 只看退出码，于是录屏的 `dispose()` 正常返回、调用方却拿不到文件。实测用
  绝对路径（`E:/...`）时 hdc 会把路径拼成 `E:\...\E:/...` 而失败，相对路径正常。现在
  `pull()` 读状态行并抛 `EHDC`。
- **拉文件失败会跳过清理。** 修完上一条后，pull 抛错会让后面的 `kill -9` 与 `fportRemove`
  不执行——一个失败的传输恰恰最容易留下孤儿 daemon。清理挪进 `finally`。

### C. 验收

```
npm run typecheck / typecheck:tests   干净
npm test                              669/669（新增 5 个用例）
变异：去掉 armDuration          → 两个 durationMs 测试红
变异：去掉 dispose 的 promise   → 并发 dispose 测试红
变异：去掉 finally 清理         → pull 失败测试红
真机：相对路径 + durationMs=3000，7 s 后文件 69,820 B，第二次 dispose 无副作用
真机：绝对路径                  → 明确抛 EHDC，设备上不留 daemon
```

官网 changelog 也补了 0.8.0 一节，并修掉「计划中」里把 0.7.0 已发的东西写成「待发布」的旧文案。

---

## 2026-11-16 · 发版验收抓到的回归：`resume` 放不掉 hold（0.8.0）

跑 `npm run acceptance:handoff` 时前 13 项全绿，卡在 `resume hands the phone back`：
`resume` 退出码 1，报 `lease_held · this device already runs task "held by a person"`。
脚本把 stderr 丢掉了（`stdio: [..., "ignore"]`），只看到一个 `Command failed`。

### A. 原因

上一节多实例修复里，租约重入从「task 名相同」改成了「task 名 + pid + host 都相同」——
这是对的，否则两个 `live` 页会互相抢设备。但 **hold 没有所属进程**：`hold` 写租约后进程就
退出，人在另一个 shell 里过一会儿才 `resume`。`resume` 拿新 pid 去重入，必然对不上，
于是把要释放的那张租约当成了别人的。

`hold` 一侧一直是 `force: true`，所以单元测试里「先 hold 再 resume」是同一进程、又能强制
拿到，一路都是绿的——真机上 `resume` 是独立进程，才暴露出来。

### B. 修法

`Lease.acquire` 的重入判断按租约类型分开：hold 认的是「有没有人持机」（`info.hold`），
普通任务认的是 pid。hold 本来就不该被 pid 判定，`processGone` / `abandonedHere` 两处
早就这么写了，只有重入这一处漏了。

先红后绿：`hold.test.ts`「releases a hold written by another process」用 `pid: 999999999`
模拟已退出的 `hold` 进程，改前抛 `ELEASE`，改后 `true`。
多实例那条守卫（`lease.test.ts`「refuses the same task name from a second process」）仍绿。

### C. 验收

```
npm test                              670/670
真机 npm run acceptance:handoff       handoff acceptance ok（15 项全绿，含 resume 与续跑）
```

### D. 验收时的两个坑

1. **屏幕自动锁会卡死 `streamScreen`。** 第一次跑在 `cropToWindow` 之后就停住了：屏幕休眠
   （`hidumper -s 3308 -a -a` 显示 `State=0`），`streamScreen` 的帧循环没有超时，一直等。
   跑之前 `power-shell wakeup` 并把休眠调长。
2. **截图会把锁屏上的个人信息发出去。** 第二次跑 16/16 PASS，但截图全停在通知栏：
   账户变动、提额提醒、快递、聊天摘要。这些图是随报告提交到公开仓库的。整目录
   `git checkout -- docs/acceptance` 回滚。

   第一次我把它归因为「跑之前没清通知栏」，那是错的。根因在脚本里：`triggerKey` 那一步
   按的是**电源键**，屏幕亮着就被它关掉了；`triggerKey` 自己的截图、以及之后每一个能力
   （`captureLayout`、`captureScreen`、`cropToWindow`、`streamScreen`）都拍在锁屏上。
   而且那一步本来也证明不了什么——拍一张自己刚按出来的锁屏，只能说明按键到达了设备。

   改法：`triggerKey` 按完把屏幕恢复（`pressPowerKey`），并且每个能力截图前都过一遍
   `assertCapturable`——锁着就 `hypium.unlock()`，解不开（有 PIN）就中止，绝不把通知栏
   写进仓库。先红后绿 4 个用例（`acceptance-capture-guard.test.ts`），变异：去掉
   `pressPowerKey` 里的恢复 → 测试红。

   真机重跑：16/16 PASS，`cropToWindow` 从 `com.ohos.sceneboard`（桌面/锁屏）变成
   `com.zhihu.hmos`，16 张截图逐张看过，全是知乎公开内容。

### E. 部署失败与重跑

0.8.0 的 release commit 推上去后，`test` 绿、`deploy` 挂在 `actions/deploy-pages@v4`：
`Failed to get ID Token ... Error Code: 503`。这不是 workflow 的问题（`permissions` 里
`id-token: write` 一直在，14:25 那次同样的 workflow 部署成功），是 GitHub 的 OIDC 端点
瞬时不可用。`gh run rerun --failed` **不能修它**：重跑会再上传一个 `github-pages`
artifact，`deploy-pages` 看到两个同名 artifact 直接报错。正确做法是
`gh workflow run pages --ref master` 起一次全新的 run。

### F. 0.8.0 发布

`npm publish` 用 bypass-2FA 的 granular token，临时 npmrc 放仓库外、发完删除。PUT 返回
**202 Accepted**（staged publishing），不是 201：包元数据先可见，tarball 晚约 90 秒才可下载。
期间 `npm view uitest-sdk@0.8.0` 会 404、`npm stage list` 也是空——不是失败，等一下再查。
最终 `dist-tags.latest = 0.8.0`，tarball 200。

---

## 2026-11-17 · `live` 页接管：点击、键盘、系统键与双指（0.9.0）

`live` 从「看」变成「能操作」。这一阶段的主线是**两条通道**：读布局的那条一直开，输入走另一条。

### A. 为什么是两条通道

第一版想过复用 `session.agent`：页面的点击和节点表共用一条连接。实测不行——agent 的调用是
串行的，一次 `touchDown` + 2 s 的 hold 会让整条连接停 2 s，节点表跟着卡住；键盘输入也排在
读屏后面。所以输入单独开一条 `hdc fport` 与一个 `AgentClient`（`device.openInputLane()`），
服务器启动时就预开，首次「接管」不用等 fport。

| 项目 | 数字 |
|---|---|
| 冷接管（页面已加载、lane 已预开） | 37 ms |
| 点击注入的写通道往返 | p50 3.9 ms · p95 18.9 ms（n=2，点击场景） |
| 整轮混合输入（含 456 ms 滚轮、文本落字） | p50 275.4 ms · p95 294.2 ms（n=200） |
| 换手（关控制页 → 另一页接管） | ack 33 ms |

「p50 3.9 ms」与「p50 275.4 ms」不是矛盾：前者是 `down/up` 两个 op 的注入延迟，后者包含
`mouseScroll` 这种每次约 456 ms 的设备侧调用。两条都写进报告，避免用好看的数掩盖慢的那部分。

### B. 状态机与拒绝

`readonly → controlled`，只有一个控制者。第二个页面 `take` 会收到 `busy by <clientId>`；
控制者离开（关页面、输入出错）广播 `readonly`，所有页面同步按钮；按住 10 s 无移动只抬
指针、保留控制权（人可能只是松手没发出来）。真机上还验证了
「先断后连」：关掉控制页后另一个页面 take 成功并立刻能滚动。

### C. 键盘与手势

- 普通输入：停顿 300 ms 后整段落设备。拼音：`compositionstart` 到 `compositionend` 之间
  一个字符都不发，结束时整词落下——实测组合期间设备画面不变，结束后出现「组合词」。
- 系统键：`back` 只弹一层（搜索页 → 信息流），不关应用；`home` 回桌面（bundle 变为
  `com.ohos.sceneboard`），再 `aa start` 冷启动回知乎。
- 双指：`LiveInput` 的首段只记基线，之后按前后 half 值注入。图片查看器内 80→120→160
  三段后画面差异 71.3（阈值 8），是真实渲染的放大，不是 CSS 缩放。
- 坐标是设备像素，但画布是解码帧：`--scale 2` 和 MJPEG（x86_64）路径的帧只有显示的一半，
  所以换算与 clamp 都按显示尺寸做（见 G 节）。

### D. 验收：知乎 10 个场景

`scripts/acceptance-live.ts`，报告在 `docs/acceptance/live/report.md`：

只读守卫、接管、点击、长按、滚动、键盘、浏览器键盘（无头 Chrome 走真实页面监听器）、
系统键、双指、稳定性。

稳定性用**同样输入的基线**，不是静止画面：投流只在画面变化时出帧，静止的知乎约 1.25 fps，
用它当基线会让「保住 90%」靠算术通过。同一套混合输入 60 s 基线 13.89 fps，10 分钟长跑
12.67 fps（1167 次输入），中途换手一次（ack 33 ms），期间一次回前台（知乎被系统切后台后冷启动回来）。

### E. 证据的隐私处理

截图要进仓库，所以：每张裁掉底部 200 px（账号头像与未读角标）；长按证据只保留输入助手条
及其下 24 px（其下是搜索历史）；桌面证据只保留顶部 360 px（其下是启动器的搜索历史）。长按的裁切
按节点几何算，不用固定高度——搜索词一长，助手条就下移，280 px 和 228 px 两个常数先后都出过
「切到一半」或「带上历史行」的问题。设备只以 8 位标签
出现。双指场景改从搜索「鸿蒙」进入——信息流首条是推荐服务给的，第一次跑到的是一张明星
问答，不适合放进官网。

### F. 官网

`site/index.html` 新增 `#control`：5 帧真机截图（搜索 → 结果 → 文章 → 查看器 → 放大），
光标、涟漪、键盘条与双指圆点按时间线播放；`prefers-reduced-motion` 时停在第一帧；
`scripts/check-site.mjs` 断言 5 帧、4 步、文件存在且不是占位图，并在无头浏览器里确认脚本
真的跑起来。

### G. 分支复审改掉的三个缺陷

复审对整条分支提了 2 个 Critical、3 个 Important。三个是产品缺陷，都在这一阶段修掉，每个都先写
出能复现的测试：

- **坐标按画布换算，而画布是帧不是屏。** `--scale 2` 的投流和所有 MJPEG 设备（x86_64 模拟器）
  给的是 608×1344，显示是 1216×2688，于是每次点击都落在左上角四分之一处。页面本来就有显示尺寸
  （节点框一直按它定位），输入改用它换算并 clamp。验收脚本里的 `focusField` 犯的是同一个错，
  两个错正好抵消——所以修复前浏览器键盘检查能过，修复后反而失败；一并改正。
- **写通道报错时先通知页面、后抬手指。** 服务器收到 `onError` 会立刻关掉写通道，抬起的那一下
  发到已经断开的 socket 上，手机上那根手指一直按着。现在先抬（最多 500 ms），再通知。
- **拼音选词时回车把拼音发了出去。** `flushText` 没有组合态保护，按回车选「鸿蒙」时发的是
  `hongmeng`。现在 `flushText` 与输入框的回车处理都在组合期间直接返回。

前两个各补了一个把页面脚本放进 `node:vm` 里跑的测试文件（`live-player-page.test.ts`）：
断言页面实际发出去的帧，而不只是断言模板字符串里有某段文字。

### H. 发版验收又抓出两个真缺陷

跑 0.9.0 的 16 项能力验收时，截图里出现了**锁屏通知栏**：账户变动、快递、聊天摘要。
两次都靠 `git checkout -- docs/acceptance/` 整个回滚。追下去是两个各自独立的 bug，
都在发布前修掉，各带测试。

- **`isDisplayLocked()` 读的是字段名，不是值。** `ScreenlockService` 的 dump 每行是
  ` * name <tab> value <tab> desc`，空白切分后字段名在 index 1、值在 index 2。原实现比较
  index 1 与 `"true"`/`"false"`，永远不匹配，于是落到兜底分支「屏幕是否亮着」——而按完电源键
  的手机正是**亮着且锁着**，被判成未锁。验收脚本那道「拍照前先确认可拍」的守卫因此形同虚设。
  改成按 index 1 匹配字段名、index 2 读值，三个测试钉住（真、假、以及行缺失时的兜底）。
- **`touch` 能力从状态栏起手。** 它的起点是 `(100,100)`——在状态栏里——再拖到 `(120,120)`，
  在这台 ROM 上等于把通知栏拉下来。手机没锁、屏幕亮着，锁屏守卫看不见它，之后每张截图都是
  通知栏。现在驱动新增 `isShadeOpen()`（读 `SCBDropdownPanel` 窗口的 z 序，隐藏时是 -1）
  与 `closeShade()`；验收循环在每个能力前先关通知栏，关不掉就中止；`touch` 起点改到屏幕中心。

两件事都是「守卫写了，但守卫本身是坏的」——和 0.8.0 那次 `triggerKey` 锁屏同源：证据会公开
发布，守卫不能只写不验。修完在真机上重跑，16/16 PASS，截图全部是同一个知乎公开回答页。

### I. 发版验收的第二条腿：handoff 闭环

发布清单要求两个验收脚本都过。`scripts/acceptance.ts` 之外还有
`npm run acceptance:handoff`（MCP 会话 → `uitest_handoff` → `lease_held` → `resume` → 续跑）。
第一次跑卡在 `resume`：`multiple targets attached (…): pass --device <id>`。

根因不是代码，是环境——hdc 里残留了一个离线的 `127.0.0.1:5555`（模拟器的旧连接）。
`hdc list targets` 只列出已连接的条目，看起来只有一台；SDK 内部按 `list targets -v` 数，
于是数出两个。`tconn 127.0.0.1:5555 -remove` 回 `[Fail]No target available`，唯一可靠的
清理是 `hdc kill && hdc start`。清完 16 项断言全过。

记在这里是因为它会长得像 SDK 的 bug：报错说「多台设备」，而用户只有一台。

### J. 0.9.0 之后清掉十条 deferred minors

整支分支评审留下十条 Minor，全部修完，每条都是先看到失败的测试再改代码。

- **系统键会越过还没发出去的文本。** 输入条按 300 ms 空闲发送，这个窗口里点「返回」，
  键先到手机、文本后到——落在已经换掉的界面上。原来只有「回车」会先 flush。现在四个系统键
  一律先 flush 再发键（§6.4）。键与 flush 都在同一帧里同步发出，`LiveInput` 的队列保证顺序。
- **官网演示会同时跑两条动画链。** `play()` 用嵌套 `setTimeout` 排节拍，id 从不保存，
  `stop()` 只清掉最外层的 tick。滚出视口中途停下、再滚回来，两条链各自移动光标、切换截图，
  显示的是另一条链的节拍。现在每个节拍都经过 `later()` 记录 id，`stop()` 整链清除。
- **注入计数在 200 处饱和。** `stats.n` 是 200 条延迟环形缓冲的长度，超过 200 次注入就不再增长。
  验收脚本按「刚做的动作数」算目标值去等它，跑久了永远等不到，本该通过的场景变成超时。
  新增单调的 `stats.total`（含慢操作），脚本改按它判断。
- **`taskkill` 是 Windows 专有。** 验收脚本在 `finally` 里杀无头 Chrome，macOS / Linux 上
  `execFileSync("taskkill")` 抛错后被「已经退出」的 catch 吞掉，Chrome 活着并占着调试端口，
  下一次跑接到的是上一次的页面。改成按平台给出杀进程的步骤（POSIX 上先杀进程组，再杀自身），
  并把 Chrome 以 detached 启动，让那个进程组真实存在。
- **`openInput` 同步抛出会永久锁死写通道。** `inputOpening` 缓存「正在打开」的 promise；
  `openInput` 若在返回 promise 之前就 throw，IIFE 在赋值之前就结束了，`finally` 清的是 `null`，
  随后那个 rejected promise 被存进去再也不清。此后每次接管都拿到同一个拒绝。补一条
  `opening.catch()`，条件性地清掉自己。
- **退出接管会丢掉刚 flush 的文本。** 页面按 §6.4 先 flush 再发 `release`，而服务端
  `cancel()` 直接清空队列——那段文本既没上手机，也已经从页面输入框里删掉了，人无从补打。
  现在 `cancel()` 只丢指针与滚轮，保留排队中的文本，并在抬指之后才发。
- **`--only` 会覆盖已提交的完整报告。** 局部跑写的还是 `report.md`，而它自己的表头写着
  「本次不是完整验收」。现在过滤跑写 `report-only.md`。
- **长按证据的裁切留白是固定 24 px。** 输入助手条下方的内边距不在布局里，随条自身文字变高；
  固定值在更高的条上会切掉下边缘。改成取「最低节点的 10%，且不低于 24 px」。

全套 807 passed / 1 skipped，两个 tsconfig 干净，`check-site.mjs` 通过（含无头 Chrome 的
`js-ready` 检查）。

### K. 0.9.1：十条修补之后又跑了一遍两个验收

0.9.1 是 0.9.0 的补丁版，功能不变，只进 J 节那十条。发版流程照旧，两条验收都跑：

- `npm run acceptance:handoff` —— 16/16，接管闭环（handoff → `lease_held` → `resume` → 续跑）。
- `npx tsx scripts/acceptance.ts --targets <id>` —— 16/16，`connect` / `click` / `swipe` /
  `touch` / `triggerKey` / `captureLayout` / `captureScreen` / `cropToWindow` / `streamScreen` /
  `createCast` / `createCastRecord` / `dualCast` / `dumpLayout` / `queue` / `rpcDuringStream` /
  `streamUiActions`。`streamScreen` 14.6 fps（上一版同机 11.3 fps）。

跑之前把设备收拾干净：`power-shell timeout -o 3600000` 常亮、确认 `screenLocked false`、
`SCBDropdownPanel` 的 z 序是 -1（通知栏关着）、知乎停在一个公开回答页。跑完 16 张截图
**逐张看过**：全部是同一个知乎公开回答页，无锁屏、无通知栏、无账号或聊天内容。

`git diff --ignore-cr-at-eol docs/acceptance/` 的差异只有耗时、节点数与录制文件大小，
这正是发版清单要求的形态。

### L. 0.9.2：包质量五项，不发设备

0.9.2 不动运行时。复盘时对着 `npm pack` 的产物逐项检查，发现五处对外文档各说各话，全部修掉
并各留一条断言（`test/unit/package-docs.test.ts`，15 条）：

1. **`docs/api.md` 只列了 7 个错误类，源码导出 13 个。** 补上 `DeviceStateError`、
   `AppNotFoundError`、`LaunchError`、`ElementNotFoundError`、`LeaseHeldError`、
   `UnsupportedError`，并把 `DeviceStateError.state` 与 CLI 状态词同源这件事写清楚。
2. **`assets/` 里三个华为签名二进制在裸 MIT 下发布，没有任何说明。** 新增根目录 `NOTICE`：
   逐条列出版本、大小、md5、来源路径，写明 MIT 只覆盖本仓库源码、二进制不随 MIT 授权、
   不提供担保，以及不想再分发时删掉 `assets/*` 改用 `extensionDir`。
3. **没有 `CHANGELOG.md`。** 新增，覆盖 0.1.0 → 0.9.1，按 Keep a Changelog 组织；测试断言
   `package.json` 的版本必须出现在里面，所以下一次 bump 忘记写条目会直接失败。
4. **官网路线图还挂着 0.9.0 已发的「`live` 页的点击交互」。** 删掉，并在
   `scripts/check-site.mjs` 里加**否定断言**——这一段不得再出现 `点击交互` / `画布上点一下`。
   原来的检查只问「该有的在不在」，没有任何一条问「不该有的还在不在」，所以它活过了一整个版本。
   这条断言用注入旧文案的方式验证过会真的失败。
5. **README 的验收数字落后两份报告。** 日期 `2026-11-14` → `2026-11-17`；截图 `107~193 ms` →
   `109~222 ms`（上界 193 低于最新实测 218，等于宣称比实际快）；UI 树 `~180~250` →
   `~180~430`（最新实测 349 节点）。同一处 `docs/api.md` 与官网两处（bench 表、能力卡）也一起改，
   `check-site` 的 needle 同步。测试的做法是「published range 必须覆盖报告里的实测值」，
   而不是要求各页数字相同——bench 表与验收表来自不同轮次，本来就该不同。

全套 803 passed，两个 tsconfig 干净，`check-site.mjs` 通过，`npm pack --dry-run` 里能看到
`NOTICE` 与 `CHANGELOG.md`。
