# 10 · DevEco Testing 分析：两个版本、SO 清单、能力面

本篇回答：**DevEco Testing 是不是用 7.x 了**、**26.x 和 6.1.0.x 差在哪**、**它有哪些能力**、**它的 SO 能不能被 uitest 当扩展加载**。

分析对象（两个版本都实测过）：

| 版本 | 位置 | 状态 |
|---|---|---|
| **6.1.0.210** | `D:\Application\DevEco Testing`（构建 2026-11-03） | 已安装 |
| **26.0.1.100** | 同上目录 —— 2026-11-15 重装后确认与安装包 **8670/8670 文件 CRC 全部一致** | 已安装（PE 版本号 `26.0.1.100`） |

> **版本号怎么读**：`D:\Application\DevEco Testing\bin\DevEco Testing.exe` 的 PE `ProductVersion` = `26.0.1.100`；但内部 python 包的 `dist-info` 仍是 `xdevice_devicetest-6.1.0.210`。**26.0.x 是外壳版本号，6.1.0.210 是 python 测试框架版本号** —— 两条线，同一套件。

真机基线：`<your-device-id>`（BRA-AL00 / HarmonyOS 7.0.0.111 / uitest **7.0.0.1** / arm64）。

---

## 一、版本：不是 uitest 7.x

```
xdevice_devicetest  6.1.0.210     ← python 框架
hypium              6.1.0.210
xdevice             6.1.0.210
xdevice_ohos        6.1.0.210
--- 外壳 ---
DevEco Testing      26.0.1.100    ← PE ProductVersion
```

华为的版本号有三条**互不相关**的线：

| 版本线 | 实例 | 说明 |
|---|---|---|
| **6.1.0.x** | 6.1.0.100 / 6.1.0.200 / **6.1.0.210** / 6.1.0.211 | python 测试框架 |
| **26.0.x** | 26.0.0.500 / **26.0.1.100** | PC 侧产品外壳（2026 新体系） |
| **uitest x.y.z** | 真机 `7.0.0.1` | **设备侧** `/system/bin/uitest` 的版本 |

三者不同源。**「DevEco Testing 用了 7.x」这个前提不成立** —— 它指的是 uitest 设备侧版本，不是 PC 工具版本。

---

## 二、26.0.1.100 的 SO 清单：13 个，最高 6.5

26.x 的安装包是自解压 PE，内嵌一个 8670 项的 zip。全部 SO 在 `python/Lib/site-packages/devicetest/res/` 和 `app/resources/tools/demoWithoutRecord.jar` 内嵌的 `lib/hosScrcpy-1.0.17.12-java21-SNAPSHOT-shaded.jar` 里。

### 2.1 python 侧（`devicetest/res/`，5 个）

| 路径 | 文件 | 大小 | 版本串 | 协议 | 签名 |
|---|---|---|---|---|---|
| `res/recorder/` | `libscrcpy_server1.z.so` | 3,041,461 | `5.2-20250226` | gRPC（静态链接） | ✅ |
| | `libscrcpy_server2.z.so` | 309,430 | `5.6-20250402` | gRPC | ✅ |
| | `libscrcpy_server3.z.so` | 288,950 | `5.7-20250604-dev` | gRPC | ✅ |
| | `libscrcpy_server4.z.so` | 264,374 | `5.7-20250708` | gRPC | ✅ |
| `res/prototype/native/` | `uitest_agent_v1.1.3.so` | 149,685 | — | TCP 8012 | ✅ |
| | `uitest_agent_v1.1.5.so` | 153,781 | — | TCP 8012 | ✅ |
| | `uitest_agent_v1.1.10.so` | 600,246 | — | TCP 8012 | ✅ |
| | `uitest_agent_v1.2.2.so` | 600,245 | — | Unix abstract socket | ✅ |
| | `uitest_agent_v1.1.9.x86_64_so` | 1,460,181 | — | TCP 8012 | ❌ **未签名**（模拟器） |

### 2.2 Java 侧（`hosScrcpy-1.0.17.12` jar，8 个）★ 新增

**这批 SO 在 6.1.0.210 里完全没有** —— 这是 26.x 真正的增量：

| 文件 | 大小 | 版本串 | 协议 | 签名 | md5 |
|---|---|---|---|---|---|
| `libscrcpy_server1.z.so` | 3,041,461 | `5.2-20250226` | gRPC | ✅ | `b067813b…` |
| `libscrcpy_server2.z.so` | 309,430 | `5.6-20250402` | gRPC | ✅ | `474ba825…` |
| `libscrcpy_server3.z.so` | 288,950 | `5.7-20250604-dev` | gRPC | ✅ | `0b4e4e5a…` |
| `libscrcpy_server_5.10-20260114.z.so` | 272,567 | `5.10-20260114` | gRPC（无 unix socket） | ✅ | `8cb4ed24…` |
| `libscrcpy_server_emulator.z.so` | 2,926,240 | `4.8-20241009` | gRPC（静态链接） | ❌ | `f0d647ac…` |
| **`libscrcpy_server_unix_6.3.1-20260113.z.so`** | 272,567 | `6.3.1-20260113` | gRPC + abstract socket | ✅ | `63180e8c…` |
| **`libscrcpy_server_unix_6.4-20260113.z.so`** | 264,374 | `6.4-20260113` | gRPC + abstract socket | ✅ | `15309654…` |
| **`libscrcpy_server_unix_6.5-20260313.z.so`** | 268,469 | `6.5-20260313` | gRPC + abstract socket | ✅ | `d20b1ff0…` |

### 2.3 与 hscrcpy 仓库的差异

hscrcpy（OldBeer1）的 `server/` 目录有 18 个文件，26.x 只覆盖到 **6.5**。hscrcpy 多出：

```
libscrcpy_server0.z.so                 4.6-20240912   静态链接 gRPC
libscrcpy_server_unix_6.6 ~ 6.9        6.6 ~ 6.9      gRPC + abstract socket
libscrcpy_server_unix_7.0-20260930     7.0-20260930   ★ WebSocket（唯一有 7.0 的渠道）
```

**关键：26.x 也没有 7.0 WebSocket SO。** 6.1.0.210 没有 unix 变体，26.x 补到了 6.5，但 7.0 仍然只在 hscrcpy 仓库里。

### 2.4 `unix_*` 三个变体的真实用途

`unix_6.3.1` / `6.4` / `6.5` 三个文件里都有这两个 socket 名：

```
scrcpy_grpc_socket          ← 投流
screen_record_grpc_socket   ← 录屏
```

也就是说它们是 **casting + recording 二合一**，靠 `-m 1` 切换模式。Java 侧 `VideoRecorder.class` 的字符串直接印证：

```
libscrcpy/libscrcpy_server1.z.so
libscrcpy/libscrcpy_server2.z.so
libscrcpy/libscrcpy_server3.z.so
libscrcpy/libscrcpy_server_5.10-20260114.z.so
libscrcpy/libscrcpy_server_unix_6.3.1-20260113.z.so
libscrcpy/libscrcpy_server_unix_6.4-20260113.z.so
libscrcpy/libscrcpy_server_unix_6.5-20260313.z.so
/system/bin/uitest start-daemon singleness --extension-name libscreen_recorder.z.so -p %d -m 1 -screenId %s
fport tcp:%d localabstract:screen_record_grpc_socket
```

**注意：`-encodeType` 不在 Java 侧的命令里。** 实测（见 4.3）证明它对录制是否成功**没有影响** —— 带不带都能录。Java 侧的 `HosRemoteConfig` 有 `setEncoderType`，但录制路径没传，也不需要传。

---

## 三、SO 能否被 uitest 当扩展加载：**能，全部都能**

逐个检查 `UiTestExtension_OnInit` / `UiTestExtension_OnRun` 两个必需导出：

| 文件 | OnInit | OnRun | 签名 | arch |
|---|---|---|---|---|
| `libscrcpy_server1~4.z.so` | ✅ | ✅ | ✅ | aarch64 |
| `libscrcpy_server_5.10` / `unix_6.3.1` / `6.4` / `6.5` | ✅ | ✅ | ✅ | aarch64 |
| `libscrcpy_server_emulator.z.so` | ✅ | ✅ | ❌ | aarch64 |
| `uitest_agent_v1.1.3/1.1.5/1.1.10/1.2.2.so` | ✅ | ✅ | ✅ | aarch64 |
| `uitest_agent_v1.1.9.x86_64_so` | ✅ | ✅ | ❌ | **x86_64** |

**三个未签名文件全是 x86_64 或云手机专用** —— 模拟器没有 XPM 校验（见 [06](06-signing-xpm.md)），所以官方只给这些架构放未签名文件。这也反向证明 XPM 校验的边界。

---

## 四、录屏在 7.0 真机上：26.x 依然失效（实测）

### 4.1 结论先行

| SO | 版本 | 7.0 真机 `-m 1` 录制 |
|---|---|---|
| `libscrcpy_server1~4.z.so` | 5.2 ~ 5.7 | ❌ 不驻留 / 不监听 |
| `libscrcpy_server_unix_6.3.1` | 6.3.1 | ❌ `set virtual screen surface failed` |
| `libscrcpy_server_unix_6.4` | 6.4 | ❌ 同上 |
| `libscrcpy_server_unix_6.5` | 6.5 | ❌ 同上 |
| **`.spike/libscreen_casting.z.so`** | **6.8-20260801** | **✅ 稳定成功（4/4，变量隔离见 4.3）** |

**26.x 补了 unix 变体，但在 7.0 真机上仍然录不了屏。** 反而是我们手上的 6.8 casting SO 能录。

### 4.2 失败机理：Rosen `VirtualScreenOption` ABI 断裂

失败的 SO 和成功的 SO 打出来的 DMS 日志是同一个错误：

```
W RSScreenManager: ValidateVirtualScreenLimits: width 94 or height 1919120140 has reached the maximum limit!
I DMS: CreateVirtualScreen: rsId is invalid
E DMS: SetVirtualScreenSurface: No such screen.
E DevEcoScrcpy: [native_screen_encoder.cpp:(Run)] set virtual screen surface failed.
```

`1919120140` = `0x7263_6F6C` ≈ ASCII `"rcol"` —— 典型的**结构体字段错位**：SO 按旧版 `VirtualScreenOption` 布局填参数，7.0 的 `librender_service_base.z.so` 按新布局读，于是把字符串字段当成了高度。

对比两个 SO 的依赖：

| | 6.5 unix（失败） | 6.8 casting（成功） |
|---|---|---|
| `librender_service_base.z.so` | **NEEDED** | ❌ 不依赖 |
| Rosen `DisplayManager` 导入 | 4 个 | **7 个**（多 `GetDisplayById` / `GetFoldStatus` / `GetCurrentFoldCreaseRegion`） |
| Rosen `Screen` 导入 | ❌ | **有 `Screen::GetWidth` / `GetHeight`** |
| `libaudio_capturer.z.so` | NEEDED | ❌ 不依赖 |

**6.8 把虚拟屏宽高改成从 `Screen::GetWidth/GetHeight` 读**，绕开了对 `VirtualScreenOption` 结构体布局的依赖；6.5 还在靠旧的 `librender_service_base` 结构体。这就是为什么 6.8 能跑而 6.5 不能。

> **旁证**：`ValidateVirtualScreenLimits` 报的 height 恒为 `1919120140`（`0x72636F6C` = `"rcol"`），而 width 每次都不同（90/94/98/100/102/103/105）。这正是「把指针/字符串内容当 int64 读」的特征 —— 结构体字段偏移对不上。

### 4.3 变量隔离实验：失败只取决于 SO 内容

一开始以为是 `-encodeType` 或文件名/端口的问题。做了完整的变量隔离后排除：

| # | SO | 文件名 | 端口 | `-encodeType 0` | 结果 |
|---|---|---|---|---|---|
| A | 6.8 | `libscreen_casting.z.so` | 5000 | ❌ | ✅ `width[1216], height[2688]` / `Start muxer success!` |
| B | 6.8 | `libscreen_casting.z.so` | 5001 | ❌ | ✅ 成功 |
| C | 6.8 | `libscreen_recorder.z.so` | 5001 | ❌ | ✅ 成功 |
| D | 6.8 | `libscreen_recorder.z.so` | 5000 | ❌ | ✅ 成功 |
| E | **6.5 unix** | `libscreen_recorder.z.so` | 5001 | ❌ | ❌ `width 103 / height 1919120140` |
| F | **6.5 unix** | `libscreen_casting.z.so` | 5000 | ❌ | ❌ `width 105 / height 1919120140` |
| G | **6.5 unix** | `libscreen_recorder.z.so` | 5001 | ✅ | ❌ 同上 |
| H | **6.3.1 / 6.4 unix** | `libscreen_recorder.z.so` | 5001 | ❌ | ❌ 同上 |

**结论**：文件名、端口、`-encodeType` 都无关。**唯一变量是 SO 内容**。6.8 成功，6.3.1/6.4/6.5 全部失败。

> **踩过的坑（值得记录）**：中途有一次 `hdc file send .spike/libscreen_casting.z.so /data/local/tmp/xxx` 用的是**相对路径带目录**，hdc 把 `.spike/` 当成了目标目录结构，在设备上创建了 `/data/local/tmp/libscreen_casting.z.so/.spike/libscreen_casting.z.so` —— 也就是说目标位置变成了**目录**。后续 `dlopen` 全部静默失败，看起来像「所有 SO 突然都不能用了」。教训：**`hdc file send` 前先 `cd` 到源文件所在目录，只用裸文件名**。诊断特征：`md5sum` 返回 `d41d8cd98f00b204e9800998ecf8427e`（空文件/目录的 md5）。

6.8 录制实测（带画面变化）：

```sh
uitest start-daemon singleness --extension-name libscreen_casting.z.so \
  -p 5000 -m 1 -screenId 0
# → onEnd 返回 frame_count: 97
# → /data/local/tmp/mytest.mp4  19,804 B，含 ftyp / mdat / moov，可正常播放
```

（同一 SO 用 `-p 5001` + 文件名 `libscreen_recorder.z.so` 也成功，见 4.3 的 C/D 组。）

### 4.4 DevEco Testing 自己的录屏路径为什么坏

`controllers/tools/recorder/record_agent.py` 的 SO 选择：

```python
self.use_unix_socket = self._device.check_if_unix_socket_mode()
# ↑ uitest > 6.0.2.1 且 arch 不含 x86_64 → True

for root, dirs, files in os.walk(RESOURCE_PATH/res/recorder):
    for name in reversed(files):
        if not name.startswith("libscrcpy_server"): continue
        if self.use_unix_socket and "unix" not in name: continue    # ← 关键
        elif not self.use_unix_socket and "unix" in name: continue
```

`check_if_unix_socket_mode()`（`ohos/environment/device.py:323`）：

```python
cur_version = tuple(self.uitest_version.strip().split("."))
base_version_6_0_2_1 = tuple("6.0.2.1".split("."))
if cur_version > base_version_6_0_2_1 and "x86_64" not in self.arch:
    self._use_unix_socket = True
```

**python 侧 `res/recorder/` 只有 `libscrcpy_server1~4`（都不带 `unix`）** → 7.0 真机 `use_unix_socket=True` → 候选为空 → 返回 `False`。

**26.x 的 unix SO 全在 Java 侧 jar 里，python 侧没同步。** 这就是为什么 26.x 的 python 录制路径依然坏。

### 4.5 那我们该用哪个

**用 6.8 casting SO（`.spike/libscreen_casting.z.so`，md5 `8c8df9a96af21aac71d5091ffa0b1477`）**：

- 投流：gRPC over `@scrcpy_grpc_socket`，最高 ~89 fps
- 录制：同一 SO 加 `-m 1`，`onEnd` 返回 frame_count，落盘 `/data/local/tmp/mytest.mp4`
- 已在真机验证稳定

**7.0 WebSocket SO** 的优势在零依赖客户端和多实例端口隔离，但录制同样可用（见 [09](09-capability-gaps-roadmap.md) §1.4）。

---

## 五、DevEco Testing 的能力面

### 5.1 分层

```
DevEco Testing 26.0.1.100 (Java/Kotlin GUI, jcef)
  └── app/resources/tools/demoWithoutRecord.jar (36.9 MB)  ← 测试用例录制器（Java hosScrcpy 1.0.17.12）
  └── python/Lib/site-packages/
        ├── devicetest  6.1.0.210   ← 测试套件 / 报告 / 录屏 / CV
        ├── hypium      6.1.0.210   ← UI 自动化框架（UiDriver / OHOSDriver）
        ├── xdevice     6.1.0.210   ← 设备管理 / 执行器
        └── ohos        6.1.0.210   ← OpenHarmony 设备适配层
```

### 5.2 `hypium` —— 官方 API 面全表（最值钱）

`hypium/uidriver/ohos/uidriver.py` 有两个类，共 **118 个公开方法**（AST 精确统计）：

- `CompatibleInterfaceMixIn` — 12 个（日志/命令/坐标转换/设备信息）
- `OHOSDriver` — 106 个

**这就是 SDK 能力规划的上界**，全部走 agent.so RPC。完整分类见 [11](11-deveco-capability-inventory.md)。

### 5.3 `devicetest` —— 测试工程能力

| 能力 | 实现 | 说明 |
|---|---|---|
| **录屏** | `RecordAgent` + casting `-m 1` | ⚠️ python 路径在 7.0 真机上坏（见第四节） |
| **截图** | `ScreenAgent.screenshot` → `device.capture()` → **`snapshot_display`** | 675 ms |
| **UI 操作录制** | `RecordAction`（71.9 KB 混淆源码） | 录操作 → 生成可回放代码；含自适应重定位、AI action |
| **控件树** | `record_tree.WidgetTree` | 解析 layout JSON，建 xpath 索引 |
| **图像比对** | `ImgUtils.quick_find` / `cv._cv` | 模板匹配、SIFT、pHash、`hamming_distance` |
| **弹窗自动处理** | `advance/pop_up_window_handler.py` | 规则驱动自动关弹窗 |
| **报告** | `core/report.py` + `template/case.html` | HTML 报告 + 截图/视频关联 |

### 5.4 Java 侧 `hosScrcpy` API（26.x 新增）

`UitestServer` / `HosRemoteDevice` / `VideoRecorder` 三个类暴露的方法（从字节码字符串提取）：

| 类别 | 方法 |
|---|---|
| **连接** | `startUitest` / `stopUitestServer` / `startUiTestServer` / `isUitestRunning` / `restartUitest` |
| **投流** | `startScreenCapture` / `stopCaptureScreen` / `startImageScreenCapture` / `onRequestIDRFrame` |
| **录制** | `startRecord` / `stopRecord` / `getRecordPids` / `killRecord` |
| **布局** | `captureLayout` / `getLayout` / `getLayoutData` / `sendLayoutRequest` |
| **触摸** | `onTouchDown` / `onTouchMove` / `onTouchUp` / `doTouchEvent` |
| **鼠标** | `onMouseDown` / `onMouseUp` / `onMouseMove` / `onMouseWheelUp/Down/Stop` / `mouseLeft/Middle/Right` |
| **输入** | `inputText` / `doInputEvent` |
| **旋转** | `doRotationEvent` / `setRotation` / `setRotationHorizontal` / `setRotationVertical` / `rotation0/90/180/270` |
| **设备** | `getScreenSize` / `getSn` / `getUitestPid` / `getSinglenessPid` / `killExtension` |
| **配置** | `HosRemoteConfig.set{Scale,BitRate,FrameRate,EncoderType,IFrameInterval,RepeatInterval,AppPid,WindowsId}` |

**注意**：Java 侧没有 pen / toast / ui_event / pinch / multi-finger / image-recognition —— 这些只在 python `hypium` 侧。

### 5.5 `xdevice` —— 设备与执行

`CKit` 常量表列出的 20 个能力集：

```
PushKit / CommonPushKit / LiteAppInstallKit / CommandKit / ConfigKit / WIFIKit
PropertyCheckKit / STSKit / ShellKit / DeployKit / MountKit / LiteUiKit
RootFsKit / LiteShellKit / AppInstallKit / DeployToolKit / QueryKit
ComponentKit / PermissionKit / SmartPerfKit
```

其中 **`SmartPerfKit`** = 性能采集。

---

## 六、对我们的意义

### 6.1 26.x 的增量只有「多 3 个 unix 录屏 SO」，而且全坏

| 对比项 | 6.1.0.210 | 26.0.1.100 |
|---|---|---|
| python 侧 SO | 9 | 9（完全一致，md5 逐字节相同） |
| Java 侧 SO | ❌ 无 jar | 8 个（含 `unix_6.3.1/6.4/6.5`、`5.10`、`emulator`） |
| hypium 版本 | 6.1.0.210 | 6.1.0.210（**完全一致**） |
| 7.0 WebSocket SO | ❌ | ❌ |
| 7.0 真机录屏 | ❌ | ❌ |

**升级到 26.x 对我们的能力面没有任何增益。**

### 6.2 它的 SO 对我们没用（除了模拟器 agent）

- 最高 6.5，全 gRPC，且在 7.0 上虚拟屏创建失败
- **唯一可用的**：`uitest_agent_v1.1.9.x86_64_so`（1,460,181 B）—— 模拟器 agent，我们已在用
- `libscrcpy_server_emulator.z.so`（2,926,240 B，未签名，4.8-20241009）—— 云手机主屏，架构是 aarch64 但无签名，模拟器上可能可用，未测

### 6.3 它验证了我们的选型

- 截图：它用 `snapshot_display`（675 ms），我们用 agent MJPEG（178 ms）—— **快 3.8 倍**
- UI 树：它走 `dumpLayout` + pull，我们走 `captureLayout` —— **快 2 倍**
- 单次动作：同一个 agent RPC —— **持平**
- 录屏：它的路径在 7.0 上坏了，我们直连 6.8 casting `-m 1` —— **我们能跑**

### 6.4 26.x 里唯一值得挖的东西：Java 侧的 `HosRemoteDevice`

`hosScrcpy-1.0.17.12` 是**官方自己写的 scrcpy 客户端**（不是社区的 HOScrcpy）。它证明了：

1. 官方也用 `fport tcp:N localabstract:scrcpy_grpc_socket`（和我们的做法一致）
2. 官方也用 `uitest start-daemon singleness --extension-name ...`（一致）
3. 官方的 SO 选择顺序是 `server1 → server2 → server3 → 5.10 → unix_6.3.1 → 6.4 → 6.5`（逐个试，失败换下一个）—— 这是**官方自己的兜底策略**，与我们的「不兜底」原则相反

---

## 七、实验产物

| 路径 | 说明 |
|---|---|
| `.work/deveco26/entrylist.txt` | 安装包 8670 个条目的完整清单（uncompressed/compressed size + 路径） |
| `.work/deveco26/so/` | 从 `hosScrcpy` jar 提取的 8 个 SO |
| `.work/deveco26/extracted/` | 从安装包直接提取的 python 文件 |
| `.work/verify/x26.py` | 自解压 PE 内嵌 zip 解析器（自动算 base offset） |
| `.work/verify/rec26.py` | gRPC 录制驱动脚本 |
| `.work/verify/probe65.py` | `onStart` 最小探针 |
| `.work/verify/rec68_final.mp4` | 6.8 SO 录制样本（19,804 B，97 帧，带滑动画面变化） |
| `.work/verify/rec26_68.mp4` | 6.8 SO 录制样本（4,305 B，24 帧，静态画面） |

复现命令：

```sh
# 1. 解析安装包（自解压 PE + 内嵌 zip，需要自己算 base offset）
python -I .work/verify/x26.py "C:\Users\32147\Downloads\devecotesting-windows-26.0.1.100\devecotesting-windows-26.0.1.100.exe" out_dir <entry>

# 2. 确认 26.x 没有 7.0 SO
grep -i "unix_7" .work/deveco26/entrylist.txt      # → 无输出

# 3. 复现 unix_6.5 录制失败
hdc file send .work/deveco26/so/libscrcpy_server_unix_6.5-20260313.z.so /data/local/tmp/libscreen_recorder.z.so
hdc shell "cd /data/local/tmp && /system/bin/uitest start-daemon singleness \
  --extension-name libscreen_recorder.z.so -p 5001 -m 1 -screenId 0"
hdc fport tcp:15001 localabstract:screen_record_grpc_socket
python .work/verify/probe65.py 127.0.0.1:15001
hdc shell "hilog -x | grep ValidateVirtualScreenLimits"
# → width 9x or height 1919120140 has reached the maximum limit!

# 4. 复现 6.8 录制成功
hdc file send .spike/libscreen_casting.z.so /data/local/tmp/libscreen_casting.z.so
hdc shell "cd /data/local/tmp && /system/bin/uitest start-daemon singleness \
  --extension-name libscreen_casting.z.so -p 5000 -m 1 -screenId 0"
# → hilog: CreateVirtualScreen: name[scrcpy], width[1216], height[2688] / Start muxer success!
```
