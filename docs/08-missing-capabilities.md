# 08 · 未分析的 .so 与缺失能力

本篇回答两个问题：**还有哪些相关 `.so` 没分析**，以及**除窗口级静态截图外，还有哪些能力可补**（虚拟屏 / 无障碍 / 无线调试 / 不依赖 hdc 的路径）。

所有结论均为 2026-11-14 在 `<your-device-id>`（BRA-AL00 / HarmonyOS 7.0.0.111 / uitest 7.0.0.1）实测。

---

## 一、还没分析的 `.so`

### 1.1 scrcpy server 的另外 6 个版本

`devicetest` 包一共发了 6 个 scrcpy server 变体，此前只分析了 `libscreen_casting.z.so`（6.8-20260801）。

| 文件 | 大小 | 版本 | onRequestIDRFrame |
|---|---|---|---|
| `libscrcpy_server_old.z.so` | 2,918,582 | — | — |
| `libscrcpy_server.z.so` | 3,029,173 | 4.6-20240912 | — |
| **`libscrcpy_server1.z.so`** | **3,041,461** | 5.2-20250226 | ❌ |
| `libscrcpy_server2.z.so` | 309,430 | 5.6-20250402 | ✅ |
| `libscrcpy_server3.z.so` | 288,950 | 5.7-20250604 | ✅ |
| `libscrcpy_server4.z.so` | 264,374 | 5.7-20250708 | ✅ |

**`libscrcpy_server1.z.so` 值得单独说**：它比 2/3/4 大 10 倍（3.0 MB vs 0.3 MB），但字符串 diff 出来的 7,524 行独有内容**全是 protobuf / gRPC 内部符号**（`google::protobuf::Reflection`、`SEND_INITIAL_METADATA`、`CodedInputStream::SetTotalBytesLimit` 等），说明它是**静态链接 libprotobuf + libgrpc 的产物**，而不是功能更多。它只有 `onStart` / `onEnd` 两个 RPC，**没有 `onRequestIDRFrame`**。

2/3/4 是动态链接版，体积随版本单调下降（309K → 289K → 264K），三个 RPC 齐全。**结论：继续用 6.8 那个，其他不用碰。**

### 1.2 `uitest_agent` 的另外 7 个版本

磁盘上一共 8 个版本：

| 版本 | 大小 | 传输层 | 备注 |
|---|---|---|---|
| v1.0.7 | — | TCP 8012 | 最老 |
| v1.0.8 | — | TCP 8012 | |
| v1.1.0 | — | TCP 8012 | |
| v1.1.3 | 149,685 | TCP 8012 | |
| v1.1.5 | 153,781 | TCP 8012 | |
| v1.1.9 | 153,782 | TCP 8012 | deveco-cli 内置 |
| v1.1.10 | 600,246 | TCP 8012 | 前文分析的那个 |
| **v1.2.2** | **600,245** | **Unix domain socket** | **本轮新发现，见第二节** |

v1.1.10 → v1.2.2 体积几乎相同（差 1 字节），但字符串 diff 只有 20 行差异，核心是传输层换了：

```
仅 1.1.10 有:  127.0.0.1 / inet_addr / inet_ntoa / setsockopt / "Got connection from %s" / "Rpc client connect fail."
仅 1.2.2 有:   uitest_socket / getsockopt / SO_PEERCRED / "create socket file %s"
               "Got connection from domain socket, Peer PID: %d, Peer UID: %d, Peer GID: %d"
```

### 1.3 `/system/bin/uitest` 本体（962,112 B，未反编译）

它**自己**就能做 `screenCap` / `dumpLayout` / `uiInput` / `uiRecord`，不需要任何扩展。目前只用了它的 CLI 面，二进制没拆。

### 1.4 其他系统工具（都没分析，但都实测存在）

`snapshot_display` / `wukong` / `SP_daemon` / `hiprofiler_cmd` / `hiperf` / `hitrace` / `bytrace` / `hisysevent` / `hiview` / `processdump` / `dumpcatcher` / `perftest` / `split` / `test` / `testhelper`。

---

## 二、新发现：`agent v1.2.2` 换成 Unix domain socket

这是本轮最有价值的发现，**直接改变了「窗口级静态截图」缺口的判断**。

### 2.1 传输层

```
$ uitest start-daemon singleness --extension-name agent122.so
$ cat /proc/net/unix | grep uitest
0: 00000002 0 10000 1 1 27891265 @uitest_socket
```

抽象 socket 名 `@uitest_socket`。客户端：

```sh
hdc fport tcp:8013 localabstract:uitest_socket
```

hilog 会打 `Got connection from domain socket, Peer PID: 1555, Peer UID: 2000, Peer GID: 2000` —— 服务端用 `SO_PEERCRED` 做了调用方身份检查。

> **注意**：抽象 socket 没有文件实体，`ls /data/local/tmp/uitest_socket` 必然失败，别被误导。

### 2.2 帧格式

```
HEAD(28)  = "_uitestkit_rpc_message_head_"
sessionId(4, LE)
len(4, BE)   ← 服务端解析时忽略，靠 TAIL 定位
payload      = JSON
TAIL(28)  = "_uitestkit_rpc_message_tail_"
```

反汇编 `RpcServer::ExtractAndDispatchRequests`（0x20128）确认：服务端先 `memmem` 找 HEAD，再 `memmem` 找 TAIL，payload 取中间那段。所以**长度字段写错不影响**，但 HEAD/TAIL 必须原样带上。

### 2.3 请求格式变了：`params` 是对象，不是数组

1.1.10 是 `{"module":..., "method":..., "this":..., "args":[...]}`。
1.2.2 是：

```json
{"module": "com.ohos.devicetest.hypiumApiHelper",
 "method": "<模块名>",
 "params": {"api": "<api名>", "args": {...}, "this": "<对象引用>"}}
```

反汇编 `HandleCapture`（0x26d40）等函数确认了三个字段名 `api` / `args` / `params`，以及类型校验：

| 字段 | 要求 | 违反时 |
|---|---|---|
| `module` | 必须 == `com.ohos.devicetest.hypiumApiHelper`（35 字符逐字节比对） | `Invalid request module` |
| `method` | 字符串 | `Invalid request, incorrect module/method/params value` |
| `params` | **JSON object**（type==4） | `Invalid request, incorrect module/method/params value` |
| `params.args` | **JSON object**（type==4） | 同上 |

`params` 传数组 / 字符串 / null / 数字全部报 `Invalid request, incorrect module/method/params value`。这是最容易卡住的地方 —— 前文 `05` 里记的 1.1.10 协议在这版完全失效。

### 2.4 模块与 API（实测枚举）

各模块的「未知 api」错误串不同，可以用它做成员探测。

**`CtrlCmd`** —— 只有 2 个：

```
getDisplaySize     → {"result":{"width":1216,"height":2688},"pts":...}
getDisplayRotation → {"result":0,"pts":...}
```

**`Gestures`** —— 只有 3 个（坐标必须在屏幕内，否则 `Illegal touch point coordination`）：

```
touchDown / touchMove / touchUp   args: {"x":<int>,"y":<int>}
```

**`Captures`** —— 6 个（从跳转表 0x11624 精确解出，长度 13/17/18/19/20）：

| api | 状态 |
|---|---|
| `captureLayout` | ✅ 返回完整 UI 树（`{"result":{"attributes":{...},"children":[...]}}`） |
| `captureScreen` | ⚠️ **本机不可用**，见 2.5 |
| `startCaptureScreen` | ✅ MJPEG 流，`{"result":true}` |
| `stopCaptureScreen` | ✅ `{"code":0}` |
| `startCaptureUiAction` | ✅ `{"result":true}` |
| `stopCaptureUiAction` | ✅ `{"result":true}` |

**`callHypiumApi`** —— 全套 hypium 面，`this` 必填（缺了报 `401 Illegal messsage, api/this/args property missing`）：

```json
{"module":"com.ohos.devicetest.hypiumApiHelper","method":"callHypiumApi",
 "params":{"api":"Driver.getDisplaySize","this":"Driver#0","args":[]}}
→ {"result":{"displayId":0,"x":1216,"y":2688},"pts":...}
```

实测可用：`Driver.create` / `createUIEventObserver` / `getDisplaySize` / `getDisplayRotation` / `getDisplayDensity` / `pressBack`。
参数数量不对时报 `(PreProcessing: APiCallInfoChecker)Illegal argument count`（这反而证明 api 存在）。

> `this` 必须写 `Driver#0`，空串会报 `Illegal messsage`。注意官方拼写就是 `messsage`（三个 s）。

### 2.5 `captureScreen` 在本机是坏的

`Captures.captureScreen` 接受 `{"savePath": "...", "displayId": 0, "options": "..."}`，但实测**恒返回 `{"result": false}`，不落盘**：

```
E render_service/OHOS::GE: RSSurfaceCaptureTaskParallel::CreateResources: SurfaceCapture scale is invalid.
E uitest/DMS: GetScreenshotWithOption: get snapshot with option failed!
E uitest/UiTestKit_Addon: Failed to get display pixelMap
```

已排除的变量：

| 变量 | 试过的值 | 结果 |
|---|---|---|
| `displayId` | `-1` / `0` / `1` | 全 False |
| `options` 类型 | object / JSON 字符串 / 数字 | 全 False |
| `options` 键名 | `scale` / `scaleX`+`scaleY` / `needScale` / `isNeedScale` / `needSnapshot` / `pixelFormat` | 全 False |
| 屏幕状态 | 锁屏 / 唤醒 / 解锁后 | 全 False |

`scale is invalid` 来自 Rosen 的 `RSSurfaceCaptureTaskParallel`，说明是**设备侧截图管线本身拒绝了这个请求**，不是协议问题。**结论：1.2.2 的 `captureScreen` 在这个 ROM 上不可用，不要依赖。**

另一个坑：`captureScreen` 之后紧接着发第二个请求，daemon 大概率崩溃（`processdump` 记录 pc `0x270d4` → `HandleCapture+916`）。一崩就得 `kill -9` + 重启 + 重连 fport。

### 2.6 并发

1.2.2 **仍然不能并发**：第二次 `start-daemon` 只起了一个进程（`ps | wc -l` = 1），因为 socket 名 `uitest_socket` 是硬编码的。

---

## 三、「窗口级静态截图」缺口已补上 —— 用 `snapshot_display`

这是本轮第二个重要结论：**不需要任何扩展、不需要 uitest、不需要 daemon**。

```sh
hdc shell snapshot_display -f /data/local/tmp/x.jpeg
```

实测输出：

```
process: display 0, file type: jpeg, width: 1216, height: 2688
snapshot: pixel format is: 3
snapshot: convert rgba8888 to rgb888 successfully.
success: snapshot display 0 , write to /data/local/tmp/x.jpeg as jpeg, width: 1216, height: 2688
```

### 3.1 参数

```
usage: snapshot_display [-i displayId] [-f output_file] [-w width] [-h height] [-t type] [-m]
```

| 参数 | 实测 |
|---|---|
| `-i <id>` | 只支持 0（`-i 1` → `error: displayId 1 invalid!` + `tips: supported displayIds: 0`） |
| `-f <path>` | 必填。后缀决定不了格式，格式由 `-t` 决定 |
| `-t jpeg\|png` | 默认 jpeg。png 实测 1,541,413 B |
| `-w` / `-h` | **服务端缩放**，`-w 608 -h 1344` → 14,467 B；`-w 300 -h 600` → 3,964 B |
| `-m` | 解析器有 bug —— 无论放前面还是后面都报 usage，实际不可用 |

### 3.2 四条截图路径的实测延迟

**关键区分**：`snapshot_display` 虽然「不需要扩展」，但它必须走 `hdc shell` + `hdc file recv` 两次往返；agent 的 MJPEG 只需一条长连接，**没有进程启动和文件传输开销**。

单张截图（含取回数据，各测 5~8 次取中位数）：

| 路径 | 单张耗时 | 走 hdc 通道 | 说明 |
|---|---|---|---|
| **`agent.so startCaptureScreen` 起停一次** | **178 ms** | ❌ 只要 fport 隧道 | 最快的单张路径，见下 |
| `snapshot_display` + `file recv` | 675 ms | ✅ shell + pull 两次往返 | 其中 shell 550 ms、pull 120 ms |
| `uitest screenCap -p` + pull | ~970 ms | ✅ | 最慢 |
| `agent 1.2.2 captureScreen` | ❌ 不可用 | — | Rosen 拒绝 |

> 早先只测了 `snapshot_display` 的 shell 段（460 ms），漏掉了 `file recv` 的 ~120 ms。端到端才是 675 ms。

**178 ms 是怎么来的**：`startCaptureScreen` 的 ack 只要 16 ms，第一帧 JPEG 在 127~152 ms 后到达（scale=2 → 608×1344，约 71 KB），`stopCaptureScreen` 几毫秒。全程一条 TCP 连接，无进程 fork、无文件落盘。

连续帧对比：

| 路径 | 帧率 | 单帧延迟 |
|---|---|---|
| `agent.so` MJPEG @scale=2 | 11.7 fps（中位间隔 83 ms） | ~140 ms 首帧 |
| `libscreen_casting` H.264 | 13.6~89 fps（取决于 `-frameRate`） | 需解码 |
| `snapshot_display` 循环 | ~1.5 fps（675 ms/张） | — |

**结论（按用户两条原则）**：

1. **单张截图 → agent MJPEG 起停一次**（178 ms）。不依赖 hdc 的 shell/file 通道，且快 3.8 倍。
2. **连续画面 → `libscreen_casting` H.264**（帧率最高，单帧数据量最小）。
3. **`snapshot_display` 只作为兜底** —— 当 agent daemon 崩了、或只需要一张图且不想维护 daemon 时用。
4. **绝不用 `uitest screenCap`** —— 最慢且依赖 uitest 本体。

### 3.2b 其他能力同口径对比

| 能力 | agent.so（fport 长连接） | uitest CLI（hdc shell） | 倍数 |
|---|---|---|---|
| 取 UI 树 | `captureLayout` **473 ms** | `dumpLayout` + pull **970 ms** | 2.0× |
| 单次动作 | `CtrlCmd` **5.2 ms** | `uiInput click` **389 ms** | 75× |
| 单张截图 | `startCaptureScreen` 起停 **178 ms** | `snapshot_display`+pull **675 ms** | 3.8× |

**规律很明确**：凡 agent.so 能做的，都比 CLI 快一个数量级以上。CLI 每次都要 fork 进程 + 初始化 uitest + 走 hdc 通道。

### 3.3 窗口级 layout（不是截图）

`uitest dumpLayout` 支持窗口过滤，可以只 dump 某个窗口的树：

```sh
uitest dumpLayout -p /data/local/tmp/w16.json -w 16    # → 420 B（全量是 67,300 B）
uitest dumpLayout -p x.json -b com.ohos.sceneboard      # 按 bundle
uitest dumpLayout -p x.json -a                          # 带字体属性，67,300 → 69,470 B
```

**但截图没有对应的窗口级参数** —— 三个 .so、`snapshot_display`、`uitest screenCap` 都只能出整屏。真要窗口级像素，只能自己按 layout 的 `bounds` 裁。

---

## 四、其他能力盘点

### 4.1 无线调试（不依赖 USB）

`hdc` 本身就支持，不需要额外组件：

```sh
hdc tconn 192.168.31.204:8710     # 按 ip:port 连（也支持 COM5,921600 走串口）
hdc tmode port 8710               # 让设备在 TCP 8710 上监听
hdc tmode usb                     # 切回 USB
hdc tmode port close              # 关闭 TCP 监听
hdc smode [-r]                    # 以 root 重启 daemon
```

设备当前 `wlan0` = `192.168.31.204`，另有一个 `ancowlan0` = `172.17.1.1`（可能是虚拟网桥）。

#### 但本机实测：WiFi 直连不通

想彻底绕开 hdc 的话，只有 perfmonitor 这条线（唯一绑 `0.0.0.0` 的扩展）：

```
设备侧: 00000000:270F  (0.0.0.0:9999, perfmonitor_260608.so 加载成功)
主机侧: 192.168.31.11  (wlan0 同网段)
```

两个方向都失败：

| 方向 | 命令 | 结果 |
|---|---|---|
| 主机 → 设备 | `ping 192.168.31.204` | 100% 丢包 |
| 主机 → 设备 | `connect 192.168.31.204:9999` | TimeoutError |
| 设备 → 主机 | `ping 192.168.31.11` | 100% 丢包 |
| ARP 表 | `arp -a \| grep 192.168.31.204` | **不存在** |

同网段但 ARP 表里没有对方 → **AP 隔离（client isolation）**。这是路由器策略，不是设备限制。

#### 其他扩展都绑 loopback

| 扩展 | 监听地址 | 能否直连 |
|---|---|---|
| `agent.so` | `0100007F:1F4C` = **127.0.0.1:8012** | ❌ 必须 fport |
| `agent 1.2.2` | `@uitest_socket`（abstract unix） | ❌ 必须 fport |
| `libscreen_casting` | `@scrcpy_grpc_socket`（abstract unix） | ❌ 必须 fport |
| `perfmonitor_260608.so` | `00000000:270F` = **0.0.0.0:9999** | ✅ 唯一可能 |

**所以「不依赖 hdc」在本机目前做不到**，除非：
1. 关掉路由器的 AP 隔离 → 只有 perfmonitor 能用，agent/casting 仍绑 loopback；
2. 把扩展改成绑 `0.0.0.0` → 需要重新编译，被 XPM 封死（见 06）。

**fport 算不算「依赖 hdc」？** 这是边界情况：`hdc fport` 只是建立一条隧道，之后的全部流量走的是原始 TCP，没有 hdc 协议开销。但隧道本身要靠 hdc 进程维持。实测单次 RPC 5.2 ms，说明隧道开销可以忽略。

### 4.1b perfmonitor 的稳定性问题

三个 perfmonitor 变体，**只有一个是好的**：

| 文件 | 加载 | 原因 |
|---|---|---|
| `perfmonitor.so` | ❌ | `symbol not found: _ZN4OHOS5Rosen13ScreenManager19ResizeVirtualScreenEmjj` |
| `perfmonitor_new.so` | ❌ | 同上 |
| `perfmonitor_260608.so` | ✅ | 绑 `0.0.0.0:9999` 成功 |

`ResizeVirtualScreen` 是 Rosen 的 `ScreenManager` 方法，这个 ROM 上已经不存在了。**文档 04 里写的 perfmonitor.so 现在跑不起来**，要用 `perfmonitor_260608.so`。

这正好印证用户的第一条原则：perfmonitor 唯一的价值是「绑 0.0.0.0」，但它连加载都不可靠 —— 而 casting 的 `-m 1` 能做同样的事（MP4 落盘），且不依赖那个已删除的符号。**perfmonitor 可以整个砍掉。**

### 4.2 UI 操作录制（CLI 等价于 agent 的 `recordUiAction`）

```sh
uitest uiRecord record -c true      # -c 打印到控制台；-l 每步存 layout
# ... 在设备上操作 ...
uitest uiRecord read                # 读回
```

产出 `/data/local/tmp/record.csv`，**不是 CSV 而是逐行 JSON**：

```json
{"ABILITY":"SCBScreenLock13","BUNDLE":"SCBScreenLock13","CENTER_X":"","CENTER_Y":"",
 "EVENT_TYPE":"pointer","FILEPAHT":"/data/local/tmp/layout_673874457700_1.json",
 "LENGTH":"0","OP_TYPE":"click","VELO":"0.000000","direction.X":"0.000000",
 "direction.Y":"0.000000","duration":122647000.0,
 "fingerList":[{"LENGTH":"0","MAX_VEL":"40000","VELO":"0.000000",
                "W1_BOUNDS":"[79,804][1136,2262]","W1_HIER":"ROOT16"...}]}
```

一次点击 733 B，带当时命中组件的 bounds 和 hierarchy。注意字段名拼写是 `FILEPAHT`（官方笔误）。

> `-c` 是 `<true/false>` 不是路径；`-l` 是布尔开关（是否每步存 layout），**不是路径**。传 `-l /path` 会报 `Invalid params`。

### 4.3 无障碍

- `accessibility` 服务在跑：`ps -ef` → pid 778，已运行 1h37m。
- `hidumper -s AccessibilityManagerService` 可 dump，但本机输出只有头部（无详细内容）。
- agent 侧只有 **属性级** 支持：`Component.getAccessibilityId` / `On.accessibilityId`，**没有无障碍服务的完整交互面**（无法枚举已注册的无障碍服务、无法模拟读屏、无法拿无障碍事件流）。

`uiRecord` 走的是 uitest 自己的 `UIEventObserver`，不经过无障碍服务。

> 2026-11-16 实测：`uiRecord` 与 agent daemon **互斥**（daemon 监听时启动报
> `Can not connect to AAMS, RET_ERR_CONNECTION_EXIST`；反向顺序则 agent 连接被关），且它本身是
> hdc shell 拉起的常驻设备进程。扩展侧的 `recordUiAction` / `Captures.startCaptureUiAction` 是同一套
> observer，停止会关会话、能卡死 daemon。接管记录若要做，只能走 `captureLayout` 轮询；
> 详见 [13](13-stage-log.md) §C2–C4。

### 4.4 虚拟屏

casting 内部确实在用虚拟屏 —— `libscrcpy_server2/3/4` 里都有 `CreateVirtualScreen` / `SetVirtualScreenSurface` / `MakeMirror` 符号。但：

- **没有暴露创建/销毁/配置虚拟屏的 API**。虚拟屏是 casting 内部实现细节，参数固定。
- 设备目前只有 **1 个物理 display**（`snapshot_display -i 1` → `supported displayIds: 0`）。
- `hidumper -s RenderService -a screen` 拿不到 display 列表。

想做「第二块虚拟屏给脚本用、不影响用户看的主屏」，需要自己写扩展调 Rosen 的 `CreateVirtualScreen` —— 而这条路被 XPM 封了（见 06）。

### 4.5 AAMS（无障碍自动化加速）

官方源码 `frontend_api_handler.cpp` 里有：

```cpp
Driver.SetAamsWorkMode   // enum AamsWorkMode : uint8_t { NORMAL, FASTGETNODE, END }
Driver.OpenAamsEvent
Driver.CloseAamsEvent
```

**但两个二进制里都没有**：

```
$ strings agent_v1.1.10.so | grep -c Aams   → 0
$ strings agent_v1.2.2.so  | grep -c Aams   → 0
```

实测：

```
Driver.setAamsWorkMode  → {"exception":{"code":17000006,"message":"No handler found for api 'Driver.setAamsWorkMode'"}}
Driver.openAamsEvent    → 同上
Driver.closeAamsEvent   → 同上
```

`FASTGETNODE` 是「快速取节点」模式，对高频 dump layout 有显著收益。**目前拿不到，需要更高版本的 agent.so。**

### 4.6 性能 / 追踪

| 工具 | 实测 |
|---|---|
| `SP_daemon` | `/bin/SP_daemon` 存在，但无参调用无输出；帮助里提到 `-snapshot` / `-nav`（页面导航）/ `-c` `-g` `-f` `-r` `-t` `-p` `-net` / `-start` `-stop` |
| `hiprofiler_cmd` | `--getport -q` 未启动时返回 `Service not started`；`-l` 列插件、`-c` 配置、`-s` 启动 |
| `hiperf` / `hitrace` / `bytrace` / `hisysevent` | 均在 `/system/bin` |
| `hidumper -ls` | 可 dump 的系统服务约 60 个（RenderService / AccessibilityManagerService / AbilityManagerService / XpowerManager / MemoryManagerService / HiviewService …） |

---

## 五、能力矩阵更新

在 `05-capability-matrix.md` 基础上补充（已按「不依赖 hdc + 最快最稳」重排）：

| 能力 | 之前判断 | 现在 |
|---|---|---|
| **单张截图（最优）** | 只能 `uitest screenCap` | ✅ **agent MJPEG 起停 178 ms**，无 hdc shell/file |
| 单张截图（兜底） | — | ✅ `snapshot_display` 675 ms（走 hdc 双往返） |
| 窗口级静态截图 | ❌ 缺口 | ⚠️ **仍未解决** —— 所有截图路径都只能出整屏 |
| 截图缩放 | 只有 casting 整数倍 | ✅ agent `scale` 整数倍；`snapshot_display -w/-h` 任意（但慢） |
| PNG 输出 | 无 | ✅ 仅 `snapshot_display -t png` |
| **取 UI 树（最优）** | — | ✅ **agent `captureLayout` 473 ms**（CLI 970 ms） |
| **单次动作（最优）** | — | ✅ **agent 5.2 ms**（CLI 389 ms，75×） |
| Unix domain socket 传输 | 无 | ⚠️ agent 1.2.2 有，但 `captureScreen` 坏的、模块面窄 |
| fd 传递截图 | 理论可行 | ❌ 1.2.2 换了 unix socket 但截图管线本身坏了 |
| UI 操作录制 | 只有 agent `recordUiAction` | ⚠️ `uitest uiRecord` 可用但走 hdc shell；优先用 agent |
| 窗口级 layout | ✅ | ✅ 补充 `-w <windowId>` / `-b <bundle>`（但 CLI 慢 2×） |
| 无线调试 | 未验证 | ⚠️ `hdc tconn` 可用，但本机 AP 隔离导致直连不通 |
| **完全脱离 hdc** | 未验证 | ❌ **做不到** —— agent/casting 绑 loopback，perfmonitor 绑 0.0.0.0 但网络隔离 |
| 虚拟屏控制 | 未验证 | ❌ 只能内部用，无法配置 |
| 无障碍服务交互 | 未验证 | ❌ 只有 `accessibilityId` 属性 |
| AAMS 快速取节点 | 未验证 | ❌ 二进制里没有 |
| perfmonitor | ✅ 可用 | ❌ **`perfmonitor.so` 已无法加载**，只有 `_260608` 变体可用 |

---

## 六、对包设计的影响

按用户两条原则（**能不依赖 hdc 就不用；多种实现选最快最稳**）重排：

### 6.1 能力路由表

| 需求 | 首选 | 备选 | 理由 |
|---|---|---|---|
| 单张截图 | **agent `startCaptureScreen` + `stopCaptureScreen`** | `snapshot_display` | 178 ms vs 675 ms，且不碰 hdc shell/file |
| 连续画面 | **casting H.264** | agent MJPEG | 帧率高、数据量小 |
| 取 UI 树 | **agent `captureLayout`** | `uitest dumpLayout` | 473 ms vs 970 ms |
| 点击/滑动/按键 | **agent `CtrlCmd`/`Gestures`** | `uitest uiInput` | 5.2 ms vs 389 ms（75×） |
| 录制 MP4 | **casting `-m 1`** | perfmonitor | perfmonitor 加载不稳定 |
| 多路并发推流 | **casting**（多 socket 名） | — | 唯一支持并发的 |

**唯一必须用 CLI 的场景**：窗口级 layout（`dumpLayout -w/-b`）—— agent 的 `captureLayout` 没有窗口过滤参数。

### 6.2 架构

```
Node/TS 包
├── AgentClient   (TCP 8012 via fport)  → 动作 / UI 树 / 截图 / MJPEG  ← 主力
├── CastClient    (gRPC unix socket)    → H.264 推流 / MP4 录制        ← 高帧率
└── CliClient     (hdc shell)           → 窗口级 layout / uiRecord     ← 兜底
```

**perfmonitor 整个砍掉** —— 加载不稳定，功能被 casting 完全覆盖。

### 6.3 关于「不依赖 hdc」

现状是做不到的，原因不是设计选择而是设备约束：

- `agent.so` 硬编码绑 `127.0.0.1:8012`（`inet_addr` 字面量写死在二进制里）；
- `casting` / `agent 1.2.2` 用 abstract unix socket，天然不可远程访问；
- 唯一绑 `0.0.0.0` 的 perfmonitor，本机受 AP 隔离阻隔。

**要真正脱离 hdc 只有两条路**，都不可行：
1. 改扩展绑 `0.0.0.0` → 需重新编译 → XPM 拒绝（见 06）；
2. 关掉 AP 隔离 → 只有 perfmonitor 能用，而它本身加载都不稳。

**所以 fport 隧道是目前的最优解**：它不是「用 hdc 做业务」，只是用 hdc 建一条 TCP 隧道，隧道建好后业务流量是纯 TCP，实测单次 RPC 5.2 ms，开销可忽略。这是「不依赖 hdc 协议」而非「不依赖 hdc 进程」—— 已经尽可能贴近原则。

### 6.4 待确认

- `agent 1.2.2` 的 unix socket 若将来修好 `captureScreen`，可以省掉 fport（直接连 abstract socket 仍需隧道，因为 abstract socket 无法跨主机）。**实际上 1.2.2 并不能减少 hdc 依赖**，只是换了 socket 类型。
- AAMS 和虚拟屏都需要自建扩展，被 XPM 封死（见 06）。除非拿到更高版本 agent.so 或华为签名，否则这两块就是硬边界。
