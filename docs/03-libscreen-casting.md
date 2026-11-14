# 03 · `libscreen_casting.z.so` —— gRPC H.264 推流 / 录屏

| 项 | 值 |
|---|---|
| 文件 | `/data/local/tmp/libscreen_casting.z.so`（247,989 B） |
| 版本串 | `6.8-20260801` |
| HiLog tag | `DevEcoScrcpy` |
| 进程名 | `xdevice_scrcpy` |
| 入口 | `OnInit` @ `0x172f8`（1724 B）**阻塞**；`OnRun` @ `0x17d20` = 8 字节空实现 |
| 传输 | **Unix abstract socket**（不是 TCP） |
| 协议 | gRPC + protobuf 3（静态链接 abseil 20250127） |

## 启动

```sh
/system/bin/uitest start-daemon singleness \
  --extension-name libscreen_casting.z.so \
  -m <0|1> -screenId 0 [-scrcpy_socket_name N] [-record_socket_name N] [其他参数]
```

`-p <port>` **已被废弃**，日志固定打印 `[deprecated] port <N>.`，实际只监听 abstract socket。

## 两种模式 = 两个 socket

| `-m` | 监听 socket | 用途 |
|---|---|---|
| `0` | `scrcpySocketName`（默认 `scrcpy_grpc_socket`） | 实时 H.264 推流 |
| `1` | `recordSocketName`（默认 `screen_record_grpc_socket`） | MP4 录制到 `/data/local/tmp/mytest.mp4` |

socket 名可用 `-scrcpy_socket_name` / `-record_socket_name` 覆盖，**这是并发多实例的唯一办法**（实测可同时跑多个进程，各监听不同 abstract name）。

连接：`hdc fport tcp:<本地> localabstract:<socket名>`

## 参数全表

| 参数 | 默认 | 实测行为 |
|---|---|---|
| `-p` | 5000 | 废弃，忽略 |
| `-m` | 0 | 0=推流，1=录制 |
| `-screenId` | 0 | 虚拟屏关联的物理屏 |
| `-scrcpy_socket_name` | `scrcpy_grpc_socket` | ✅ 生效 |
| `-record_socket_name` | `screen_record_grpc_socket` | ✅ 生效 |
| `-scale` | 1 | **整数倍缩小**；`2` → 608×1344；`0.5` 被拒回 1；上限 5 |
| `-frameRate` | 2 | 只认 **15/30/60/120**；内部 `frameRefreshInterval = 120/fps`；其他值静默回 2（=不按定时器、跟随显示刷新） |
| `-bitRate` | 31457280 (30 MB) | ✅ 透传给 `OH_MD_KEY_BITRATE` |
| `-iFrameInterval` | 2000 | ✅ |
| `-appPid` | 0xFFFFFFFF | ✅ 日志可见 |
| `-repeatInterval` | 0 | 解析但实测无效（静态画面仍 0 帧） |
| `-s` | 0 | **saveFrame**：每帧写一个 `.h264` 到 `/data/local/tmp/xdevice_record_data/<pts>.h264` |
| `-virtual_keyboard_height` | 0 | ✅ 日志可见 |

> `-saveFrame` 不是合法参数名；saveFrame 由 `-s` 控制。

## gRPC 接口

复原的 proto（与 devicetest 包内的 `scrcpy_pb2.py` 逐字节一致）：

```proto
syntax = "proto3";
message ReplyMessage {
  string data = 1;                       // 恒为空，实际不用
  int32 reply_type = 2;
  map<string, ParamValue> payload = 3;   // 真数据在这里
}
message ParamValue {
  oneof values {
    int64 val_int = 1; double val_double = 2; string val_string = 3;
    bool val_bool = 4; bytes val_bytes = 5; float val_float = 6;
  }
}
message ReplyEndMessage { int32 frame_count = 1; }
message Empty {}
service ScrcpyService {
  rpc onStart(Empty) returns (stream ReplyMessage);   // 推流
  rpc onEnd(Empty) returns (ReplyEndMessage);         // 停止
  rpc onRequestIDRFrame(Empty) returns (ReplyEndMessage); // 请求关键帧
}
```

完整路径：`/ScrcpyService/onStart`、`/ScrcpyService/onEnd`、`/ScrcpyService/onRequestIDRFrame`。

### `payload` 字段

| key | 类型 | 含义 |
|---|---|---|
| `len` | int64 | 本帧字节数 |
| `pts` | int64 | 时间戳（微秒量级，实测相邻差 1~323） |
| `flags` | int64 | `8`=SPS/PPS（31 B）、`2`=IDR、`0`=P 帧 |
| `data` | **bytes** | Annex-B H.264（`00 00 00 01` 起始码） |

### 返回

- `onEnd` → `ReplyEndMessage{frame_count}`，同时销毁编码器、关闭虚拟屏。
- `onRequestIDRFrame` → `ReplyEndMessage{frame_count}`（返回的是**当前累计帧数**，不是新增数）。

## 实测数据

| 场景 | 结果 |
|---|---|
| 分辨率 | 1216×2688（`avc1`，`avcC 01 64 00 34` = High profile, level 5.2） |
| `-frameRate 15` + 连续滑动 | 13.6 fps |
| `-frameRate 60` | 71.5 fps |
| `-frameRate 120` | 89.1 fps |
| 10 s 推流样本 | 668 帧 / 109,675 B，NAL 分布 `{7:1, 8:1, 5:3, 1:664}` |
| `-m 1` 录制 159 s | 1,966,629 B / 10,908 samples / `moov` 131,720 B |
| `-s 1` saveFrame | 852 帧会话产出 854 个 `.h264`（479 KB） |
| `-scale 2` | `actual screen 608x1344`，`video width=608` |

## 四个必须知道的坑

### 1. `onEnd` 是粘性的（最坑）

一旦任何客户端调用过 `onEnd`，该进程内 `ReplyVideoData` 每帧都打印
`Server has called stop.`，此后**永远出不了帧**。必须一 session 一进程。

### 2. `onStart` 不能重复调用

同进程第二次 `onStart` 会起第二个编码器，帧被第一条路径吞掉。

### 3. 静态画面 0 帧

编码器是**脏区驱动**的。屏幕不动 = 没有任何帧（不是重复推同一帧）。
客户端要么驱动 UI，要么接受「无变化即无数据」。

### 4. 客户端 deadline 就是 session 生命周期

`grpc` 的 `timeout` 到期后服务端日志出现 `Server context has cancelled.`，编码器立即销毁。
长连接必须用 `timeout=None` 或足够大的值，并自己控制关闭时机。

## 与官方客户端的差异

`devicetest 6.1.0.210` 里的 `record_agent.py` 用的是：

```python
fport tcp:<local> localabstract:screen_record_grpc_socket
uitest start-daemon singleness --extension-name libscreen_recorder.z.so -p <port> -m 1 -screenId <id>
```

即 **`libscreen_recorder.z.so` + `-m 1`**，然后 `stub.onStart(...)` 拿流、`stub.onEnd(...)` 拿 `frame_count`。

本机这个 `libscreen_casting.z.so`（6.8 版）把两种模式合并了：`-m 0` 出流，`-m 1` 出 MP4。
若只想要流，**不要**用 `-m 1`（会走 muxer，`onStart` 返回 0 帧）。
