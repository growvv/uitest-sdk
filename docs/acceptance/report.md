# uitest SDK 验收报告

> 本文件由 `scripts/acceptance.ts` 生成，请勿手改。生成时间：2026-11-17T13:30:39.243Z

## 1. 环境清单

| 项 | device |
|---|---|
| 设备 ID | 6c585f5b |
| 型号 | BRA-AL00 |
| API 版本 | 26 |
| ABI | arm64-v8a |
| 分辨率 | 1216x2688 |
| agent.so md5 | ebd787f91a55c968d837f09e80ad10cd  /data/local/tmp/agent.so |

## 2. 功能验收表

| 能力 | device |
|---|---|
| `connect` | ✅ 1216x2688 |
| `click` | ✅ 38 ms |
| `swipe` | ✅ 406 ms |
| `touch` | ✅ ok |
| `triggerKey` | ✅ ok |
| `captureLayout` | ✅ 349 nodes |
| `captureScreen` | ✅ 218 ms, 90523 B |
| `cropToWindow` | ✅ com.zhihu.hmos, 108519 B |
| `streamScreen` | ✅ 14.6 fps |
| `createCast` | ✅ h264, 31 B |
| `createCastRecord` | ✅ 1836156 B mp4 |
| `dualCast` | ✅ 31 B / 31 B |
| `dumpLayout` | ✅ 334 nodes |
| `queue` | ✅ 10 calls, 87 ms |
| `rpcDuringStream` | ✅ 9 ms |
| `streamUiActions` | ✅ session opens; synthetic touches are not reported (device behaviour) |

## 3. 性能（各能力端到端耗时）

| 能力 | 环境 | 耗时 |
|---|---|---|
| `connect` | device | 677 ms |
| `click` | device | 568 ms |
| `swipe` | device | 760 ms |
| `touch` | device | 373 ms |
| `triggerKey` | device | 623 ms |
| `captureLayout` | device | 1284 ms |
| `captureScreen` | device | 606 ms |
| `cropToWindow` | device | 2062 ms |
| `streamScreen` | device | 1105 ms |
| `createCast` | device | 1520 ms |
| `createCastRecord` | device | 5520 ms |
| `dualCast` | device | 7156 ms |
| `dumpLayout` | device | 1882 ms |
| `queue` | device | 707 ms |
| `rpcDuringStream` | device | 914 ms |
| `streamUiActions` | device | 1153 ms |

## 4. 失败与跳过项

_无_

## 5. 附录

- 截图：`docs/acceptance/screenshots/`（每个能力 × 环境一张，由 SDK 自己的 `captureScreen()` 产出）
- 日志：`docs/acceptance/logs/`（含时间戳与耗时）
- 最小复现脚本：`docs/acceptance/scripts/`

多实例专项验收见 `test/device/multi-instance.test.ts`（6 用例，独立进程）。
