# 04 · `perfmonitor.so` —— HTTP 录屏服务

| 项 | 值 |
|---|---|
| 文件 | `/data/local/tmp/perfmonitor.so`（354,487 B） |
| 进程名 | `perfmonitor`（`prctl(PR_SET_NAME)`） |
| 入口 | `OnInit` @ `0x12ae4` = 72 B 空桩（返回 0）；`OnRun` @ `0x12b2c`（1260 B）**阻塞** |
| 传输 | **cpp-httplib HTTP server，绑定 `0.0.0.0:9999`** |
| 实现 | `OHOS::Scrcpy::ScreenCopy`：虚拟屏 mirror + `OH_VideoEncoder`(H.264) + `OH_AVMuxer`(MP4) |

**注意**：它不是 RPC 扩展，完全绕开 uitest 的 hypium 协议，自己起 HTTP 服务。

## 启动

```sh
/system/bin/uitest start-daemon singleness --extension-name perfmonitor.so
hdc fport tcp:19999 tcp:9999
```

无需任何参数，端口硬编码 `9999`（`mov w2, #0x270f`）。

## 四个端点

| 端点 | 方法 | 返回 |
|---|---|---|
| `/StartRecord` | GET | `Success` / `Already running` |
| `/StopRecord` | GET | `Success` / `Already closed` |
| `/GetRecordStatus` | GET | `Running` / `Not running` |
| `/GetMonotonicTime` | GET | `clock_gettime(MONOTONIC)` 毫秒字符串 |

全部 `Content-Type: text/plain`。

### `/StartRecord` 的 query 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `video_name` | — | 输出文件名，落在 `/data/local/tmp/perf_fact/video/<video_name>` |
| `queueSize` | — | 编码队列深度 |
| `scale` | 1 | 缩放 |
| `timeout` | `43200`（`0xa8c0`） | 等待单位，日志 `start waiting 43200` |

示例：

```sh
curl "http://127.0.0.1:19999/StartRecord?video_name=rea3&queueSize=8"
curl "http://127.0.0.1:19999/GetRecordStatus"
curl "http://127.0.0.1:19999/StopRecord"
hdc file recv /data/local/tmp/perf_fact/video/rea3 ./rea3.mp4
```

## 实测数据

| 项 | 结果 |
|---|---|
| 4 个端点 | 全部 `200 text/plain` ✅ |
| `StartRecord` | `Success`；状态 `Not running` → `Running` |
| 录 12 次滑动 | 文件增长到 1,198,976 B |
| `StopRecord` | 首次 `Success`，再次 `Already closed` |
| 容器 | `ftyp`(28) + `free`(8) + `mdat`(1,108,620) + `moov`(90,320) |
| 编码 | `avcC = 01 64 00 32 ff e1 ...` → **H.264 High profile, level 5.0** |
| 轨道 | `avc1` 1216×2688，timescale 90000，7473 samples，时长 136.50 s |

## 行为特点

- **懒编码**：画面不动时文件停在 44 字节（只有头）。有画面变化才写 mdat。
- 超时路径：日志 `start waiting 43200` → `jump waiting`。
- 输出目录固定 `/data/local/tmp/perf_fact/video/`，附带 `/data/local/tmp/lockScreenSize.txt`、`/data/local/tmp/vir_refresh` 两个辅助文件。
- 错误字符串（对应内部错误分支）：`<501 not support>` `<504 binder occur error>` `<406 no screen>` `<500 api call failed>` `<412 not init>` `<400 invalid arguments>` `<406 no buffer>` `<403 no permission>` `<412 no consumer>` `<406 no entry>` `<500 no memory>`

## 与 `libscreen_casting.z.so` 的分工

| | `perfmonitor.so` | `libscreen_casting.z.so -m 1` |
|---|---|---|
| 协议 | HTTP | gRPC |
| 传输 | TCP 9999（可直连） | Unix abstract socket |
| 参数 | query string | argv |
| 输出 | 固定目录 MP4 | `/data/local/tmp/mytest.mp4` |
| 多实例 | 不行（端口硬编码） | 可以（改 socket 名） |
| 流式 | ❌ 只能落盘 | ✅ `-m 0` 出 H.264 流 |

**推流用 `libscreen_casting`，落盘录制两者都行**；需要并发多路录制时必须用 `libscreen_casting`（改 socket 名）。
