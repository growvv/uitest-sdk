# uitest：core + 两个产品的架构设计

> 状态：已确认（2026-11-18，修订 2）。取代同日的第一版（3 包、console 并入 phone）。
> 范围：仓库结构、包边界、公开 API、迁移顺序。不涉及新设备能力。

## 1. 背景

0.9.4 是一个包：`uitest-sdk` 同时装着核心库、CLI、MCP、skill、投屏和 live 页面
（tarball 141 个文件、1.09 MB、126 个根导出）。两条产品旅程已经存在，但共用一套
安装和版本。具体的结构性问题：

- `src/device.ts:16` 直接 import `live/input-lane`，core 反向依赖产品；
  `Device` 一个类同时承担连接、两种控制栈、三种投屏传输和 live 输入通道
  （`src/device.ts:271-355`）。
- `src/index.ts` 平铺 126 个根导出，库、CLI、MCP、live server、cast client 没有分层。
- `Session`（1225 行）把编排、策略、租约、trace 混在一起。代价是真实的：live 的输入
  通道不走 policy（`src/live/input-lane.ts:48` 明写 "No policy lives here"）。
- 两套控制栈（agent 3151 行、hypium 2247 行）没有公共接口，`device.hypium` 直接漏出。

好的部分要保留：`COMMANDS` 是唯一的操作注册表，CLI 和 MCP 共用 `CommandRunner`，
MCP 的工具名和 schema 由 `src/mcp.ts:35` 从命令表生成，不存在第二套实现。

Pinky 的做法验证了方向：agent 面（`pinkyctl mcp` + 安装到各 agent 的 SKILL.md）和
人的界面（桌面 app）是分开的；审批在网关里，人在界面里点 Allow；接管是界面动作。
我们采用同样的分层，但不做桌面壳。

## 2. 已确认的决策

1. **core 包含投屏和 inspect。** cast、inspect 读取、可复用的 viewer（mirror +
   inspect 面板 + 隐私开关）都在 core；产品只组合，不重写。
2. **Pinky 类产品拆成两个包。** `uitest-phone` 是 headless 的 agent 包（CLI + MCP +
   skill，无界面）；`uitest-console` 是可选的人机界面（mirror/inspect 复用 core，
   加接管和审批收件箱）。
3. **Pinky 类产品不做桌面壳。** console 是本地网页，不装也能用 agent 包。
4. **mirror 的窗口 v1 用本地浏览器窗口。** 无边框 `--app` 模式；浏览器不支持时退化为
   普通标签页。原生壳后置。
5. **headless 审批 fail-closed。** 默认没有审批通道就拒绝；终端里用
   `uitest-phone approvals list|allow|deny` 做人工通道；装了 console 就有收件箱。
   MCP elicitation 以后再加。
6. **core 的 API 按能力分类。** `connect()` 返回 session，读/做/等/投屏/查看/治理
   各自一个命名空间；进阶能力走子路径。

## 3. 总体结构

**4 个包、2 个产品、1 个 core 库。**

| 实体 | 角色 | npm 包 | 安装 |
|---|---|---|---|
| core | 核心库（headless） | `uitest-sdk`（沿用现名） | `npm i uitest-sdk` |
| 产品 A（agent 包） | 对标 Pinky | `uitest-phone` | `npm i -g uitest-phone` |
| 产品 A（人机界面） | 可选控制台 | `uitest-console` | `npm i -g uitest-console` |
| 产品 B | 对标 scrcpy | `uitest-mirror` | `npm i -g uitest-mirror` |

```
                 uitest-sdk（core）
        ┌────────────┼─────────────┐
 uitest-phone   uitest-console   uitest-mirror
 （agent 包）    （可选人机界面）   （scrcpy 类）
        └──── Pinky 类产品 ────┘
```

- 三个产品包只依赖 core 的公开 API，互不依赖，各自安装、各自发版。
- core 不认识任何产品；产品里不包含设备实现。
- 投屏、inspect、input、viewer 都是 core 的能力，不是独立产品。
- `uitest-console` 是产品 A 的可选界面，不是第三个产品线。

## 4. core：`uitest-sdk`

一句话：**一台鸿蒙设备能做什么**。没有 bin、没有 MCP、没有 skill、没有产品专属 UX。

### 4.1 模块

| 模块 | 职责 | 来源（现有代码） |
|---|---|---|
| `transport` | 设备发现、hdc、文件、应用列表/启动、`tagOf`、多设备池 | `hdc.ts`、`files.ts`、`apps.ts`、`pool.ts`、`model.ts`、`errors.ts`、`util/*`、`session.ts:tagOf` |
| `driver` | ControlDriver 接口 + 两个适配器 | `device.ts` 的连接/守护进程部分、`agent/*`、`hypium/*`、`cli.ts` |
| `operations` | 设备动作、读取、等待、报告 | `session.ts`、`refs.ts`、`commands.ts`、`doctor.ts` |
| `governance` | policy、approvals（网关 + 状态存储）、lease/hold、trace | `policy.ts`、`approvals.ts`、`lease.ts`、`hold.ts`、`trace.ts` |
| `cast` | grpc / ws / mjpeg 三种传输、录制、fps、cast 配置 | `cast/*`、`live/record.ts`、`config.ts`、`fps.ts` |
| `input` | 指针/键盘注入原语 | `live/input-lane.ts` → `input/lane.ts` |
| `viewer` | 来源校验的 HTTP+WS 服务器、参考 WebCodecs 播放器、**inspect 面板**、隐私开关、浏览器输入语义 | `live/origin.ts`、`live/ws-server.ts`、`live/avc.ts`、`live/input.ts`、`live/state.ts`、`live/server.ts` 的通用部分、`live/player.ts` 的通用部分 |

投屏和 inspect 都归 core：任何产品（包括第三方）都能用同一套流、同一套布局树、
同一个 inspect 面板，不需要重新实现。

### 4.2 API 分类

`connect()` 返回一个设备绑定的 session，能力按动词分组，和 CLI/skill 的动词一一对应：

| 类别 | 方法 | 职责 |
|---|---|---|
| **connect** | `connect(opts?)`、`connectDevice(opts?)` | 设备发现与连接；`connect` 直接返回 session |
| **observe** | `layout(opts?)`、`screenshot(opts?)`、`window(filter?, opts?)`、`apps()`、`inspect(opts?)` | 读：布局树/稳定 refs/截图/窗口/应用/HTML 快照 |
| **act** | `tap(target, opts?)`、`type(text, opts?)`、`swipe(input)`、`drag(...)`、`fling(...)`、`pinch(opts)`、`key(...)`、`launch(app)`、`longPress(...)`、`doubleClick(...)` | 做：所有输入动作 |
| **wait** | `forText(text, opts?)`、`forSelector(on, opts?)`、`settle(opts?)`、`scrollUntil(opts)` | 等：等待、稳定、滚动查找 |
| **cast** | `open(opts?)`、`record(opts?)`、`configure(settings)` | 投屏：流、录制、cast 配置 |
| **view** | `open(opts?)` | 可复用 UI：启动 core 的 viewer（mirror + 可选 inspect + 隐私） |
| **govern** | `policy(...)`、`approvals(...)`、`lease(...)`、`hold(...)`、`trace(...)` | 治理：规则、审批、租约、接管、记录 |
| **lifecycle** | `close()` / `release()` | 关闭会话、释放设备 |

```ts
import { connect } from "uitest-sdk";

const session = await connect();

const ui = await session.observe.layout();
await session.act.tap({ ref: ui.ref("确定") });
await session.wait.forText("完成");

const stream = await session.cast.open({ transport: "ws" });
const view = await session.view.open({ inspect: true });

const pending = await session.govern.approvals.pending();
await session.close();
```

进阶能力走子路径，根入口保持小：

```
uitest-sdk
├─ .            connect, connectDevice, Session, Device, tagOf, errors,
│               公共类型, VERSION
├─ ./commands   COMMANDS, CommandRunner, parseArgv, 参数 schema 工具
├─ ./cast       createCast, CastClient, CastOptions, CastSettings, record
├─ ./viewer     startViewerServer, 播放器资产, viewer 选项, 浏览器输入协议
├─ ./govern     policy, approval store, lease/hold, trace
└─ ./drivers    ControlDriver, AgentDriver, HypiumDriver
```

- `session.view.open()` 用 core 的默认页面（mirror + inspect）。
  产品要自己的 UX 时，直接用 `uitest-sdk/viewer` 的 `startViewerServer` 传入自己的
  页面；来源校验和播放器仍来自 core。
- 根导出收敛到约 30 个，其余通过子路径显式导入；没有 `dist/...` 深路径的跨包访问。

### 4.3 必须守住的不变量

1. **没有产品代码。** core 不 import 任何产品包；没有 MCP、skill、CLI 展示逻辑。
2. **投屏和 inspect 只有一份。** 播放器、inspect 面板、隐私开关、来源校验都在 core；
   产品只组合页面和选项。
3. **来源校验只有一份。** 7 种握手的 `Origin` 校验（101/403/404）在 core 的 viewer
   服务器里，所有产品继承；安全用例只测这一份实现。
4. **治理是装饰器。** policy/approvals/lease/trace 包在操作外面；启用治理时，任何输入
   路径（CLI、MCP、浏览器）都经过同一层。mirror 不启用审批，但 lease 与 agent 共用。
5. **操作契约只有一份。** 21 个 `COMMANDS` 在 core；MCP 工具由它生成；skill 的命令表
   由 CI 校验，不手写第二份。
6. **原生资产跟着使用者走。** agent.so（arm64/x86_64）、libscreen_casting.z.so、
   scrcpy.proto 都在 core 的 `assets/`，由 core 负责解析和推送。

### 4.4 原生资产

| 资产 | 位置 | 说明 |
|---|---|---|
| `agent.so` arm64 / x86_64 | `packages/core/assets/` | agent 驱动 |
| `libscreen_casting.z.so` | `packages/core/assets/` | 6.8 casting，arm64 |
| `scrcpy.proto` | `packages/core/src/cast/` | gRPC 定义 |
| manifest | `packages/core/assets/manifest.json` | 全部扩展的版本/md5 |

## 5. 产品 A：Pinky 类

一句话：**鸿蒙原生的「AI 用你的手机，你在环里」**。它由两个包组成，可以只装前一个。

### 5.1 `uitest-phone`（agent 包，headless）

- CLI：`uitest-phone`，21 个命令 + `mcp`/`connect`/`install-skill`/`hold`/`handoff`/
  `resume`/`approvals`。
- MCP：工具由 core 的 `COMMANDS` 生成，stdio 接入各种 agent。
- skill：`SKILL.md` + `REFERENCE.md`，由 `install-skill`/`connect` 安装到
  Claude Code、Codex、Cursor、Copilot CLI、Gemini CLI 等；升级时自动刷新。
- **没有界面**：没有接管、没有审批收件箱、没有 live 控制台。
- 用途：GUI agent、mobile-use agent、真机验证/验收流程、CI。
- 审批：core 的网关；默认 fail-closed；终端里用
  `uitest-phone approvals list|allow|deny` 做人工通道。

### 5.2 `uitest-console`（可选人机界面）

- 本地网页控制台，不是桌面壳。
- mirror 和 inspect 复用 core 的 viewer（播放器、inspect 面板、隐私开关）。
- 产品专属部分：**接管**（lease/hold 的 UI）和**审批收件箱**。
- 读 core 的审批状态存储：显示待审批动作、上下文和截图，Allow/Deny。
- 活动/trace 视图（只读）。
- 可以和 `uitest-phone` 同时运行，也可以单独运行（只看/接管，不走 agent）。
- 安装形态：`npm i -g uitest-console`；不装不影响 agent 包。

### 5.3 审批模型

core 提供网关，两个包提供不同的人工通道：

```
动作 → policy 判定 → 需要审批 → 写 pending（id/动作/app/风险/超时 60s）
                                  ├─ uitest-phone approvals allow|deny（终端）
                                  └─ uitest-console 收件箱 Allow/Deny（界面）
                                → 操作继续或拒绝
```

- 默认 60 秒超时拒绝，与 Pinky 一致。
- 没有审批通道时 fail-closed，agent 收到明确状态，skill 要求它不得自行重试或自我批准。
- approval 记录在状态目录里（原子写），phone 和 console 用同一个 `--state-dir` /
  `--device` 就能看到彼此的待审批项。
- MCP elicitation 作为 v1 之后的增强，不作为 v1 的依赖。

### 5.4 对标 Pinky

| Pinky | 我们 |
|---|---|
| `pinkyctl mcp` + SKILL.md 装进各 agent | `uitest-phone` 的 MCP + skill，同一模式 |
| 桌面 app 负责 mirror/审批/接管 | `uitest-console` 本地网页，可选安装 |
| 审批在网关，60s 超时 | core 审批网关，默认 60s 超时拒绝 |
| 点击 mirror 接管，agent 暂停 | console 接管 + core lease/hold |
| 录制/HTML 报告 | core 的 trace/report；console 只读展示 |
| 银行/密码应用隐藏、OTP 遮挡 | roadmap（v1.x） |
| 虚拟副屏、iOS/Android | 非目标（我们是鸿蒙原生） |

### 5.5 包内容

- `uitest-phone`：bin、`cli-main`、`mcp`、`mcp-register`、`install-skill`、`connect`、
  skill 资产。依赖：`uitest-sdk`、`jsonc-parser`。
- `uitest-console`：bin、控制台页面/UX（mirror/inspect/接管/审批收件箱/活动）。
  依赖：`uitest-sdk`。

## 6. 产品 B：`uitest-mirror`（对标 scrcpy）

一句话：**鸿蒙版 scrcpy**——一条命令开始，键鼠直接操作，可录制、可脚本化。

### 6.1 CLI

```
uitest-mirror [--serial <id>] [--transport grpc|ws|mjpeg] [--max-fps N]
              [--bit-rate N] [--max-size N] [--record <file>]
              [--no-control] [--stay-awake] [--window-title <text>]
```

- 键盘：文本输入、Back/Home/Recents 快捷键。
- 鼠标：点击、拖拽、滚动。
- 投屏：复用 core 的 cast（6.8 grpc / 7.0 ws / mjpeg）；传输显式选择，不静默回退。
- 录制：复用 core 的 cast 录制。
- 范围外：MCP、skill、审批、自动化命令、inspect UI、音频、相机、OTG。

### 6.2 窗口（v1）

本地无边框浏览器窗口：优先 Edge/Chrome 的 `--app=<url>`；没有可用浏览器时退化为普通
标签页并打印 URL。窗口内容用 core 的 viewer 的 mirror-only 模式；mirror 只加键鼠映射
和录制控制。原生壳后置。

### 6.3 并发与租约

mirror 通过 core 的 lease 声明「人正在驱动」。设备已被 agent 持有时，打印持有者的
8 位标签并退出；`--no-control` 只关闭输入注入，cast 通道仍需可用，冲突时同样明确
报错。不做静默接管，不盲杀 daemon。

## 7. 依赖与版本

### 7.1 依赖规则

允许的边只有：

```
uitest-phone   → uitest-sdk
uitest-console → uitest-sdk
uitest-mirror  → uitest-sdk
```

- 产品之间不互相依赖；core 不依赖任何产品。
- 跨包只能用对方的 `exports` 入口，不能引 `dist/` 内部文件。
- 由 `scripts/check-layers.mjs` 在 CI 里钉住（类似 `check-site.mjs`）。

### 7.2 版本

- core 是兼容锚点；产品声明 `uitest-sdk` 的范围（1.0 前用 `~`，1.0 后用 `^`）。
- 四个包独立 semver、独立发布。core 只加 API 时不必发产品；产品改动不必升 core。
- 发布顺序：core → 需要它的产品。跨包集成测试用 `npm pack` 后的 tarball，不用工作区
  源文件。

### 7.3 0.9.4 → 新结构

- `uitest-sdk@0.10.0`：core；移除 bin/MCP/skill/控制台；`Device.createCast` /
  `openInputLane` 改为子路径/命名空间（0.x 内允许破坏）。
- `uitest-phone@0.10.0`：承接旧 CLI 的全部命令（`live` 除外），`npm i -g` 的用户迁移
  到这里。
- `uitest-console@0.1.0`：承接旧 `uitest-phone live` 的 mirror/inspect；新增接管和审批
  收件箱。
- `uitest-mirror@0.1.0`：MVP。
- 1.0 时冻结 core 的公开 API。迁移说明写进 CHANGELOG 和站点。

## 8. 模块搬迁表

| 现在（`src/`） | 去向 |
|---|---|
| `hdc.ts`、`files.ts`、`apps.ts`、`pool.ts`、`model.ts`、`errors.ts`、`util/*` | core `transport` |
| `device.ts`（连接/守护进程/driver 选择部分） | core `driver` |
| `agent/*`、`hypium/*`、`cli.ts` | core `driver` |
| `session.ts`、`refs.ts`、`commands.ts`、`doctor.ts` | core `operations` |
| `policy.ts`、`approvals.ts`、`lease.ts`、`hold.ts`、`trace.ts` | core `governance` |
| `cast/*`、`live/record.ts`、`config.ts`、`fps.ts` | core `cast` |
| `live/input-lane.ts` | core `input/lane.ts` |
| `live/origin.ts`、`live/ws-server.ts`、`live/avc.ts` | core `viewer` |
| `live/server.ts` 的通用部分、`live/input.ts`、`live/state.ts` | core `viewer` |
| `live/player.ts` 的播放器/inspect/隐私部分 | core `viewer` |
| `bin.ts`、`cli-main.ts`、`mcp.ts`、`mcp-register.ts`、`install-skill.ts`、`connect.ts` | `uitest-phone` |
| `assets/skill/*` | `uitest-phone` |
| `live/cli.ts`、`live/player.ts` 的接管/审批 UX | `uitest-console` |
| 新的 console CLI、页面、收件箱 | `uitest-console` |
| 新的 `mirror/cli.ts`、窗口启动器、mirror 页面配置 | `uitest-mirror` |
| `index.ts` | core 的 `.`（约 30 个）+ 子路径入口 |

## 9. 迁移阶段与验收

### 阶段 1：在单包内抽出 core（不改包名）

- 去掉 `core → live/cast` 的反向依赖；`Device` 不再有 cast/input 方法。
- 抽出 `ControlDriver` 接口，agent/hypium 做适配器；抽出治理装饰器。
- 把 live 的通用部分移到 `viewer`，把 `input-lane` 移到 `input`；加入审批状态存储。
- 验收：现有单测全绿；`check-layers` 通过（此时按目录规则）；设备冒烟通过；
  对外行为不变。

### 阶段 2：工作区 + `uitest-phone`（headless）

- 建 npm workspaces：`packages/core`、`packages/phone`；core 发布 0.10，phone 发布 0.10。
- 验收：`npm pack` 后干净目录安装 `uitest-phone`，21 个命令、MCP 21 个工具、skill
  安装/刷新、`approvals` 的 fail-closed 与 allow/deny 在两台真机上可用；
  `uitest-sdk` 的 tarball 里没有 bin、MCP、skill、控制台；`uitest-phone` 的 tarball
  里没有网页资产。

### 阶段 3：`uitest-console`

- 建 `packages/console`；mirror/inspect 复用 core viewer；实现接管和审批收件箱。
- 验收：console 在两台真机上显示 mirror/inspect；pending 审批能在收件箱里 Allow/Deny，
  并能和 phone 进程共享同一个状态目录；接管时 agent 暂停、交还后继续；来源校验 7 用例
  通过（跑 core 的那一份）。

### 阶段 4：`uitest-mirror`

- 建 `packages/mirror`；用 core 的 `cast`/`input`/`viewer` 起薄壳；实现 6.1 的 CLI 和
  6.2 的窗口。
- 验收：两台真机（6.8 grpc / 7.0 ws）各起一次；键鼠输入、录制、`--no-control`
  可用；在 agent 持有租约时明确拒绝；窗口在 Edge/Chrome 和缺省浏览器两种情况下都能用。

### 阶段 5：文档与发布

- 站点/README/CHANGELOG 写清四个包、迁移路径和两个产品；`docs/api.md` 按 core 的
  公开 API 重生成；skill 命令表加 CI 校验。
- 验收：`check-site.mjs`、`check-layers.mjs`、单测、`npm pack` 集成全绿。

## 10. 测试策略

| 层 | 内容 |
|---|---|
| 单测 | 随模块搬迁；根 `vitest.config.ts` 用 workspace 跑四个包 |
| 设备测试 | 现有 `test/device` 按依赖拆到 core/phone/console/mirror；两台真机 |
| 黑盒验收 | `npm pack` → 干净目录安装 → CLI/MCP/cast/窗口冒烟 |
| 审批 | fail-closed、60s 超时拒绝、allow/deny、phone 与 console 跨进程共享状态 |
| 安全 | core viewer 的 7 种握手（101/403/404）只测一份；审批存储的文件权限 |
| 架构 | `check-layers.mjs`：允许的边、无深路径、无产品→产品依赖、无 core→产品依赖 |

## 11. 文档与发布

- 每个包有自己的 README；core 有 `docs/api.md`；站点增加 core / phone / console /
  mirror 的安装与边界说明。
- CHANGELOG 记录 0.10 的破坏性变更：`uitest-sdk` 不再带 bin；`live` 迁移到
  `uitest-console`；`Device.createCast`/`openInputLane` 改为命名空间。
- skill 的命令表从 `COMMANDS` 生成或 CI 校验；验收页更新为新结构下的复跑结果。

## 12. 非目标

- 不新增设备能力、不改 agent 协议、不加新的投屏传输。
- 不做桌面壳；console 是本地网页。
- 不支持 iOS/Android/ADB；不做虚拟副屏。
- 不追求 mirror 的音频/相机/OTG。
- v1 不做 MCP elicitation。
- 不拆第 5 个包；cast/inspect/viewer 留在 core。除非出现第二个真实消费者，否则不再细分。

## 13. 风险与缓解

| 风险 | 缓解 |
|---|---|
| headless 审批没有界面，容易卡住 agent | fail-closed + 明确的 `approval_pending`；`uitest-phone approvals` CLI；skill 写清流程；console 可选 |
| phone 与 console 状态目录不一致，互相看不到 | 默认同一 state dir；`--state-dir`/`--device` 文档化；pending 记录带设备标签 |
| 有 shell 权限的 agent 可以调用 approvals CLI 自我批准 | 与 Pinky 相同的边界：网关防的是提示词驱动的自我批准，不是恶意宿主；CLI 用交互确认，文档写明 |
| viewer 拆分发散安全逻辑 | 只有一个来源校验的服务器；产品只提供页面/选项 |
| 分包后 import 图回退 | `check-layers.mjs` + CI |
| 公开 API 收敛引起迁移抱怨 | CHANGELOG + 迁移说明；0.x 内一次性完成 |
| `--app` 窗口在部分环境不可用 | 退化为普通标签页并打印 URL；不阻塞功能 |
| mirror 与 agent 抢设备 | 共用 lease；明确报持有者标签；不盲杀 daemon |
| skill 命令表漂移 | 从 `COMMANDS` 生成或 CI 校验 |
| 四包发布成本 | 发布脚本一次跑 pack + 干净目录集成 |
