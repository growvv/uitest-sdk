# 09 · 能力差异与后续路线图

本篇回答三件事：**别人怎么拿到 7.0 的包**、**他们自建 C agent 怎么解决签名**、以及**我们还有哪些能力差距、值不值得补**。

所有实测均为 2026-11-15，真机 `<your-device-id>`（BRA-AL00 / HarmonyOS 7.0.0.111 / uitest 7.0.0.1 / arm64）与模拟器 `127.0.0.1:5555`（HarmonyOS 6.1.1 API 24 / x86_64）。

---

## 一、7.0 的包是从哪来的

### 1.1 三条公开渠道，全都没有 7.0

| 渠道 | 内容 | 有 7.0 吗 |
|---|---|---|
| **HOScrcpy 官方发行版**（gitcode `OpenHarmonyToolkitsPlaza/HOScrcpy`） | `hosScrcpy-1.0.18-beta.jar` → `libscrcpy/` 下 14 个 `.so` | ❌ 最高到 `unix_6.6-20260629` |
| **DevEco Testing 本地安装**（`xdevice_devicetest 6.1.0.210`） | `res/recorder/libscrcpy_server1~4.z.so`（最高 5.7） | ❌ 只有 4 个非 unix 变体，且**在 7.0 真机上不会被选中**（见 [10](10-deveco-testing-analysis.md)） |
| **pip `devicetest`**（`5.0.7.200`） | `res/recorder/libscrcpy_server.z.so` + `_old` | ❌ gRPC 版，无 WebSocket |

HOScrcpy 那个 jar 的完整清单（我实际下载解包确认）：

```
libscrcpy_server0.z.so              3,029,173   gRPC（静态链接）
libscrcpy_server1.z.so              3,041,461   gRPC（静态链接）
libscrcpy_server2.z.so                309,430   gRPC（动态链接）
libscrcpy_server3.z.so                288,950   gRPC（动态链接）
libscrcpy_server_5.10-20260114.z.so   272,567   gRPC
libscrcpy_server_emulator.z.so      2,926,240   gRPC（云手机主屏）
libscrcpy_server_unix_6.3.1-*.z.so    272,567   gRPC + abstract socket
libscrcpy_server_unix_6.4-*.z.so      264,374
libscrcpy_server_unix_6.5-*.z.so      268,469
libscrcpy_server_unix_6.6-20260418    268,471
libscrcpy_server_unix_6.6-20260629    260,278
```

**全部 `WebSocket` 字符串计数 = 0**，全是 gRPC。

### 1.2 hscrcpy 的 7.0 是独立新增的，不是改名

`OldBeer1/hscrcpy` 的 `server/libscrcpy_server_unix_7.0-20260930.z.so` 是在 commit `a3da359d`（2026-10-22）里作为**新文件**加进来的。commit message 原文：

> Add `libscrcpy_server_unix_7.0-20260930.z.so` (WebSocket channel over TCP 5000)
> Verified: 7.0 WebSocket streaming (44 FPS) ... on 8 devices (7 cloud phones + 1 USB)

对比 HOScrcpy jar 里的 `unix_6.6-20260629`（同样 260,278 B）：

```
size 相同: 260,278 = 260,278
差异字节: 222,214 / 260,278 = 85.38%
首处差异: offset 40（ELF 头里的 section offset 字段）
```

→ **不是同一个文件改了名，是另一个构建产物。** 版本串 `7.0-20260930` 是编译进二进制里的（`strings` 可见），不是文件名约定。

### 1.3 结论：命名规则暴露了来源

文件名格式是 `libscrcpy_server_unix_<uitest版本>-<构建日期>.z.so`，与 DevEco Testing 内部的 `res/recorder/` 命名完全一致。`7.0` 对应 uitest 7.x 系列，`20260930` 是构建日期。

**获取途径判断**：

1. **DevEco Testing 新版**（我们本地是 6.1.0.210，只到 server1~4）。7.0 变体随 uitest 7.x 发布，需要更新版本的 DevEco Testing 才有。
2. **HOScrcpy 新版**（我们下载到的 1.0.18-beta jar 是 2026-07-02 构建，7.0 SO 是 2026-09-30 构建，时间对不上）。作者的 `2.13.x` 版本线应该带这个文件，但公开发行版里没同步。
3. **从别人打包好的客户端里抠** —— hscrcpy 自己就是这么来的，`server/` 目录直接进了仓库。

**我们不需要再找了**：`hscrcpy` 仓库里的这个文件已经在真机上跑通（见下），可以直接用。

### 1.5 补充：DevEco Testing 到底是不是「用 7.x 了」

**不是。** 本机装的是 `xdevice_devicetest 6.1.0.210`（2026-11-03 构建），配套 `hypium 6.1.0.210` / `xdevice 6.1.0.210` / `xdevice_ohos 6.1.0.210`。

华为的版本号有两条线，容易混：

| 版本线 | 例子 | 说明 |
|---|---|---|
| **6.1.0.x** | 6.1.0.100 Beta / 6.1.0.200 Release / 6.1.0.211 Release | 本机是 6.1.0.210 |
| **26.0.x** | 26.0.0.500 Release / 26.0.1.100 Beta1 | 2026 年新版本号体系 |

这两条线都**不是**「uitest 7.x」。uitest 是设备侧 `/system/bin/uitest` 的版本（本机 `7.0.0.1`），DevEco Testing 是 PC 侧测试工具，两者的版本号互不对应。

**决定性证据**：DevEco Testing 6.1.0.210 的 `res/recorder/` 只有 4 个 SO，版本串分别是 `5.2-20250226` / `5.6-20250402` / `5.7-20250604` / `5.7-20250708`，**全部是 gRPC，`WebSocket` 计数为 0**，最高只到 5.7。它连 6.x 的 unix SO 都没有，更不用说 7.0。

更严重的是 —— 见 §1.6，这套录制路径在我们这台 7.0 真机上**已经跑不通了**。

### 1.6 DevEco Testing 的录屏在 7.0 真机上已失效（实测）

`record_agent.py` 的 SO 选择逻辑（我逐行读的）：

```python
self.use_unix_socket = self._device.check_if_unix_socket_mode()   # uitest > 6.0.2.1 且非 x86_64 → True
...
for root, dirs, files in os.walk(RESOURCE_PATH/res/recorder):
    for name in reversed(files):
        if not name.startswith("libscrcpy_server"): continue
        if self.use_unix_socket and "unix" not in name: continue   # ← 关键
        elif not self.use_unix_socket and "unix" in name: continue
```

真机 uitest `7.0.0.1` > `6.0.2.1` 且 arm64 → `use_unix_socket = True` → **只挑文件名带 `unix` 的 SO**。而本机 `res/recorder/` 里 4 个文件叫 `libscrcpy_server1~4.z.so`，**一个都不带 `unix`**。

→ 候选列表为空 → `_start_scrcpy_server()` 返回 `False` → 录屏功能直接不可用。

**我做了实测验证**：把 `libscrcpy_server3.z.so` 手工推成 `/data/local/tmp/libscreen_recorder.z.so`，再执行官方那条启动命令：

```sh
uitest start-daemon singleness --extension-name libscreen_recorder.z.so -p 5001 -m 1 -screenId 0
# → exit=0，但进程不驻留，5001 端口不监听，无 abstract socket
```

再检查 hilog，只有 SELinux 的 `Forbid to read parameter musl.ld.debug.dlopen`（shell 域读参数被拒，属正常噪音），**没有 XPM 拒绝记录**，说明这个 SO 本身能加载，是**参数/模式不匹配**导致它没有进入录制循环。

**结论**：DevEco Testing 6.1.0.210 配 HarmonyOS 7.0 真机，录屏是坏的。要用新版 DevEco Testing（26.0.x）才有 7.x 的 unix SO。

> 这也反过来解释了 hscrcpy 为什么要把 7.0 SO 塞进自己仓库 —— 官方工具的这条链路在他们的测试设备上大概率也断了。

### 1.4 7.0 SO 实测（重要，这改变了投流方案）

把 7.0 SO 推到 `/data/local/tmp/libscreen_casting.z.so`，用同样的 `uitest start-daemon` 启动：

```sh
uitest start-daemon singleness --extension-name libscreen_casting.z.so \
  -scale 100 -frameRate 30 -bitRate 8000000 -p 5000 -screenId 0 -encodeType 0
```

| 项 | 6.8 SO（现状） | **7.0 SO（新）** |
|---|---|---|
| 传输 | Unix abstract socket `@scrcpy_grpc_socket` | **TCP 5000**（`netstat` 可见 `0.0.0.0:5000 LISTEN`） |
| 协议 | gRPC + protobuf（需 nghttp2 / HTTP/2） | **RFC6455 WebSocket**（文本命令 + 二进制帧） |
| 客户端依赖 | gRPC 运行时、protobuf 代码生成 | **零依赖**，裸 TCP + 手写帧编解码 |
| 端口隔离 | socket 名固定 → 只能改名并发 | **`-p` 参数隔离** |
| 握手延迟 | 7.8~11.0 ms（gRPC channel ready） | `{"type":"started"}` **1.5~5.0 ms** |
| 首帧延迟 | 90.6~102.5 ms | **62.2~114.1 ms** |
| 并发推流 | 需改 socket 名 | ✅ **5000 + 5001 两路同时出流**（8 s 内 352 / 233 帧） |

> **⚠️ 多实例的边界（2026-11-16 修正）**：`-p` 端口隔离确实让两个 daemon 各占一个端口，但**同一个 daemon 上不能并发两个客户端**。实测：两个 WebSocket 客户端能同时出流（113/113 帧），但 `stop` 是**进程级**的 —— 任一客户端 stop，另一路立刻 0 帧；stop 之后监听 socket 关闭，新客户端永远连不上。所以「多实例」指的是**多个 daemon**，和 6.8 改 socket 名是同一个粒度。SDK 里一个 `WsCastClient` 独占一个 daemon。

#### 同条件帧率对照（2026-11-15，同一台真机、同一段滑动、同一批参数）

| 配置 | 6.8 gRPC | 7.0 WebSocket | 结论 |
|---|---|---|---|
| `-frameRate 30`，15 s | 453 帧 / **30.1 fps** / 76,683 B | 432 帧 / **28.8 fps** / 62,809 B | 持平 |
| `-frameRate 60`，15 s | 982 帧 / **65.3 fps** / 172,518 B | 963 帧 / **64.2 fps** / 173,897 B | 持平 |
| `-frameRate 30`，10 s（2026-11-15 复测） | 272 帧 / **27.1 fps** / 13,363 B | 275 帧 / **27.4 fps** / 13,972 B | 持平 |
| `-frameRate 60`，10 s（2026-11-15 复测） | 599 帧 / **59.8 fps** / 91,113 B | 593 帧 / **59.3 fps** / 92,963 B | 持平 |

**帧率瓶颈在编码器，不在传输层。** 两条通道都能跑满 `-frameRate` 设定值。7.0 的优势不在帧率，而在：客户端零依赖（不用 gRPC/protobuf 运行时）、多实例端口隔离、握手快 3~7 倍。

> 早先记录的「7.0 是 44.3 fps」是在 `-frameRate 30` 下测的短窗口（含首帧等待摊薄），同条件复测后两者都是 28.8~30.1 fps。**不要用帧率作为选型依据。**

协议（`strings` + 实测逐条验证）：

```
握手:  GET / + Upgrade: websocket + Sec-WebSocket-Protocol: scrcpy → 101
       （子协议头是必需的，不带会被拒）
文本:  {"type":"start"}       → {"type":"started"}
       {"type":"requestIDR"}  → {"type":"idrResponse","result":0}   实测 9 ms
       {"type":"stop"}        → {"type":"stopped","frameCount":N}   ← 6.8 没有，要额外调 onEnd
二进制: 4 字节大端长度前缀 + H.264 Annex-B payload
       （前缀 = payload 长度 − 4，118/118 帧实测一致）
```

NAL 类型实测：`{1:114, 5:2, 7:2, 8:2}` —— SPS/PPS 在带内，和 6.8 一样跟着关键帧走。

**两个 7.0 独有的协议改进**：

1. **`stop` 直接返回 `frameCount`** —— 6.8 的 `onEnd` 是独立 RPC，且**有粘性副作用**（调用后该进程永远出不了帧）。7.0 的 `stop` 把帧数和停止合成一条消息，语义更干净。
2. **`cpd` 单独下发 SPS/PPS** —— ⚠️ **格式串在二进制里，但实测收不到**。10 s 有画面变化、195 个二进制帧的过程中只收到过 `started`；start-then-idr / idr-before-start / 空闲 12 s 三种顺序都试过，`cpd` 一次都没出现。**不要依赖它**，解码器初始化照旧看第一个关键帧。

#### `-m 1` 录制在 7.0 上同样可用

```sh
uitest start-daemon singleness --extension-name libscreen_casting.z.so \
  -scale 100 -frameRate 30 -bitRate 8000000 -p 5000 -m 1 -screenId 0
```

实测（2026-11-15 复测，带 12 s 连续滑动）：

```
start 后不出二进制帧（binframes: 0）→ 走 muxer，不走推流
stop  → {"type":"stopped","frameCount":1}     ← 这个 1 是假的，见下
落盘  → /data/local/tmp/mytest.mp4  235,308 B
解析  → moov/mvhd: timescale=1000 duration=11641  → 11.64 s
        stbl/stsz: sample_count = 1,318        → 实际 1,318 帧
OpenCV → 1216×2688, 1318 帧, 可正常解码
```

**⚠️ 7.0 的 `frameCount` 在录制模式下有 bug**：录制 1,318 帧却报 `frameCount: 1`（多次复现：193 / 1,318 帧都报 1）。推流模式下上报正常。**做录制时不要用 7.0 的 frameCount 判断成败**，要检查文件大小或解析 `stsz.sample_count`。

**⚠️ 录制也不是「持续写帧」**（2026-11-16 修正）：8 s 不动屏，6.8 和 7.0 **都是 259 B / 0 帧 / 无 sample**。两者都是脏区驱动。之前「7.0 的 muxer 持续写帧」的结论是错的 —— 那次测的 11.64 s 全程有滑动。

**⚠️ 录制文件的写入时机**：`start` 之后 muxer 立刻创建 259 B 的头，样本在 `stop` 时才落盘（实测 140 KB）。所以**不能看到文件非零就 pull**，要等大小稳定（SDK 的 `waitForFile` 就是这么做的）。

> **对方案的影响**：真机上有 7.0 SO 时，应把它作为 H.264 的首选通道 —— 少一层 HTTP/2 栈，多实例免费，客户端实现量从「gRPC 运行时」降到「一个 WebSocket 帧编解码器」。
>
> 但注意：7.0 SO 不在任何华为公开发行渠道里，只能从 hscrcpy 仓库取（来源分析见 1.6）。6.8 那条 gRPC 路径必须保留。

### 1.5 版本矩阵：这台 7.0.0.1 真机上哪些能跑（2026-11-15 全量实测）

hscrcpy 的 `server/` 目录里 12 个版本，逐个推到 `<your-device-id>` 上试：

| SO | 大小 | 协议 | 加载 | 投流 | 录制 |
|---|---|---|---|---|---|
| `unix_6.3.1-20260113` | 272,567 | gRPC | ✅ | ❌ 虚拟屏 ABI 断裂 | ❌ |
| `unix_6.4-20260113` | 264,374 | gRPC | ✅ | ❌ 同上 | ❌ |
| `unix_6.5-20260313` | 268,469 | gRPC | ✅ | ❌ 同上 | ❌ |
| `unix_6.6-20260418` | 268,471 | gRPC | 未测 | 未测 | 未测 |
| **`unix_6.8-20260801`** | **247,989** | **gRPC** | ✅ | ✅ 27.1/59.8 fps | ✅ 97 帧 |
| `unix_6.9-20260801` | 239,799 | gRPC | ❌ **protobuf 符号不匹配** | ❌ | ❌ |
| **`unix_7.0-20260930`** | **260,278** | **WebSocket** | ✅ | ✅ 27.4/59.3 fps | ✅ 1,318 帧 |

6.9 的失败原因（`hilog`）：

```
E UiTestKit_Addon: Dlopen ... failed: Error relocating:
  _ZN6google8protobuf8internal14UntypedMapBase14ClearTableImplEb: symbol not found
```

6.9 依赖的 `libprotobuf.z.so` 比这台 ROM 里的新。**6.8 是这台 ROM 上能用的最新 gRPC 版。**

**只有 6.8 和 7.0 可用**，且两者能力完全对等（都能投流、都能录制）。选型只看客户端实现成本，不看功能。

### 1.6 7.0 SO 的真实来源：华为员工提交，从 HOScrcpy 2.13 提取

之前判断「来源不可控」是**不准确的**。查完整 git 历史后：

**提交链**（`OldBeer1/hscrcpy`，97 个提交，未 shallow）：

| 提交 | 日期 | 作者 | 说明 |
|---|---|---|---|
| `c9b13cd` | 2026-09-24 | PengXiaochuan `<xiaochuanpxc@163.com>` | `feat: add HOScrcpy 2.12.9 server SO 6.8/6.9-20260801` ← **6.8/6.9 明确标注来自 HOScrcpy 2.12.9** |
| `a3da359` | 2026-10-22 | pengxiaochuan `<pengxiaochuan1@huawei.com>` | `feat: add 7.0 WebSocket streaming channel...` ← **7.0 SO 由华为员工提交**，说明写「Implements HOScrcpy 2.13-aligned capture」 |

仓库提交者邮箱分布：

```
58  xiaochuanpxc@163.com                     ← 个人邮箱
37  pengxiaochuan1@huawei.com                ← 华为员工邮箱（含 7.0 SO 那次提交）
2   160984937+OldBeer1@users.noreply.github.com
```

**签名证书链**（三个版本完全一致，说明同一签名服务）：

```
DevEcoTesting Release
  └── Huawei CBG Software Signing Service CA
        └── Huawei CBG Root CA G2
```

证书体长度 10,389~10,390 B，`ver=1`，与 6.5/6.8 同一格式。证书里的 CRL 地址指向 `cpki-caweb.huawei.com`。

**结论修正**：

- 7.0 SO **是华为官方签名的构建产物**，签名链是 `DevEcoTesting Release` —— 和 6.5/6.8 同一条签名流水线
- 它不是伪造/重打包的：签名覆盖全文件（见 [06](06-signing-xpm.md)），改一个字节就失效，所以能加载本身就证明它未被篡改
- 它来自 **HOScrcpy 2.13**（华为内部/合作方的投屏组件），通过一位华为员工提交进了 hscrcpy 开源仓库
- **不是「来源不可控」，而是「来源是 HOScrcpy 2.13，但 HOScrcpy 2.13 本身没有公开发行」**

**剩余风险**（这才是真正的顾虑）：

| 风险 | 说明 |
|---|---|
| **版本漂移** | 我们拿到的是 2.13 的某一个构建（2026-09-30）。后续 HOScrcpy 升级，我们无法跟进 |
| **无升级通道** | 华为不发这个文件，只能等有人再提交到开源仓库 |
| **无技术支持** | 出问题只能自己逆向 |
| **许可证不明** | hscrcpy 仓库是 MIT，但 SO 是华为的二进制，再分发条款未声明 |

这些是「**供应链风险**」，不是「二进制不可信」。两者要分开看。

---

## 二、他们自建 C agent 的签名问题 —— 答案是「没解决」

### 2.1 HarmonyAgent 根本不是 .so

`harmony_agent.c` 的构建命令是：

```sh
aarch64-linux-gnu-gcc -o harmony_agent harmony_agent.c -static
```

产物是**静态链接的独立 ELF 可执行文件**，部署到 `/data/local/tmp/harmony_agent`，用 `nohup ... &` 跑起来。它**不走 `dlopen`**，所以完全不碰 uitest 扩展的 XPM 校验路径。

### 2.2 他们的代码里没有任何签名逻辑

`MirrorService.swift` 的 `deployAndStartAgent()` 失败时只打一行日志然后 `return false`：

```swift
"HarmonyAgent may not have started on \(serial) (binary needs aarch64 cross-compilation)"
```

然后静默回退到 `hdc uinput`。他们的 README 也写得很清楚：「HarmonyAgent（优先）/ hdc uinput（回退）/ 自动切换」。

签名相关代码只有两处，**都只签 HAP**：

- `deployment/SensitiveSigner.java` —— `sign-app` + `-mode localSign` + `hap-sign-tool.jar`
- `deployment/phone-tools.mjs` —— 同一个 `hap-sign-tool.jar`，`signingInvocation(..., 'sign-app')`

**结论：他们没有解决签名问题，HarmonyAgent 在受限 ROM 上就是跑不起来的，只是被静默回退了。**

### 2.3 我们真机上的决定性实验

在 `<your-device-id>` 上做了完整对照（`/data/local/tmp`，`chmod 755`）：

| 变体 | 内容 | 结果 |
|---|---|---|
| `t1_copy.so` | `agent.so` 原样复制 | ✅ **Signal 11**（执行了） |
| `t2_trunc.so` | `agent.so` 砍掉尾部 32 B 签名块 | ❌ `Permission denied` exit=126 |
| `t3_append.so` | 我们自编译静态 ELF + 追加那 32 B 签名块 | ❌ exit=126 |
| `t4_text.so` | `agent.so` **改 .text 里 1 个字节** | ❌ exit=126 |
| `t5_rodata.so` | `agent.so` **改 .rodata 里 1 个字节** | ❌ exit=126 |
| `t6_cert.so` | `agent.so` **改证书区 1 个字节** | ❌ exit=126 |
| `probe_static` | 自编译静态 ELF，无签名 | ❌ exit=126 |

**三条硬结论**：

1. **签名覆盖整个文件内容** —— `.text`、`.rodata`、连证书区本身改一个字节都失效。所以「嫁接签名块」这条路彻底死掉。
2. **签名块不是可有可无的尾巴** —— 砍掉就失效，说明它是校验的输入而不只是标记。
3. **静态 ELF 和 .so 受同一套校验** —— 未签名的独立可执行文件同样被拒（126），所以「绕开 dlopen 走独立进程」在真机上**也不成立**。

补充环境证据：`/data` 挂载是 `hmfs rw,nosuid,nodev`（**没有 noexec**），`/` 是 `erofs (ro)`。所以 126 不是文件系统限制，是内核代码完整性校验。

### 2.4 但模拟器上没有这道校验

同一份自编译扩展，在模拟器上**能加载、能跑**：

```sh
# x86_64 自编译，只有 UiTestExtension_OnInit / OnRun 两个导出
uitest start-daemon singleness --extension-name ext_x86.so
→ /data/local/tmp/ext_ran.txt 里写入了 "EXT_RAN"
```

| 环境 | 内核 | 未签名 .so 扩展 | 未签名静态 ELF |
|---|---|---|---|
| 真机 BRA-AL00 | HongMeng Kernel 1.13.0 | ❌ XPM 拒绝 | ❌ 126 |
| 模拟器 | Linux 5.10.210 | ✅ **正常加载** | ✅ 正常执行 |

**这是本轮最有价值的发现之一**：模拟器上 XPM 不存在，意味着**可以在模拟器上自建扩展做能力验证和原型**（比如虚拟屏、AAMS、自定义截图管线），只是不能上真机。

### 2.5 真机上唯一可行的自建路径：HAP + 自动签名

hscrcpy 的音频采集给了现成范例：`audio-companion/` 是一个标准 HAP 工程，里面带 `arm64-v8a/libaudio_capture.so`（native 代码），通过 **DevEco Studio 用本机华为账号自动生成调试签名**后 `hdc install -r` 安装，native 代码就跑在应用沙箱里。

| 路径 | 需要什么 | 能做什么 | 不能做什么 |
|---|---|---|---|
| uitest 扩展 `.so` | Huawei CBG 签名 | 扩展 uitest 进程 | 拿不到 |
| 独立 ELF | 同上 | 独立进程 | 拿不到 |
| **HAP + 自签名** | **自己的华为账号** | 应用沙箱内的 native 代码、应用权限、无障碍服务 | 碰不到 `/dev/uinput`，碰不到 uitest 内部 |

`/dev/uinput` 实测：真机 `Permission denied`，模拟器 `No such file`。所以 **HarmonyAgent 的 uinput 方案在我们的设备上本来就走不通**，签名只是第二道墙。

---

## 三、能力差异清单（后续可做）

按「值不值得做」排序。✅=已有等价能力，⏳=可做，❌=硬边界。

### P0 · 已实测可行，建议纳入

| 能力 | 他们怎么做 | 我们的现状 | 判断 |
|---|---|---|---|
| **7.0 WebSocket 投流** | RFC6455 + 4B 长度前缀 H.264 | ✅ **SDK 0.6.0 已支持**（`transport: "ws"`），客户端零 gRPC 依赖。见 1.4 |
| **投流多实例** | 7.0 用 `-p` 端口隔离 | 6.8 要改 socket 名 | ⏳ 5000/5001 双 daemon 已验证；**同一 daemon 不能并发**（stop 是进程级） |
| 单张截图 | agent MJPEG | 已实现 178 ms | ✅ 已覆盖 |
| UI 树 / 布局 | `captureLayout` | 已实现 473 ms | ✅ 已覆盖 |
| 触摸输入 | HarmonyAgent uinput（<2ms，但真机跑不起来） | agent `Gestures` 2.9~3.85 ms | ✅ 同一量级，且更稳 |
| 键盘输入 | 英文 uinput / 中文 `uiInput inputText`（两套） | 统一 `Driver.inputText` | ✅ 更统一 |
| 唤醒屏幕 | HarmonyAgent | `Driver.triggerKey(26)` 134 ms | ✅ 已覆盖 |

### P1 · 可做，收益明确

状态按 0.9.0 的实际交付物核对过一遍：✅ 是「已经能用」，⏳ 是「还差一截」。

| 能力 | 他们怎么做 | 我们的现状 |
|---|---|---|
| **UI 布局检查面板 + 节点高亮** | `dumpLayout` 建树 + 在画面上按 `bounds` 叠色块 | ✅ `inspect` 出带框和编号的 JPEG（编号即 ref）+ 自包含 HTML 面板；`live` 页面按角色给框、点选复制。见 [13](13-stage-log.md) |
| **文件管理器** | hdc `file send/recv` + `ls` / `rm` / `mkdir` / `mv` | ✅ `dev.files`：`list` / `stat` / `exists` / `mkdir` / `remove` / `move` / `push` / `pull` / `readText` |
| **参数配置 + INI 持久化** | `hscrcpy.ini`，缩放/码率/帧率/端口 | ✅ `CastConfig`（`<state-dir>/cast.json`），字段与 `start-daemon` 的 `-scale/-bitRate/-frameRate/-p` 一一对应；格式是 JSON 不是 INI |
| **实时帧率显示** | 客户端统计帧间隔 | ✅ `live` 页头的 fps 读数（浏览器侧按解码后的帧计）；SDK 侧另有 `FpsMeter` 供调用方自己统计 |
| **码率上限 120 Mibps** | `-bitRate` 透传 | ✅ `CastOptions.bitRate` / `CastConfig.bitRate` 原样透传给 `OH_MD_KEY_BITRATE`，无上限限制；`live` 暂无 `--bit-rate` 旗标，走配置或 API |
| **截图/录屏按钮** | `snapshot_display` / casting `-m 1` | ✅ `live` 页头的 Shot / Record 按钮。截图走 `Session.observe({ out })`，所以隐私遮罩与节点表同一套；录屏起一个独立的 record daemon（grpc 用自己的 socket、ws 用端口 +1），不打断画面 |
| **触摸注入（点击 / 长按 / 拖动 / 滚动 / 双指）** | scrcpy 控制协议：`down/move/up`、多指 pointer id | ✅ `live` 页「接管」后的画布；独立写通道，实测点击 p50 3.2 ms、p95 24 ms，整轮混合输入 p50 290 ms。见 [13](13-stage-log.md) |
| **键盘输入与系统键** | `injectText` + 按键映射 | ✅ 写通道的 `text` / `key`：停顿 300 ms 整段落字，拼音组合期间不上屏；`back` 只弹一层，`home` 回桌面 |
| **剪贴板粘贴** | `Ctrl+V` → 读本机剪贴板 → `Driver.inputText` | ✅ `type --paste` / `Session.type(…, { paste: true })`。实测 36 字符 1325 ms 对逐字符 2761 ms，中文与 emoji 完整。注意 `InputTextMode.addition` 在 `Driver.inputText` 路径上是空操作（只在 `Component.inputText` 上追加），所以没有对外暴露 |

### P2 · 有工作量，看需求

| 能力 | 他们怎么做 | 我们的判断 |
|---|---|---|
| **渲染层（D2D / VideoToolbox / 零拷贝 / 帧池）** | 纯客户端优化 | ⏳ 我们是 SDK 不负责渲染；可提供「解码后 YUV/RGB 帧」的回调，由调用方决定渲染方式 |
| **H.264 软解兜底** | FFmpeg 软解 | ⏳ 交付「Annex-B NAL 流」即可，解码交给调用方（Node 侧可用 WebCodecs / wasm ffmpeg） |
| **音频转发** | 自建 HAP 采集（`audioRecording` 后台模式）+ hdc rport 回传 | ⏳ 需要用户自己的华为账号签 HAP，见 2.5。SDK 可以封装「安装/启动/收流」三段 |
| **多窗口 / 多设备同时投** | 每设备一套 SO + 端口 | ⏳ 7.0 端口隔离后已具备基础，多设备各自 fport 即可 |
| **录制 MP4** | casting `-m 1` | ✅ 已封装：`createCast({ mode: "record", outputPath })`，`dispose()` 时把设备侧文件拉回本机 |

### P3 · 硬边界，做不了

| 能力 | 原因 |
|---|---|
| **云手机模拟面板**（电池 / GNSS / Haps / 国际化 / 传感器） | 实测本机 ROM 无 `battery_simulator`、无 `gnss_simulator`、`bm` 无 permission 子命令、`aa` 无 grant、传感器只有只读 `hidumper`。这是云手机 CPH 平台能力，不是普通真机 ROM 的。见 [05](05-capability-matrix.md) |
| **自定义虚拟屏** | 需要自建扩展调 Rosen `CreateVirtualScreen`，真机被 XPM 封死（见 2.3） |
| **AAMS 快速取节点** | `Driver.setAamsWorkMode` / `openAamsEvent` / `closeAamsEvent` 在两个 agent 二进制里都不存在（`strings | grep -c Aams` = 0），需更高版本 agent.so |
| **无障碍服务完整交互面** | agent 只暴露 `accessibilityId` 属性，没有服务枚举 / 事件流 |
| **完全脱离 hdc** | agent 绑 `127.0.0.1:8012`，casting 6.8 绑 abstract socket；7.0 虽绑 `0.0.0.0:5000`，但本机 AP 隔离（主机与设备同网段互 ping 100% 丢包、ARP 表无对方） |
| **真机自建 .so / 独立 ELF** | XPM 校验覆盖全文件内容，无法嫁接（见 2.3） |

### 已确认「不需要补」

| 项 | 理由 |
|---|---|
| perfmonitor | 加载不稳定（`perfmonitor.so` 缺 `ResizeVirtualScreen` 符号），能力被 casting 完全覆盖 |
| 自建 C 输入 agent | 真机 `/dev/uinput` Permission denied；agent `Gestures` 已到 2.9 ms 同一量级 |
| HOScrcpy 的另外 10 个 SO 变体 | 全是 gRPC 且功能集不优于 6.8 |

---

## 四、如果要做，先后顺序

1. ~~**7.0 WebSocket 通道**（P0）~~ —— ✅ 已完成（0.6.0，`transport: "ws"`）。7.0 SO 不打包，由调用方提供路径。
2. ~~**布局检查 + 节点高亮**（P1）~~ —— ✅ 已完成（0.7.0 的 `inspect` 与 `live`）。
3. ~~**文件管理器 / 配置持久化 / 帧率显示**（P1）~~ —— ✅ 已完成（0.7.0，`dev.files` / `CastConfig` / `FpsMeter`）。
4. ~~**`live` 页的截图与录屏按钮**（P1 余项）~~ —— ✅ 已完成（0.8.0）。截图复用了会话的遮罩规则；录屏必须另起一个 daemon，因为 `onStart` 在一个进程里只能开一次。
5. ~~**`live` 页的点击交互**（P1 余项）~~ —— ✅ 已完成（0.9.0）。默认只读、点「接管」才注入；输入走第二条通道（独立 fport 与 agent 连接），不排在读布局后面。点击 / 长按 / 拖动 / 滚动 / 双指 / 键盘 / 返回 / Home 全部对齐 scrcpy。第二个页面会被明确拒绝，10 s 无输入或出错自动回只读。见 [13](13-stage-log.md)。
6. ~~**多设备同时投屏**（P1 余项）~~ —— ✅ 已完成（0.8.0）。每台设备一个 `live` 进程、端口分开；`pidof` 按 target 走，状态文件按设备 tag 分。顺带修了两个同设备多实例的真问题：daemon 归因改用 `ps -ef` 的 argv（不再盲杀别人的进程），租约的同名 task 重入要求 pid 相同。见 [13](13-stage-log.md)。
7. **音频转发**（P2）—— 需要用户华为账号签 HAP，走 hscrcpy 已验证的路。
8. **模拟器自建扩展**（探索性）—— 模拟器无 XPM，可以在这里做虚拟屏 / AAMS 的原型验证，但结论不能平移到真机。

## 五、发版记录与下一次的计划

### 0.8.0（已发，2026-11-16）

npm `uitest-sdk@0.8.0`、tag `v0.8.0`、GitHub Release 与官网同一时间上线。进这一版的：
`live` 页的截图与录屏按钮、`CastOptions.durationMs` 生效、`test/` 与 `scripts/` 纳入类型检查、
`type --paste`、验收报告去掉明文设备序列号、多实例归因与租约修复。

发版过程本身抓出三个问题，都已修掉并留了测试：`resume` 放不掉人的 hold（pid 规则误伤没有
所属进程的租约）、`triggerKey` 按电源键锁屏导致后续截图全是通知栏、以及第一次把它归因成
「没清通知栏」的错误诊断。细节见 [13](13-stage-log.md)。

### 下一次发版的步骤

1. `npm version <x.y.z>`，并把 `docs/13-stage-log.md` 里所有 `（未发版）` 改成 `（x.y.z）`；
   顺带检查本文件里有没有同样过期的「未发版」。
2. 在真机上跑一遍验收，两个脚本都要过：
   - `npm run acceptance:handoff` —— 接管闭环（handoff → `lease_held` → `resume` → 续跑）。
   - `npx tsx scripts/acceptance.ts --targets <id>` —— 全部能力表，重写 `docs/acceptance/`。
     它会覆盖 51 个已入库的证据文件（截图、日志、`report.md`），这是有意的：报告是生成物，
     不是手写的，版本之间必须能复现。

   **跑之前先把设备收拾干净**，截图是会公开发布的：
   - 解锁、屏幕常亮（否则 `streamScreen` 收不到帧，卡在 `cropToWindow` 之后）。
   - 打开一个中性的公开页面（设置首页、知乎热榜这类），别停在聊天界面或通知栏。
   - 0.8.0 起脚本自己会挡一道：每个能力截图前检查屏幕是否锁着，能解锁就解锁，解不开
     （有 PIN）就中止。根因是 `triggerKey` 那一步按电源键会锁屏，之后所有截图都拍在锁屏上
     ——2026-11-16 两次验收都栽在这里，第二次截到的是账户变动与个人消息，整个目录回滚。
   - 但页面内容脚本管不了：跑完把截图逐张看过再提交，这一步不能省。

   跑完 `git diff --stat docs/acceptance/`：`scripts/` 下的 `.ts` 只应有行尾差异
   （`--ignore-cr-at-eol` 后为空），`report.md` 的差异应只有耗时与节点数。
3. `npm publish`（用 bypass 2FA 的 granular token，npmrc 放仓库外，用完删）。
   注意 PUT 会返回 **202 Accepted** 而不是 201：那是 staged publishing，元数据先出现、
   tarball 晚几十秒才可下载，`npm view` 一开始查不到属正常。
   - `npm run acceptance:handoff` —— 接管闭环（handoff → `lease_held` → `resume` → 续跑）。
   - `npx tsx scripts/acceptance.ts --targets <id>` —— 全部能力表，重写 `docs/acceptance/`。
     它会覆盖 51 个已入库的证据文件（截图、日志、`report.md`），这是有意的：报告是生成物，
     不是手写的，版本之间必须能复现。

   **跑之前先把设备收拾干净**，截图是会公开发布的：
   - 解锁、屏幕常亮（否则 `streamScreen` 收不到帧，卡在 `cropToWindow` 之后）。
   - 打开一个中性的公开页面（设置首页、知乎热榜这类），别停在聊天界面或通知栏。
   - 0.8.0 起脚本自己会挡一道：每个能力截图前检查屏幕是否锁着，能解锁就解锁，解不开
     （有 PIN）就中止。根因是 `triggerKey` 那一步按电源键会锁屏，之后所有截图都拍在锁屏上
     ——2026-11-16 两次验收都栽在这里，第二次截到的是账户变动与个人消息，整个目录回滚。
   - 但页面内容脚本管不了：跑完把截图逐张看过再提交，这一步不能省。

   跑完 `git diff --stat docs/acceptance/`：`scripts/` 下的 `.ts` 只应有行尾差异
   （`--ignore-cr-at-eol` 后为空），`report.md` 的差异应只有耗时与节点数。
3. `npm publish`（用 bypass 2FA 的 granular token，npmrc 放仓库外，用完删）。
   注意 PUT 会返回 **202 Accepted** 而不是 201：那是 staged publishing，元数据先出现、
   tarball 晚几十秒才可下载，`npm view` 一开始查不到属正常。

---

## 六、本篇的实验产物

| 文件 | 说明 |
|---|---|
| `/tmp/probe_elf/probe_static` | 自编译 aarch64 静态 ELF（840,016 B） |
| `/tmp/probe_elf/probe_x86` | 自编译 x86_64 静态 ELF |
| `/tmp/probe_elf/ext_x86.so` | 自编译 x86_64 uitest 扩展（10,624 B），模拟器加载成功 |
| `/tmp/probe_elf/t1_copy.so` ~ `t7_same.so` | 签名对照实验的 7 个变体 |
| `/tmp/probe_elf/agent.so` | 从真机拉回的签名 agent.so（600,246 B） |
| `/tmp/hsc2/` | hscrcpy 源码 + `server/` 全部 SO |
| `/tmp/hosjar/` | HOScrcpy 官方发行 jar 解包（`libscrcpy/`） |

复现签名实验：

```sh
HDC='.../hdc.exe'
for f in t1_copy.so t2_trunc.so t3_append.so t4_text.so t5_rodata.so t6_cert.so; do
  $HDC file send $f /data/local/tmp/$f
  $HDC shell "chmod 755 /data/local/tmp/$f; cd /data/local/tmp; ./$f 2>&1 | head -c 120"
done
# 只有 t1_copy.so 出 Signal 11，其余全部 Permission denied (126)
```

复现模拟器自建扩展：

```sh
$HDC -t 127.0.0.1:5555 file send ext_x86.so /data/local/tmp/ext_x86.so
$HDC -t 127.0.0.1:5555 shell "chmod 755 /data/local/tmp/ext_x86.so; \
  uitest start-daemon singleness --extension-name ext_x86.so; \
  cat /data/local/tmp/ext_ran.txt"     # → EXT_RAN
```
