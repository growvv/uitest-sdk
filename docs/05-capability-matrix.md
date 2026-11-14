# 05 · 三者能力对照

## 总表

| 能力 | `agent.so` | `libscreen_casting.z.so` | `perfmonitor.so` |
|---|---|---|---|
| **点击 / 长按 / 双击** | ✅ 坐标 + 组件 | ❌ | ❌ |
| **滑动 / 拖拽 / fling** | ✅ | ❌ | ❌ |
| **多指手势（pinch 等）** | ✅ PointerMatrix | ❌ | ❌ |
| **鼠标 / 手写笔** | ✅ 全套 | ❌ | ❌ |
| **按键 / 组合键 / Home / Back** | ✅ | ❌ | ❌ |
| **文本输入** | ✅ | ❌ | ❌ |
| **UI 组件树 dump** | ✅ `captureLayout`（185 KB） | ❌ | ❌ |
| **组件查找 / 属性 / 动作** | ✅ 全套 On/Component | ❌ | ❌ |
| **窗口枚举 / 操作** | ✅ UiWindow（focus/move/resize/split/close） | ❌ | ❌ |
| **UI 事件观察** | ✅ `UIEventObserver.once` | ❌ | ❌ |
| **屏幕旋转 / 唤醒** | ✅ | ❌ | ❌ |
| **静态截图** | ✅ `startCaptureScreen` 起停 **178 ms**（最优） | ❌（只能从视频流抽 IDR） | ❌ |
| **JPEG 推屏** | ✅ ~15 fps @608×1344 | ❌ | ❌ |
| **H.264 推流** | ❌ | ✅ 最高 ~89 fps | ❌ |
| **MP4 录制** | ❌ | ✅ `-m 1` | ✅ HTTP 触发 |
| **窗口级截图 RPC** | ❌（fd 通道不可用） | ❌ | ❌ |

## 按需求映射

用户原始需求四项：

| 需求 | 覆盖情况 |
|---|---|
| 补官方缺口（窗口级截图 / 多路推流） | **多路推流 ✅**（改 socket 名可并发）；**窗口级截图 ❌** —— 三个 .so 都没有暴露 RPC |
| 高性能推流（替代 MJPEG） | **✅ 完全覆盖** —— `libscreen_casting` H.264，89 fps vs agent 的 15 fps JPEG |
| 设备侧动作 / 事件原语 | **✅ 完全覆盖** —— `agent.so` 的 `Gestures.touchDown/Move/Up` + `Driver.*` |
| 通用设备侧执行器 | **✅ 覆盖** —— `agent.so` 就是通用执行器 |

## 唯一缺口：窗口级静态截图

**整屏截图已解决**（agent `startCaptureScreen` 起停 178 ms）。剩下的真缺口是**窗口级**：

1. `agent.so` 的 `Driver.screenCap(fd)` / `screenCapture(fd, Rect)` 走 **IPC 文件描述符传递**（`MessageParcel::WriteFileDescriptor`）。裸 TCP JSON 客户端没有 SCM_RIGHTS，实测传 fd 只得到 0 字节文件。
2. `libscreen_casting` 只能出 H.264 流，要图得自己解码一个 IDR 帧。
3. `perfmonitor` 只能出 MP4（且 `perfmonitor.so` 现在已无法加载）。
4. `snapshot_display` / `uitest screenCap` / agent `startCaptureScreen` **全部只能出整屏**，没有 `windowId` / `bundle` 参数。
5. `dumpLayout` 有 `-w <windowId>` / `-b <bundle>` 可以只 dump 某窗口的树，但**截图侧没有对应能力**。

**可行的绕法**：先用 `dumpLayout -w <id>` 拿到目标窗口的 `bounds`，再整屏截图 + 按 bounds 裁剪。精度受窗口圆角/阴影影响，但无需新扩展。

**可选路线（按代价排序）**：

| 方案 | 实测耗时 | 说明 |
|---|---|---|
| **`agent.so` `startCaptureScreen` + `stopCaptureScreen` 起停一次** | **178 ms** | **最优**：一条长连接，无进程 fork、无文件传输。取第一帧即停 |
| `snapshot_display -f x.jpeg` + `file recv` | 675 ms | 兜底：不依赖 daemon，但走 hdc shell + pull 两次往返 |
| 从 H.264 流抽 IDR 解码 | 需解码器 | 连续画面用；单张不划算（要等 IDR） |
| `uitest screenCap -p` + pull | ~970 ms | 最慢，不要用 |
| 走 IPC 通道（复刻 `ApiTransactor`） | — | 理论最优，工作量大；且 1.2.2 的 `captureScreen` 本身就是坏的 |

> 上表是 2026-11-15 实测。此前文档里写的「`snapshot_display` 460 ms」只算了 shell 段，漏了 `file recv` 的 ~120 ms 和 agent 路径的对比。

## 推荐架构

```
Node/TS 包
├── AgentClient      (TCP 8012, 换行 JSON)     → 动作 / 组件树 / 事件 / 截图 / MJPEG  ← 主力
├── CastClient       (gRPC, unix socket)       → H.264 推流 / 录屏 / IDR 请求         ← 高帧率
└── CliClient        (hdc shell)               → 窗口级 layout / uiRecord             ← 兜底
```

**perfmonitor 砍掉** —— 加载不稳定（缺 `ResizeVirtualScreen` 符号），功能被 casting `-m 1` 完全覆盖。

按「能不依赖 hdc 就不用 + 选最快最稳」路由：

- **动作 / 感知 / 单张截图** → AgentClient（5.2 ms / 473 ms / 178 ms）
- **高帧率画面 / 并发多路录制** → CastClient（每路一个 `-scrcpy_socket_name`）
- **窗口级 layout** → CliClient（agent 的 `captureLayout` 没有窗口过滤参数）

> AgentClient 仍需 `hdc fport` 建隧道（agent 硬编码绑 `127.0.0.1`），但隧道建好后是纯 TCP，单次 RPC 5.2 ms，无 hdc 协议开销。

## 多实例并发（已实测）

`libscreen_casting.z.so` 可以同时起多个进程，各自监听不同 abstract socket：

```sh
uitest start-daemon singleness --extension-name libscreen_casting.z.so -m 0 -scrcpy_socket_name cast_a
uitest start-daemon singleness --extension-name libscreen_casting.z.so -m 0 -scrcpy_socket_name cast_b
hdc fport tcp:16001 localabstract:cast_a
hdc fport tcp:16002 localabstract:cast_b
```

实测同时存在 6 个 `libscreen_casting` 进程，各自 `InitServer` 成功。

`agent.so` 和 `perfmonitor.so` **不能**并发：前者固定 `127.0.0.1:8012`，后者固定 `0.0.0.0:9999`。
