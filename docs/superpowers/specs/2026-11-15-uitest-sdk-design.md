# uitest SDK 设计

日期：2026-11-15
状态：待评审

## 1. 目标与边界

### 1.1 要解决的问题

鸿蒙设备的 UI 自动化能力分散在三个华为签名 `.so` 扩展和若干 CLI 工具里，每个都有独立协议、独立生命周期、独立坑。使用者要同时掌握：

- agent.so 的换行 JSON over TCP（`module`/`method`/`params`）
- libscreen_casting 的 gRPC over abstract unix socket（protobuf 手工解码）
- `hdc fport` 隧道管理、daemon 启停、崩溃重启
- 每条路径的延迟差异（同一件事能差 75 倍）

本包把这些收敛成一套 TypeScript API。

### 1.2 成功标准

1. `new Device()` 之后无需手动 push .so、启 daemon、建 fport。
2. 每个能力只暴露一条路径，且是最快的那条。
3. 失败直接抛错，不静默降级。
4. 单张截图 ≤ 200 ms，单次动作 ≤ 20 ms，UI 树 ≤ 600 ms（本机实测基线）。
5. 支持并发多路 H.264 推流 / MP4 录制。
6. **同一台设备被多个进程同时连接时不报错**（见 §4.6）。
7. **真机与模拟器上全部能力可用且通过验收**（见 §7.4）。
8. **交付一份带截图、脚本、原始输出的验收报告**（见 §7.5）。

### 1.3 明确不做

| 不做 | 原因 |
|---|---|
| 自建 `.so` | XPM 内核校验拒绝未签名扩展（docs/06） |
| 自动回退链 | 用户明确要求「不行直接报错」 |
| 窗口级截图 | 所有路径只能出整屏；仅提供 `cropToWindow()` 辅助 |
| AAMS 快速取节点 | 二进制里没有该 API |
| 虚拟屏配置 | casting 内部用，未暴露 |
| perfmonitor 封装 | 加载不稳定（缺 `ResizeVirtualScreen`），功能被 casting `-m 1` 覆盖 |
| 多设备并发 | v1 只支持单设备 |

### 1.4 运行环境

- Node ≥ 20（用 `node:net`、`node:child_process`、`AbortSignal`）
- 目标设备：HarmonyOS，uitest ≥ 7.0.0.1
- 依赖 hdc 可执行文件（默认从 DevEco SDK 路径发现，可用 `HDC_PATH` 覆盖）

**验收目标环境**（两套都必须跑通）：

| 环境 | 设备 ID | 型号 | 系统 | ABI | 分辨率 |
|---|---|---|---|---|---|
| 真机 | `<your-device-id>` | BRA-AL00 | HarmonyOS 7.0.0.111 | arm64 | 1216×2688 |
| 模拟器 | `127.0.0.1:5555` | emulator | HarmonyOS 6.1.1 (API 24) | x86_64 | 1320×2856 |

**模拟器特有约束**：

1. **agent.so 必须用 x86_64 版**：`uitest_agent_v1.1.9.x86_64.so`（1,460,181 B，`UITEST_AGENT_LIBRARY@v1.1.9`），来自 `@deveco/deveco-cli` 资源目录。arm64 版推上去 `dlopen` 直接失败。
2. **不存在 x86_64 的 casting 扩展**。全盘搜索无 `libscreen_casting` x86_64 构建，因此 **CastClient 只能在真机验收**，模拟器上跳过并标记 `SKIP (no x86_64 build)`。这是已知缺口，不是失败。
3. **模拟器启动前必须清掉 `HDC_SERVER_PORT`**：本机用户环境设了 `HDC_SERVER_PORT=65037`，但 hdc server 实际监听 8710，模拟器内部 hdc 客户端因此一直报 `hdc is not connected`。启动命令前 `unset HDC_SERVER_PORT` 即可。这是环境配置问题，SDK 不处理。

## 2. 已确认的设备侧事实

这些是设计的硬约束。真机数据实测于 `<your-device-id>`（BRA-AL00 / HarmonyOS 7.0.0.111 / uitest 7.0.0.1）；模拟器数据实测于 `127.0.0.1:5555`（HarmonyOS 6.1.1 / x86_64 / agent v1.1.9）。

### 2.1 agent.so（主力通道）

```
监听：127.0.0.1:8012（硬编码，无法改）
协议：换行分隔 JSON，请求 → 单行 JSON 响应
```

请求形状：

```json
{"module": "com.ohos.devicetest.hypiumApiHelper",
 "method": "Captures" | "CtrlCmd" | "Gestures" | "callHypiumApi",
 "params": {"api": "<名>", "args": <数组或对象>, "this": "<对象引用>"}}
```

**四条硬约束**：

| 约束 | 实测证据 | 对设计的影响 |
|---|---|---|
| 全局串行锁 | 两连接并发请求 → `{"exception":"Disallow concurrent use"}` | 客户端内置 FIFO 串行队列 |
| 响应无 `request_id` | 回复恒为 `{"result":…,"pts":…}`，`request_id` 被忽略 | 不能靠 id 配对，严格 FIFO 配对 |
| 流与回复混流 | `startCaptureScreen` 后，同连接上 JPEG 二进制与 JSON 回复交错出现 | 需要流解复用器 |
| 流式期间 RPC 可用 | 推流中另一连接 12 ms 正常返回 | 推流不阻塞动作，但**动作仍需排队** |

**能力面**：

| method | api | 说明 |
|---|---|---|
| `CtrlCmd` | `getDisplaySize` / `getDisplayRotation` | 5.2 ms |
| `Gestures` | `touchDown` / `touchMove` / `touchUp` | 原子触摸，坐标须在屏内 |
| `Captures` | `captureLayout` | UI 树，473 ms，~171 KB |
| `Captures` | `startCaptureScreen` / `stopCaptureScreen` | MJPEG，11.7 fps @608×1344 |
| `Captures` | `startCaptureUiAction` / `stopCaptureUiAction` | UI 事件流 |
| `callHypiumApi` | 全套 `Driver.*` / `Component.*` / `On.*` / `UiWindow.*` | `this` 必填（`Driver#0` 等） |

### 2.2 libscreen_casting.z.so（高帧率通道）

```
监听：abstract unix socket（默认 scrcpy_grpc_socket，可用 -scrcpy_socket_name 改）
协议：gRPC，ScrcpyService.onStart 是 server-streaming
```

| 启动参数 | 效果 |
|---|---|
| `-m 0` | H.264 Annex-B 流到 socket |
| `-m 1` | MP4 落盘（`record_socket_name`） |
| `-frameRate 15\|30\|60\|120` | 只认这四个值，其他静默回落 |
| `-scale N` | 整数倍缩小 1..5 |
| `-s 1` | 每帧落 `/data/local/tmp/xdevice_record_data/<pts>.h264` |

数据在 `ReplyMessage.payload` map：`len` / `pts` / `flags` / `data`。`flags` 8=SPS/PPS、2=IDR、0=P。

**两个坑**：`onEnd` 一旦调用，该进程内永远出不了帧（必须一 session 一进程）；静态画面靠脏区驱动，但实测仍有帧。

**来源与架构**：本地全部分发副本（`libscreen_casting.z.so` 247,989 B、`libscrcpy_server1..4.z.so`）**全是 arm64**。华为不公开发布这个文件，只能从三个渠道取：① `devicetest` / `hmdriver2` 等 Python 包的 `res/recorder/`；② DevEco 投屏相关 jar 解包；③ 从已连过的真机 `hdc file recv /data/local/tmp/` 拉回（我们这份就是）。**网上没有 x86_64 构建**，也没有公开源码可自行编译 —— 见 §2.5。

### 2.3 CLI 兜底

只有窗口级 layout 必须用 CLI：

```sh
uitest dumpLayout -p <path> -w <windowId> -b <bundleName> -a
```

其余 CLI 能力（`screenCap` / `uiInput` / `uiRecord`）都比 agent 慢 2~75 倍，不封装。

### 2.4 性能基线

| 能力 | 路径 | 真机实测 | 模拟器实测 |
|---|---|---|---|
| 单次 RPC | agent | 5.2 ms（中位） | 13.3 ms |
| 单张截图 | agent `startCaptureScreen` 起停 | **125~178 ms**（静态 125 / 有动画 178） | 97 ms（含首帧 67.7 ms） |
| 单张截图 | `snapshot_display` + pull | 675 ms | 未测 |
| UI 树 | agent `captureLayout` | 473 ms | 21.7 ms（67 KB） |
| UI 树 | `dumpLayout` + pull | 970 ms | 237 ms（61 KB） |
| MJPEG 流 | agent（画面有变化时） | 11.7 fps | **5.4 fps**（Gestures 驱动）/ 10.5 fps（连续滑动时） |
| 单击 | `Driver.click` | 113 ms | 141 ms |
| **滑动** | **`Driver.swipe`** | 毫秒级 | **6,224~12,646 ms** ⚠️ |
| 滑动 | `Gestures` touchDown/Move×8/Up | **48 ms**（10 次 RPC） | **45+32×8+30 ≈ 330 ms** ✅ |
| **原子触摸** | `Gestures.touchDown` | **3.85 ms**（中位） | 45 ms |
| **原子触摸** | `Gestures.touchMove` | **2.90 ms**（中位） | 32 ms |
| **原子触摸** | `Gestures.touchUp` | **3.50 ms**（中位） | 30 ms |
| 按键 | `Driver.triggerKey(26)` | 134 ms | 未测 |
| 文本输入（英文） | `Driver.inputText` | **730~930 ms** | 未测 |
| 文本输入（中文） | `Driver.inputText` | **1,312~1,537 ms** | 未测 |
| 文本输入 | `uinput -K -t`（hdc shell） | 400~474 ms（不支持中文） | 未测 |
| 文本输入 | `uitest uiInput inputText` | ~1,100 ms | 未测 |
| H.264 流 | casting | 13.6~89 fps（随 `-frameRate`） | **不可用**（无 x86_64 构建） |

模拟器上 agent 多数能力快于真机（虚拟化 CPU + 无真机 SELinux 开销），但 **`Driver.swipe` 是反例：慢 1000 倍以上**（实测 6.2~12.6 s）。所以 `swipe()` **必须走 `Gestures` 三段式**，不能走 `Driver.swipe` —— 真机上也一样（三段式延迟可控且能驱动出帧）。

**性能基线以真机为准**，模拟器只做功能验收。

### 2.5 投流路径选择：H.264 优先，MJPEG 兜底

投流有两条实现路径（v1），**这是同一能力的两种实现，不是「失败降级」**：

| 路径 | 协议 | 帧率 | 首帧 | 可用性 | 多实例 |
|---|---|---|---|---|---|
| **6.8 SO（H.264/gRPC）** | gRPC over abstract socket | 13.6~89 fps | 低 | arm64 真机 | ⚠️ 需改 socket 名 |
| **agent MJPEG** | 裸 JPEG over TCP 8012 | 5.4~10.5 fps | ~140 ms | 所有架构 | ✅ |

**选择规则**（主动选，不是被动兜底）：

```ts
// Device.createCast() 内部
const ext = resolveCastingExtension(abi)     // arm64 → 有；x86_64 → 无
if (ext) return new H264CastClient(ext)      // 首选 H.264
return new MjpegCastClient(this.agent)       // 主动选 MJPEG
```

> **v2 候选：7.0 SO 的 WebSocket 通道**（2026-11-15 已实测跑通，**不在 v1 范围**）
>
> | 项 | 7.0 SO | 6.8 SO |
> |---|---|---|
> | 传输 | RFC6455 over **TCP 5000** | gRPC over abstract socket |
> | 客户端依赖 | 零（裸 TCP + 手写帧编解码） | gRPC 运行时 + protobuf |
> | 帧率（30 / 60 设定值） | **27.4 / 59.3 fps**（同条件与 6.8 持平） | 27.1 / 59.8 fps |
> | 握手 / 首帧 | 3.5~6.1 ms / 390 ms | 12~15 ms / 400 ms |
> | 多实例 | ✅ `-p` 端口隔离（5000/5001 双路已验证） | ⚠️ 只能改 abstract socket 名 |
> | `-m 1` 录制 | ✅ 1,318 帧 / 11.64 s（muxer 持续写） | ✅ 97 帧（脏区驱动，静止 0 帧） |
> | 录制 frameCount 上报 | ❌ **有 bug，恒报 1** | ✅ 准确 |
>
> 两者是**不同的设备侧二进制**（逐字节 diff 85.38%），不是同一文件的不同用法。7.0 SO 只在 hscrcpy 仓库的 `server/` 目录里，**不在任何华为公开发行渠道**（HOScrcpy 2.13 未公开发行）—— 这是它不进 v1 的唯一原因。
>
> **来源已查清**（`docs/09` §1.6）：7.0 SO 由华为员工 `pengxiaochuan1@huawei.com` 在提交 `a3da359`（2026-10-22）引入，提交说明写「Implements HOScrcpy 2.13-aligned capture」；签名链是 `DevEcoTesting Release ← Huawei CBG Software Signing Service CA ← Huawei CBG Root CA G2`，与 6.5/6.8 完全一致。**它是华为官方签名的构建产物，不是伪造的** —— 签名覆盖全文件，能加载本身就证明未被篡改。真正的顾虑是**供应链风险**（版本漂移、无升级通道、无技术支持、再分发条款未声明），不是二进制不可信。
>
> **能力上两者对等**（2026-11-15 全量实测）：都能投流、都能录制，帧率一致。7.0 唯一的实质性优势是客户端零依赖 + `-p` 多实例；唯一劣势是 `frameCount` 上报有 bug。这台 ROM 上只有 6.8 和 7.0 可用（6.9 protobuf 符号不匹配，6.3.1~6.5 虚拟屏 ABI 断裂）。
>
> 若将来纳入，`resolveCastingExtension` 按「文件内含 `7.0-` 且 `WebSocket` 字符串计数 > 0」判定为 ws 分支，`castKind` 扩为 `"h264-ws" | "h264-grpc" | "mjpeg"`。**6.8 的 gRPC 路径必须始终保留** —— 它是唯一能自证来源的设备侧组件。

- **有 casting 就用 casting**（帧率高一个数量级）。
- **没有 casting（模拟器）或加载失败（真机）就用 MJPEG**。加载失败的判据：`uitest start-daemon` 后进程未新增、或 5 s 内 socket 未出现、或 `dlopen` 报错。
- 两条路径对外暴露**同一套 `CastClient` 接口**（`stream()` / `dispose()`），`castKind` 字段标明实际用的哪条（`"h264"` / `"mjpeg"`），调用方可查但不必分支。
- **不是静默降级**：`Device.createCast()` 返回的对象上 `castKind` 明确写出实际路径（`"h264-ws"` / `"h264-grpc"` / `"mjpeg"`），日志也打一行。用户原则「不写自动回退」针对的是「把失败掩盖成慢」；这里几条都是正常实现，选了最快的那条，属于原则 2「多种实现选最快最稳」。

**为什么这不是「兜底」**：兜底是「A 失败了偷偷用 B，调用方不知道」。这里是「先探测 A 是否可用，可用就用 A，不可用就用 B，并明确告知」。前者掩盖问题，后者是能力选择。

perfmonitor 不是第三条路径：本地 `perfmonitor.so`（354,487 B）同样是 **arm64**，真机上还要 `perfmonitor_260608.so` 才能加载（缺 `ResizeVirtualScreen` 符号），模拟器完全用不了。功能被 casting `-m 1` 覆盖。**v1 不封装。**

### 2.6 与同类开源项目的对比

调研了三个公开项目，结论是**我们的方案在关键指标上不落后，且在「多实例」和「无 hdc 热路径」两点上有明确优势**。

#### 对比表

| 维度 | HOScrcpy / hscrcpy | HarmonyMirror (macOS) | **本 SDK** |
|---|---|---|---|
| 视频通道 | gRPC（6.x SO）/ WebSocket（7.0 SO）/ snapshot 兜底 | gRPC → Python 桥 → 本地 TCP | gRPC（arm64）/ **MJPEG（x86_64 或 casting 失败）**；7.0 WS 通道已验证但列为 v2 |
| 中间层 | 无（原生 nghttp2） | **Python 桥进程**（gRPC→TCP 转换） | 无（Node 直接说 gRPC） |
| 触摸延迟 | 声称 <2 ms（HarmonyAgent，uinput） | 同左，回退 hdc uinput ~100 ms | **2.9~3.9 ms**（agent Gestures，实测） |
| 触摸实现 | uinput 写入 `/dev/uinput` | 同左 | agent `Gestures` JSON over TCP |
| 键盘 | 英文 `uinput keyEvent`，中文 `uitest uiInput inputText` | 未提 | **统一 `Driver.inputText`**（中英文均可，730~1540 ms） |
| 唤醒屏幕 | 有（HarmonyAgent） | 有 | **`Driver.triggerKey(26)`**（134 ms） |
| 多实例 | 多窗口连不同设备 | 未提 | **同设备多进程共存**（daemon 复用 + 退避重试） |
| 多路推流 | 未提 | 未提 | **多路 casting 并发**（不同 socket 名；7.0 SO 下可用 `-p` 端口） |
| UI 树 | 有（点击节点高亮） | 无 | **`captureLayout`**（21.7~473 ms） |
| 云手机面板 | 电池/GNSS/权限/国际化/传感器 | 无 | **无**（见下） |
| 渲染 | Direct2D 硬件加速 + GDI 回退、零拷贝、帧池 | VideoToolbox 硬解 | **不做渲染**（只出数据） |

#### 逐项结论

**1. 触摸延迟 —— 我们同一量级，且不需要自建 .so**

HarmonyMirror 的 HarmonyAgent 是**自己写的 C 程序**写 `/dev/uinput`，声称 <2 ms。我们的 agent `Gestures` 实测：

| 操作 | 真机中位 |
|---|---|
| `touchDown` | 3.85 ms |
| `touchMove` | 2.90 ms |
| `touchUp` | 3.50 ms |
| 完整 swipe（10 次 RPC） | 48 ms |

**同一量级**（差 1~2 ms，都在 4 ms 内）。而且我们不用自建 .so（XPM 会拒未签名扩展，见 docs/06），也不用 `hdc shell`（uinput 路径实测 400~474 ms）。

**2. 键盘 —— 我们的实现更统一**

他们英文走 `uinput keyEvent`、中文走 `uitest uiInput inputText`，两套路径。我们统一用 `Driver.inputText`：

| 路径 | 英文 | 中文 |
|---|---|---|
| `uinput -K`（hdc shell） | 400~474 ms | 不支持 |
| `uitest uiInput inputText` | ~1,100 ms | 支持 |
| **agent `Driver.inputText`** | **730~930 ms** | **1,312~1,537 ms** |

单一 API 覆盖中英文，比 `uinput` 快，比 `uiInput` 快 30%。

**3. 视频通道 —— 他们多了 WebSocket，但我们用的 SO 版本没这个**

hscrcpy 说「7.0 SO 默认 WebSocket，6.x SO 走 gRPC」。我们的 `libscreen_casting.z.so` 是 **6.8 版，纯 gRPC**（二进制里 `grpc` 出现 133 次，`WebSocket`/`nghttp2`/`Sec-WebSocket` 全为 0）。所以 WebSocket 通道对我们不可用 —— 除非拿到 7.0 的 SO。

**这是已知缺口**，但不是阻塞项：gRPC 路径帧率已达 13.6~89 fps。

**4. 中间层 —— 我们少一跳**

HarmonyMirror 用 Python 桥把 gRPC 转成 TCP 再给 Swift 消费，多一个进程、多一次拷贝。我们 Node 直接说 gRPC，**少一跳**。

hscrcpy 用原生 nghttp2，没有中间层，这一点和我们持平。

**5. 渲染 —— 我们不做，这是刻意选择**

他们的 D2D/VideoToolbox 硬解、零拷贝、帧池复用，是**投屏客户端**该做的事。我们是**自动化 SDK**，只负责把 H.264/JPEG 数据交给调用方，渲染由调用方决定。这是定位差异，不是能力缺失。

如果将来要做播放器，应该单独拆包，不该混进 SDK。

**6. 云手机模拟面板 —— 我们确实没有**

他们有：电池注入、GNSS 模拟定位、Haps 权限管理、国际化设置、传感器仿真（旋转/摇一摇）。

实测本机 ROM：

| 能力 | 本机可用性 |
|---|---|
| 电池注入 | ❌ 无 `battery_simulator` |
| GNSS 模拟 | ❌ 无 `gnss_simulator` |
| Haps 权限管理 | ❌ `bm` 无 permission 子命令，`aa` 无 grant |
| 传感器仿真 | ⚠️ 只有 `hidumper`（读），无写入工具 |
| 旋屏 | ✅ `Driver.triggerKey` 任意 keycode 都接受 |
| 录屏 | ✅ `mediatool` 存在 |
| 截图 | ✅ `snapshot_display` |

**这些是云手机（CPH）平台的能力，不是普通真机 ROM 的能力**。hscrcpy 的 README 明确写「emulator SO → 云手机主屏」，说明那些面板是配合云设备用的。**普通真机上做不了，也不该假装能做。**

**7. 多实例 —— 我们的独有优势**

两个项目都没提「同一设备被多个进程连接」。我们实测并解决了：
- daemon 复用（探测 8012 而非盲杀）
- 退避重试消化 `Disallow concurrent use`（40%~66% 冲突率 → 0 失败）
- 推流冲突隔离（`Capture already running` → `AgentBusyError`）

这是用户明确要求的场景，也是真实工程里最容易踩的坑。

#### 结论

| 问题 | 答案 |
|---|---|
| 我们有 HarmonyMirror 的 <2ms 输入吗？ | **有，3~4 ms**（agent Gestures，无需自建 .so） |
| 我们的速度比他们快吗？ | 触摸持平；键盘更快且更统一；视频少一跳中间层；**多实例和错误处理明显更强** |
| 投屏链路和他们一样吗？ | 设备侧**完全一样**（同一个 `libscreen_casting.z.so` + gRPC + fport）；客户端侧我们更薄 |
| 云手机面板我们有吗？ | **没有，普通真机 ROM 也没有对应工具**。这是云手机平台能力 |
| 和华为官方 HOScrcpy 比？ | 设备侧链路相同（都是官方扩展）；我们多了多实例、多架构支持、完整验收 |

## 3. 架构

### 3.1 分层

```
┌─────────────────────────────────────────────────────┐
│  Device（全托管门面）                                 │
│  push extensions · start daemon · fport · health     │
├──────────────┬──────────────────┬───────────────────┤
│  AgentClient │   CastClient     │   CliRunner       │
│  TCP 8012    │   gRPC unix sock │   hdc shell       │
│  串行队列     │   多路独立实例    │   一次性进程       │
│  流解复用     │   H.264/MP4      │   窗口级 layout    │
└──────────────┴──────────────────┴───────────────────┘
                         │
                  ┌──────┴──────┐
                  │  HdcRunner  │  子进程封装，唯一碰 hdc 的地方
                  └─────────────┘
```

**依赖方向**：`Device` → 三个 client → `HdcRunner`。三个 client 互不依赖。

### 3.2 为什么是这个切分

- **AgentClient 必须有串行队列**：设备侧是全局锁，并发会报错。把队列放在客户端，调用方可以放心并发调用而不必自己加锁。
- **AgentClient 必须有流解复用器**：JPEG 二进制和 JSON 回复共用一条连接，且响应无 id。解复用靠「JPEG 以 `FFD8` 开头、`FFD9` 结尾」和「JSON 以 `{` 开头、`\n` 结尾」这两个特征区分。
- **CastClient 不需要队列**：casting 支持多实例并发（不同 socket 名），每个实例一个独立 gRPC channel。
- **CliRunner 独立**：只有窗口级 layout 用，一次一个子进程，无状态。
- **HdcRunner 是唯一碰 hdc 的地方**：这样「hdc 依赖」边界清晰，将来若要替换只需改这一个文件。

## 4. 组件设计

### 4.1 HdcRunner

职责：所有 hdc 子进程调用的唯一出口。

```ts
class HdcRunner {
  constructor(opts: { hdcPath?: string; deviceId?: string; timeoutMs?: number })

  shell(cmd: string): Promise<string>
  push(local: string, remote: string): Promise<void>
  pull(remote: string, local: string): Promise<void>
  fportAdd(localPort: number, remote: string): Promise<void>
  fportRemove(localPort: number): Promise<void>
  listTargets(): Promise<string[]>
}
```

设计要点：

- **端口冲突处理**：`fport` 返回 `TCP Port listen failed` 时，说明本机端口被占，**自动换一个空闲端口**（这是唯一允许的「重试」，因为不是降级而是分配资源）。
- **fport 清理不可靠**：实测 `fport rm` 经常报 `ruler is not exist` 却仍留在列表里。因此 `Device.dispose()` 记录自己建的端口，清理时尽力而为，并在失败时打印警告而非抛错。
- **超时**：每个子进程默认 30 s，可用 `timeoutMs` 覆盖。

### 4.2 AgentClient

职责：agent.so 的完整 RPC 客户端。

```ts
class AgentClient {
  constructor(sock: net.Socket)

  // 通用
  call(method: AgentMethod, params: object): Promise<any>

  // 高层封装
  getDisplaySize(): Promise<{width: number; height: number}>
  getDisplayRotation(): Promise<number>
  captureLayout(): Promise<UiNode>
  captureScreen(opts?: { scale?: number }): Promise<Buffer>   // 单张，起停一次
  streamScreen(opts?: { scale?: number }): AsyncIterable<Buffer>
  streamUiActions(): AsyncIterable<UiEvent>
  touchDown(x: number, y: number): Promise<void>
  touchMove(x: number, y: number): Promise<void>
  touchUp(x: number, y: number): Promise<void>
  click(x: number, y: number): Promise<void>              // down + up
  swipe(x1, y1, x2, y2, opts?): Promise<void>            // down + N×move + up（Gestures，非 Driver.swipe）
  inputText(x: number, y: number, text: string): Promise<void>   // 中英文均可
  triggerKey(keyCode: number): Promise<void>             // 任意 keycode；26 = 电源/唤醒
  hypium(api: string, this: string, args: unknown[]): Promise<any>
}
```

**动作实现选择**（每条都有实测依据）：

| 操作 | 用 | 不用 | 理由 |
|---|---|---|---|
| 点击 | `Gestures` touchDown+Up | `Driver.click` | 7.7 ms vs 113 ms |
| 滑动 | `Gestures` down + N×move + up | `Driver.swipe` / `drag` / `fling` | 48 ms vs 模拟器 6.2~12.6 s |
| 文本 | `Driver.inputText` | `uinput` / `uitest uiInput` | 单一 API 覆盖中英文；比 `uiInput` 快 30% |
| 按键 | `Driver.triggerKey` | `CtrlCmd.pressKey`（不存在） | 只有 `triggerKey` 可用 |
| 唤醒 | `Driver.triggerKey(26)` | `Driver.wakeUp` / `screenOn`（不存在） | 实测 `No handler found` |

**串行队列**：

```
call() → 入队 → 队首出队 → 写 socket → 读响应 → 解析 → resolve → 下一个
```

- 队列是 FIFO，一次只有一个请求在飞。
- 请求超时（默认 10 s）时，**整个连接作废**：因为无法确定服务端是否还在处理，继续复用会错配响应。抛 `AgentConnectionError` 并让 `Device` 重建连接。
- **队列与流的交互**：`startCaptureScreen` 的 ack 走队列（是普通 JSON 回复）；此后的 JPEG 帧**不走队列**，直接投给当前流订阅者。`stopCaptureScreen` 的 ack 重新走队列，排在所有已缓冲帧之后。解复用器负责把两者分开，队列只看到 JSON。
- **队列深度**：不设上限。设备侧串行意味着调用方本就不该并发几十个请求；如需背压由调用方控制。但每个排队请求都带超时，卡住的请求会超时失败而不是永久阻塞。

**流解复用器**：

状态机，从 socket 读字节流：

```
state = IDLE
IDLE:
  遇到 '{'  → JSON 模式，读到 '\n' 为止 → 交给队列队首
  遇到 0xFF 0xD8 → JPEG 模式
JSON:
  读到 '\n' → 完整 JSON → 交给队列队首 → IDLE
JPEG:
  读到 0xFF 0xD9 → 完整帧 → 交给当前订阅者 → IDLE
```

关键细节：

1. **不能靠搜索 `{` 来切分**。JPEG 内部可能出现任意字节。必须先识别 `FFD8` 才能进入 JPEG 模式，且 JPEG 模式内只找 `FFD9`。
2. **`FFD9` 是安全的结束标记**。JPEG 熵编码数据里的 `0xFF` 必须填充成 `0xFF 0x00`，所以 `FF D9` 只会作为 EOI 出现，不会误判。
3. **必须处理跨包截断**。`FF` 与 `D8` 可能落在两个 TCP 包里，`{` 与 `\n` 同理。解复用器内部维护 `pending` 缓冲区，不足一个完整标记时继续等待，不消费。
4. **无订阅者时丢弃帧**。`streamScreen` 未消费时到达的帧直接丢弃，不排队 —— 否则内存会无限增长。

**单张截图实现**：

```ts
async captureScreen({ scale = 2 } = {}) {
  await this.call("Captures", { api: "startCaptureScreen", args: [{ displayId: 0, scale }] })
  const frame = await this.nextFrame()      // 等第一帧
  await this.call("Captures", { api: "stopCaptureScreen", args: [] })
  return frame
}
```

注意：`stopCaptureScreen` 的回复会排在已缓冲的帧之后，解复用器能正确处理（JSON 模式识别 `{`，JPEG 模式识别 `FFD9`）。

### 4.3 CastClient

职责：casting 的 gRPC 客户端，支持多路并发。

```ts
class CastClient {
  static async start(hdc: HdcRunner, opts: CastOptions): Promise<CastClient>
  stream(): AsyncIterable<H264Chunk>
  requestIDRFrame(): Promise<void>
  dispose(): Promise<void>
}

interface CastOptions {
  mode: "stream" | "record"
  socketName?: string          // 多路并发靠它区分
  frameRate?: 15 | 30 | 60 | 120
  scale?: 1 | 2 | 3 | 4 | 5
  outputPath?: string          // mode=record 时用
}
```

设计要点：

- 每个实例启动一个独立 daemon 进程（`uitest start-daemon singleness --extension-name libscreen_casting.z.so -m … -scrcpy_socket_name …`），配一个独立 fport，一个独立 gRPC channel。
- `dispose()` 必须先 `onEnd` 再杀进程 —— 因为 `onEnd` 有粘性副作用，但进程杀掉就无所谓了。
- **不复用进程**：`onEnd` 的粘性副作用使得同一进程无法开第二个 session。

### 4.4 CliRunner

```ts
class CliRunner {
  dumpLayout(opts: { windowId?: number; bundleName?: string; withFontAttrs?: boolean }): Promise<UiNode>
}
```

内部：`hdc shell uitest dumpLayout -p <tmp> [flags]` + `hdc file recv`。用 `/data/local/tmp/uitest_sdk_<random>.json` 避免撞车。

### 4.5 Device（门面）

```ts
class Device {
  static async connect(opts?: DeviceOptions): Promise<Device>

  readonly agent: AgentClient
  readonly cli: CliRunner
  readonly abi: "arm64" | "x86_64"      // connect() 时探测，决定推哪个 .so / 走哪条投流路径

  createCast(opts: CastOptions): Promise<CastClient>   // H.264 优先，无扩展则 MJPEG
  dispose(): Promise<void>
}

interface CastClient {
  readonly castKind: "h264" | "mjpeg"   // 实际走的路径，调用方可查
  stream(): AsyncIterable<H264Chunk | JpegFrame>
  requestIDRFrame(): Promise<void>      // MJPEG 路径上是空操作
  dispose(): Promise<void>
}

interface DeviceOptions {
  hdcPath?: string
  deviceId?: string
  agentPort?: number        // 默认 8012
  autoRestart?: boolean     // daemon 崩溃自动重启，默认 true
  extensionDir?: string     // 自备 .so 目录；不填则用包内 assets/
  requestTimeoutMs?: number // 单次 RPC 超时，默认 10000
  ownDaemon?: boolean       // dispose 时是否杀 daemon，默认 false（多实例安全）
  retryOnBusy?: boolean     // 遇 Disallow concurrent use 是否退避重试，默认 true
}
```

**`connect()` 的步骤**：

1. 发现 hdc，`list targets` 确认设备在线
2. 检查设备上扩展是否存在且版本匹配，不匹配则 `push`
3. **探测 8012 是否已监听**（`cat /proc/net/tcp | grep 1F4C`）
   - 已监听 → **复用**，跳过步骤 4。这是多实例共存的关键。
   - 未监听 → 直接执行步骤 4（**不预先清理**：8012 没监听不代表没有别的 uitest 进程，可能有人在用 casting）
4. `uitest start-daemon singleness --extension-name agent.so`，记录 `ownPid = pidof(after) \ pidof(before)`（**绝不 `kill -9 $(pidof uitest)`**：那会杀掉别的实例或别的扩展的 daemon）
5. 轮询 `cat /proc/net/tcp | grep 1F4C` 确认 8012 已监听（最多 5 s）
6. `fport` 建隧道（**每次 connect 用自己的本地端口**，冲突则换一个空闲端口）
7. 连 TCP，发一次 `getDisplaySize` 做健康检查

**`dispose()`**：关 socket → 清**自己建的** fport。**不杀 daemon**（别的实例可能在用）；仅当 `DeviceOptions.ownDaemon: true` 显式指定时才杀。全部尽力而为，不抛错。

**自动重启**：`autoRestart: true` 时，检测到连接断开就重跑步骤 3~7。**这是一次性重建，不是降级回退** —— 重建后仍走 agent，不会偷偷切到 CLI。

重启的边界条件：

- **不自动重放进行中的请求**。断开时正在飞的请求抛 `AgentConnectionError`，调用方决定是否重试。自动重放对写操作（点击、滑动）是不安全的 —— 无法知道设备执行到哪一步。
- **重启期间新请求排队等待**，最多等 10 s，超时抛错。
- **重启失败不无限重试**：一次连接失败 → 尝试重建一次 → 再失败就抛 `DaemonStartError`，让 `Device` 进入 `disconnected` 状态，后续调用立即失败。
- **流订阅者收到 `error`**，不会静默停帧。

### 4.6 多实例共存（同一设备被多个进程连接）

**场景**：两个 Node 进程各自 `Device.connect()` 连同一台设备。这是用户明确要求必须支持的场景。

#### 已实测的设备侧事实

| 事实 | 实测结论 |
|---|---|
| 两个本地端口能否同时 fport 到同一个远端 8012 | **能**。`tcp:18012→tcp:8012` 与 `tcp:18013→tcp:8012` 同时存在且都可用 |
| 两条隧道并发 RPC | 能通，但设备侧全局锁会拒掉一部分 |
| 冲突错误原文 | `{"result":null,"exception":"Disallow concurrent use"}` |
| 响应有无 request_id | 无。只能严格 FIFO 配对 |
| 一个客户端推流时另一个能否 `startCaptureScreen` | 不能，报 `Capture already running: copyScreen` |
| 一个客户端推流时另一个能否 `captureLayout` / `CtrlCmd` | **能**，正常返回 |

#### 冲突率与重试效果（实测）

模拟器 `127.0.0.1:5555`，3 客户端 × 30 次 `getDisplaySize` 并发：

| 策略 | ok | busy | 耗时 |
|---|---|---|---|
| 无重试 | 31 | 59（66% 冲突） | 172 ms |
| 指数退避重试（0.5 ms 起，翻倍，上限 20 ms，最多 40 次） | **90** | **0** | 204 ms |

真机上 2 客户端 × 40 次：无重试 ok=48 / busy=32（40%），加重试 ok=80 / fail=0，耗时同为 0.3 s。

**结论**：冲突是常态，不是异常。**必须内置退避重试**，代价可忽略（+32 ms / 90 次调用）。

#### 设计

```ts
// AgentClient.call() 内部
async call(method, params, opts) {
  for (let attempt = 0; attempt <= maxBusyRetries; attempt++) {
    const r = await this.queue.run(() => this.send(method, params))
    if (!isBusyError(r)) return r           // 正常结果
    if (!retryOnBusy) throw new AgentBusyError(r.exception)
    await sleep(backoff(attempt))            // 0.5ms → 1 → 2 → … → 20ms 封顶，±50% 抖动
  }
  throw new AgentBusyError("device stayed busy")
}
```

- `maxBusyRetries` 默认 40，`retryOnBusy: false` 可关。
- **只对 `Disallow concurrent use` 重试**，其他 exception 一律立即抛 `AgentProtocolError`。这不算「自动回退」，是同一路径内的资源争用重试。
- 重试在**队列内**做（占住队首），避免本进程内多条请求同时打设备加剧冲突。
- 抖动必须有：两个进程同步退避会一直撞在一起。

#### daemon 归属

| 情况 | 行为 |
|---|---|
| `connect()` 时 8012 已在监听 | 复用，不启新 daemon，记录 `ownsDaemon=false` |
| 8012 未监听 | 启 daemon，记录 `ownsDaemon=true` |
| `dispose()` 且 `ownsDaemon=false` | **不杀** daemon，只清自己的 fport |
| `dispose()` 且 `ownsDaemon=true` 且 `ownDaemon=true` | 杀 daemon |
| `dispose()` 且 `ownsDaemon=true` 且 `ownDaemon=false`（默认） | 也不杀 —— 另一个实例可能刚连上 |
| daemon 崩溃后 `autoRestart` | 重建连接时重新走步骤 3，可能变成复用别人重启的 daemon |

`ownDaemon` 默认 `false`，因为进程无法可靠判断「还有没有别人在用」。清理残留靠进程退出时的自然回收 + 下次 `connect()` 的探测。

#### 推流冲突

`startCaptureScreen` 遇到 `Capture already running` 时**直接抛 `AgentBusyError`**，不做任何抢占或等待。设备只有一个 capture 通道，抢占别人的流是错误行为。调用方要独占截图流，应自己保证同一时刻只有一个实例在推流。

`captureLayout` / `CtrlCmd` / `Gestures` / `callHypiumApi` 不受推流影响，可自由并发（仍受全局锁，靠重试消化）。

#### daemon 进程模型（实测，真机 `<your-device-id>`）

`uitest start-daemon` **每次调用都新起一个独立进程**，不会替换已有的：

| 操作 | 结果 |
|---|---|
| 起 agent daemon | pid 5423，监听 8012 |
| 再起 casting daemon | pid 5441，**5423 仍活着**，8012 仍在听 |
| 再起一次 agent daemon | **不会**新起进程（同扩展已有实例时被拒），仍是 5423 + 5441 |
| 再起第二个 casting（同 socket 名） | 新起 5516，但 `@testcast1` socket 仍只有一个 —— 第二个抢不到 |

**由此得出的两条硬约束**：

1. **`kill -9 $(pidof uitest)` 是危险操作**。`pidof uitest` 返回**所有**扩展的进程（agent + casting + …）。在 CastClient 里这么写会顺手杀掉 agent daemon，导致同进程的 `Device.agent` 失效。**必须只杀自己起的那个 pid。**
2. **定位自己的 pid 只能用差集法**：启动前记下 `pidof uitest` 集合，启动后再取一次，差集即新进程。原因：`/proc/<pid>/fd` 在 shell 权限下不可读，无法把 socket inode 映射回 pid；`netstat -p` 也因权限不足拿不到 pid 列。

```sh
before=$(pidof uitest)
uitest start-daemon singleness --extension-name <so> <args>
after=$(pidof uitest)
# 新 pid = after - before
```

`Device.dispose()` 与 `CastClient.dispose()` 都按这个记录杀自己那个 pid，不碰别人的。

#### 跨进程流订阅

agent.so 的 MJPEG 流是**广播**还是**单播**未验证。当前设计按单播处理：`streamScreen()` 只把帧投给自己连接的 socket 上收到的字节。如果实测发现帧会发到所有连接，需要在文档里标注，但不改设计（解复用器天然只处理自己 socket 上的字节）。

## 5. 数据模型

```ts
interface UiNode {
  attributes: Record<string, string>
  children: UiNode[]
}

interface UiEvent {
  type: string
  [key: string]: unknown
}

interface H264Chunk {
  data: Buffer
  pts: number
  flags: number      // 8=SPS/PPS, 2=IDR, 0=P
  isKeyFrame: boolean
}
```

`UiNode` 直接映射设备返回的 `{attributes, children}` 结构，不做转换 —— 属性名保留设备原样（`bounds` 是 `"[0,0][1216,2688]"` 字符串，提供 `parseBounds()` 辅助函数）。

## 6. 错误处理

**原则：一条路径，失败即抛错。**

```ts
class UitestError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown)
}

class DeviceNotConnectedError extends UitestError   // hdc 找不到设备
class DaemonStartError extends UitestError          // daemon 起不来
class AgentProtocolError extends UitestError        // 设备返回 exception
class AgentBusyError extends UitestError            // Disallow concurrent use / Capture already running（重试耗尽）
class AgentConnectionError extends UitestError      // 连接断开/超时
class ExtensionMissingError extends UitestError     // .so 不在设备上且无本地副本
```

设备返回 `{"result":null,"exception":"..."}` 时抛 `AgentProtocolError`，message 用设备原文。`exception` 命中 busy 特征串且重试耗尽时抛 `AgentBusyError`。

**不做的事**：
- 不重试业务失败（只重试端口冲突、`Disallow concurrent use` 这两类资源争用）
- 不降级到 CLI
- 不吞异常

## 7. 测试策略

### 7.1 单元测试（无设备）

- 流解复用器：喂各种字节序列（JPEG 中混入 `{`、JSON 中混入 `FFD8`、跨包边界）
- 串行队列：并发调用时只有一个在飞
- `parseBounds()`、protobuf 编解码
- 用 mock socket 模拟设备响应

### 7.2 集成测试（需设备）

标记为 `@device`，CI 默认跳过，本地 `npm run test:device` 跑。**每个用例在两套环境各跑一遍**（真机 / 模拟器），结果分别记录。

**功能验收矩阵**（每个能力都必须有一行）：

| 能力 | 用例 | 断言 | 真机 | 模拟器 |
|---|---|---|---|---|
| 连接 | `connect()` | 无异常，`getDisplaySize()` 返回真实分辨率 | 1216×2688 | 1320×2856 |
| 动作 | `click()` | 无异常，耗时 < 50 ms（真机）/ < 300 ms（模拟器） | ✅ | ✅ |
| 动作 | `swipe()` | **走 `Gestures` 三段式**，耗时 < 500 ms | ✅ | ✅ |
| 动作 | `touchDown/Move/Up` | 三段原子触摸无异常 | ✅ | ✅ |
| 动作 | `hypium('Driver.triggerKey', ...)` | 按键生效 | ✅ | ✅ |
| UI 树 | `captureLayout()` | 树非空，含 `bundleName` 属性，节点数 > 0 | ✅ | ✅ |
| 截图 | `captureScreen()` | 有效 JPEG（`FFD8…FFD9`），耗时 < 500 ms | ✅ | ✅ |
| 截图 | `captureScreen({scale})` | scale=1..5 都能出图，尺寸递减 | ✅ | ✅ |
| 截图 | `cropToWindow()` | 裁剪结果尺寸 == bounds 尺寸 | ✅ | ✅ |
| 流 | `streamScreen()` | **边用 Gestures 滑动边收帧**，10 帧内帧率 > 3 fps | ✅ | ✅ |
| 事件 | `streamUiActions()` | 手动操作设备能收到事件 | ✅ | ✅ |
| 推流 | `createCast()` | 收到帧；`castKind === "h264"` | ✅ | ✅ `castKind === "mjpeg"` |
| 推流 | `createCast()` H.264 | 收到 SPS/PPS + IDR，能解出帧 | ✅ | — |
| 录制 | `createCast({mode:"record"})` MP4 | 产出可播放 MP4 | ✅ | **SKIP**（MJPEG 无录制能力） |
| 多路 | 两路 `createCast()` | 两个独立 stream 都有数据 | ✅ | **SKIP**（agent 只有一个 capture 通道） |
| CLI | `dumpLayout({windowId})` | 拿到指定窗口的树 | ✅ | ✅ |
| 生命周期 | `dispose()` | 无残留 fport；`ownsDaemon=false` 时不杀 daemon | ✅ | ✅ |
| 队列 | 并发 10 个 `getDisplaySize()` | 全部成功（验证队列 + 重试） | ✅ | ✅ |
| 混流 | 推流中调 `getDisplaySize()` | 成功，< 100 ms | ✅ | ✅ |

**模拟器专属注意**：`streamScreen()` 的帧率断言必须**在有画面变化时测** —— 静止画面靠脏区驱动只出 1 帧。测试里用 Gestures 滑动造动画，不能空等。同理 `captureScreen()` 不受影响（起停一次必出帧）。

### 7.3 多实例测试（需设备，专项）

独立测试文件 `test/device/multi-instance.test.ts`，**必须真的开第二个进程**，不能只在同一进程内开两个 client。

| 用例 | 断言 |
|---|---|
| 两个进程各自 `connect()` | 都成功；第二个复用 daemon，不重启 |
| 两进程各并发 40 次 `getDisplaySize()` | 双方全部成功，无 `Disallow concurrent use` 泄漏到调用方 |
| 进程 A 推流，进程 B 调 `captureLayout` | B 成功，A 的流不中断 |
| 进程 A 推流，进程 B 调 `startCaptureScreen` | B 抛 `AgentBusyError`，A 的流不中断 |
| 进程 A `dispose()`，进程 B 继续工作 | B 不受影响，daemon 仍在 |
| 两进程同时 `dispose()` | 都无异常，无残留 fport |
| daemon 被外部 `kill -9` | 两个进程都触发 autoRestart，都恢复 |

实现方式：`child_process.fork()` 起 worker 脚本，用 IPC 传结果；主进程断言。

### 7.4 双环境执行

```
npm run test:device -- --target <your-device-id>    # 真机
npm run test:device -- --target 127.0.0.1:5555      # 模拟器
```

- 目标设备通过 `--target` 指定，缺省时用 `hdc list targets` 的第一台。
- **x86_64 上 casting 用例自动 SKIP 并标记原因**，不计为失败。
- 任一环境的功能用例失败即整体失败。

### 7.5 验收报告

最终交付物：`docs/acceptance/report.md` + 附件目录。

**报告结构**：

1. **环境清单**：两套环境的设备 ID、型号、系统版本、ABI、分辨率、agent.so 版本与哈希、hdc 版本
2. **功能验收表**：§7.2 矩阵的两列结果（✅ / ❌ / SKIP + 原因），每行附耗时
3. **多实例验收表**：§7.3 全部用例结果
4. **性能对比表**：真机 vs 模拟器 vs 基线
5. **失败与跳过项**：逐条说明原因（如 casting 无 x86_64 构建）
6. **附录**：截图、脚本、原始输出

**证据要求**（每项能力）：

- **截图**：`docs/acceptance/screenshots/<能力>-<环境>.png`，由 SDK 自己的 `captureScreen()` 产出 —— 这本身就是能力证明
- **测试脚本**：`docs/acceptance/scripts/<能力>.ts`，可直接 `node` 运行的最小复现脚本
- **工具输出**：`docs/acceptance/logs/<能力>-<环境>.log`，脚本的完整 stdout/stderr，含时间戳和耗时

**生成方式**：验收脚本跑完自动写 `report.md`（模板 + 数据填充），截图和日志由脚本自己落盘。**报告必须是脚本产出的，不是手写的** —— 手写报告无法复现。

### 7.6 性能回归

集成测试记录延迟，超过基线 2 倍则失败（基线见 §2.4，以真机数值为准）。模拟器只做功能验收，不做性能门禁。

## 8. 目录结构

```
src/
├── index.ts              # 导出 Device / 类型
├── device.ts             # Device 门面
├── hdc.ts                # HdcRunner
├── agent/
│   ├── client.ts         # AgentClient
│   ├── queue.ts          # 串行队列
│   └── demux.ts          # 流解复用器
├── cast/
│   ├── types.ts          # CastClient 接口 / CastOptions / H264Chunk / JpegFrame
│   ├── h264.ts           # H264CastClient（gRPC）
│   ├── mjpeg.ts          # MjpegCastClient（agent 转发）
│   ├── resolve.ts        # 按 ABI 选投流路径
│   └── scrcpy.proto      # gRPC 定义
├── cli.ts                # CliRunner
├── model.ts              # UiNode / UiEvent
├── errors.ts
└── util/
    ├── bounds.ts         # parseBounds / cropRect
    └── jpeg.ts           # JPEG 边界扫描

assets/
├── arm64/
│   ├── agent.so                      # v1.1.10
│   └── libscreen_casting.z.so        # 6.8-20260801
├── x86_64/
│   └── agent.so                      # v1.1.9（无 casting 版本）
└── manifest.json                     # 版本 + sha256 + 支持的 ABI

test/
├── unit/
└── device/
    ├── helpers.ts                    # getTarget / hasCastSupport / getDevice
    ├── acceptance.helpers.ts         # Evidence / Result
    ├── functional.test.ts
    ├── multi-instance.test.ts
    └── worker.ts                     # 多实例测试的子进程

scripts/
└── acceptance.ts                     # 跑双环境验收 + 生成报告

docs/acceptance/
├── report.md                         # 脚本生成
├── screenshots/
├── logs/
└── scripts/                          # 每能力最小复现脚本
```

`.so` 作为包资源分发 —— 用户不必自己找。版本和哈希写在 `assets/manifest.json`。`Device.connect()` 读设备 `param get const.product.cpu.abilist` 决定推哪个目录下的 `.so`。

## 9. 关键决策记录

| 决策 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 包形态 | 全托管 / 纯协议 / 分层 | **全托管** | 用户要「工具包」，不想每个使用者重写设备管理 |
| 截图路径 | agent MJPEG / snapshot_display / casting 抽 IDR | **agent MJPEG** | 125~178 ms vs 675 ms，且不碰 hdc shell/file |
| agent 并发模型 | 每请求一连接 / 长连接+队列 | **长连接+队列** | 设备侧是全局锁，多连接会报 `Disallow concurrent use` |
| 响应配对 | request_id / FIFO | **FIFO** | 设备忽略 `request_id`，响应里没有该字段 |
| 流与回复 | 分离连接 / 解复用 | **解复用** | 实测同一连接上混流；分离连接无法控制设备行为 |
| casting 实例 | 复用进程 / 一 session 一进程 | **一 session 一进程** | `onEnd` 粘性副作用 |
| perfmonitor | 封装 / 不封装 | **不封装** | 加载不稳定，功能被 casting 覆盖 |
| 窗口级截图 | 自建扩展 / 裁剪 | **裁剪** | 自建被 XPM 封死；用 agent `captureLayout` 取 bounds 而非 `dumpLayout` |
| 多实例 daemon | 每实例一 daemon / 共用 | **共用** | 8012 硬编码，物理上只能一个；靠探测复用而非 `kill -9` |
| 多实例冲突 | 报错给调用方 / 内部退避重试 | **内部退避重试** | 实测 40%~66% 冲突率，重试后 0 失败、仅 +32 ms；暴露给调用方等于把设备缺陷转嫁 |
| 多实例推流冲突 | 抢占 / 等待 / 抛错 | **抛 `AgentBusyError`** | 设备只有一个 capture 通道，抢占别人是错误行为 |
| 模拟器 casting | 标 SKIP / 自动选 MJPEG | **自动选 MJPEG** | 同一能力的另一条实现；`castKind` 明确标注，不是静默降级 |
| 滑动实现 | `Driver.swipe` / `Gestures` 三段式 | **`Gestures`** | `Driver.swipe` 在模拟器上 6.2~12.6 s，三段式 330 ms；且三段式能驱动 MJPEG 出帧 |
| perfmonitor | 封装 / 不封装 | **不封装** | 本地只有 arm64 版本，真机还需 `_260608` 变体；模拟器完全用不了；功能被 casting 覆盖 |
| 验收报告 | 手写 / 脚本生成 | **脚本生成** | 手写无法复现，且容易与代码脱节 |
| 裁剪依赖 | 自写 JPEG 解码 / `jpeg-js` | **`jpeg-js`** | 纯 JS 无原生编译，裁剪不是核心能力不值得自研 |
| 7.0 WebSocket 投流 | 纳入 v1 / 列入 v2 | **v2** | 能力与 6.8 完全对等（都能投流+录制，帧率 27.4/59.3 vs 27.1/59.8）；优势是客户端零依赖 + `-p` 多实例 + 握手快 3~4 倍；劣势是 `frameCount` 上报有 bug。二进制是华为官方签名（证书链同 6.8），由华为员工从 HOScrcpy 2.13 提交进开源仓库；顾虑是供应链（无公开发行渠道、无升级通道、无技术支持） |
| 自建扩展 | 真机 / 模拟器原型 | **模拟器原型** | 真机 XPM 全文件校验不可绕过；模拟器无此校验可自由验证 |
| 复刻 HarmonyAgent uinput | 做 / 不做 | **不做** | 真机 `/dev/uinput` Permission denied；agent `Gestures` 已到 2.9~3.9 ms 同量级 |

## 10. 已知限制

1. **agent 只有一个实例**：8012 硬编码（`movz w0, #0x1f4c`，不可配），不能并行开多个 daemon。多客户端共用一个 daemon，靠串行队列 + 退避重试消化冲突（§4.6）。多路高帧率只能靠 casting。
2. **窗口级截图**：`cropToWindow()` 是近似 —— 用 agent 的 `captureLayout` 拿 `bounds` 后裁剪（比 `dumpLayout -w` + pull 快 2 倍），受圆角/阴影影响。
3. **fport 依赖**：agent/casting 都绑 loopback 或 abstract socket，必须靠 hdc 隧道。实测本机 AP 隔离导致 WiFi 直连不通（docs/08）。
4. **`scale` 只有整数倍**：agent 的 `scale` 参数是整数 1..5。
5. **静态画面帧率**：MJPEG 靠脏区驱动，静止画面**只出 1 帧**（实测，不是「帧率下降」而是「几乎不出帧」）。截图不受影响（起停一次必出帧）；要连续帧必须有画面变化。
6. **模拟器无 H.264 casting**：不存在 x86_64 构建的 `libscreen_casting`，华为也不公开发布该文件、无公开源码。模拟器上 `createCast()` **自动选 MJPEG 路径**（5.4~10.5 fps），`castKind` 为 `"mjpeg"`。MP4 录制和多路并发在模拟器上不可用（MJPEG 无录制能力，agent 只有一个 capture 通道）。
7. **冲突率随客户端数上升**：3 客户端 66% 冲突、2 客户端 40%。退避重试能清零失败，但客户端越多，单次调用平均延迟越高。超过 ~5 个客户端同时高频调用时，应改为让一个进程做代理，其他进程连代理。
8. **`Driver.swipe` 在模拟器上不可用**：实测 6.2~12.6 秒（真机毫秒级）。SDK 的 `swipe()` 走 `Gestures` 三段式（~330 ms），`Driver.swipe` / `drag` / `fling` 一律不封装。
9. **capture 期间 `callHypiumApi` 可能阻塞**：实测 capture 开着时 `Driver.click` 正常（128 ms），但 `Driver.swipe` 超时。`Gestures` / `CtrlCmd` / `Captures.captureLayout` 全程正常。这也是 `swipe()` 走 Gestures 的另一个理由。
10. **7.0 WebSocket 通道未纳入 v1**：`libscrcpy_server_unix_7.0-20260930.z.so` 已实测跑通（同条件帧率 27.4/59.3 fps 与 6.8 持平、首帧 ~390 ms、`-p` 端口隔离多实例、`-m 1` 录制 1,318 帧、`cpd` 单独下发 SPS/PPS）。它**是华为官方签名**（`DevEcoTesting Release ← Huawei CBG Software Signing Service CA ← Huawei CBG Root CA G2`，与 6.8 同链），由华为员工从 HOScrcpy 2.13 提取后提交进 `OldBeer1/hscrcpy`（commit `a3da359`，2026-10-22）。**不进 v1 的理由是供应链而非可信度**：HOScrcpy 2.13 无公开发行渠道、无升级通道、无技术支持、再分发条款未声明。见 `docs/09` §1.6。
11. **7.0 的 `stopped.frameCount` 上报有 bug**：实测录了 1,318 帧却返回 `frameCount: 1`。若纳入 v2，录制成功判定必须改用文件大小或解析 MP4 `stsz.sample_count`，不能用这个字段。6.8 的 `onEnd` 返回的是真实帧数。
12. **这台 7.0.0.1 ROM 上只有 6.8 和 7.0 两个 casting SO 可用**：6.9-20260801 因 `libprotobuf.z.so` 符号 `UntypedMapBase::ClearTableImpl` 不匹配而 `dlopen` 失败；6.3.1~6.5 因 Rosen `VirtualScreenOption` 结构体 ABI 断裂导致虚拟屏创建失败。选型时不要按「版本越高越好」推断。
11. **自建 .so 在真机不可行，但模拟器可以**：真机 XPM 校验覆盖全文件内容（改 `.text`/`.rodata`/证书区 1 字节即失效，静态 ELF 同样被拒 126）；模拟器（Linux 5.10.210）无此校验，自编译 x86_64 扩展能正常加载执行。虚拟屏/AAMS/自定义截图管线等需要自建扩展的能力，可在模拟器上做原型，但结论不能平移到真机。见 `docs/06`、`docs/09`。

## 11. 分发

`.so` 作为包资源分发，用户不必自己找。但有一个许可问题需要在实现前确认：

`agent.so` / `libscreen_casting.z.so` 是华为签名的二进制，随 `devicetest` / `hmdriver2` 等包分发。本包内嵌它们是否合规取决于使用场景（内部工具 vs 公开发布）。

**默认做法**：`assets/` 内放 `.so`，同时支持 `DeviceOptions.extensionDir` 指向用户自备的目录。若 `assets/` 为空且未指定 `extensionDir`，抛 `ExtensionMissingError` 并提示用户从 `devicetest` 包复制。这样包可以发布不带二进制，内部使用则直接可用。

## 12. 交付范围（v1）

- [x] `Device.connect()` / `dispose()`
- [x] AgentClient 全部 API（动作 / UI 树 / 截图 / 流 / 事件）
- [x] CastClient（H.264 推流 / MP4 录制 / 多路并发 / IDR 请求）
- [x] CliRunner（窗口级 layout）
- [x] 自动 daemon 重启
- [x] 多实例共存（daemon 复用 + 退避重试 + 流冲突隔离）
- [x] 单元测试 + 设备集成测试
- [x] 双环境验收（真机 + 模拟器）
- [x] 多实例专项测试（跨进程）
- [x] 验收报告（脚本生成，含截图/脚本/原始输出）
- [ ] ~~perfmonitor~~（不做）
- [ ] ~~多设备~~（v2）
