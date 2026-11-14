# uitest SDK 验收报告

> 本文件由 `scripts/acceptance.ts` 生成，请勿手改。生成时间：2026-11-14T23:02:48.411Z

## 1. 环境清单

| 项 | device |
|---|---|
| 设备 ID | <your-device-id> |
| 型号 | BRA-AL00 |
| API 版本 | 26 |
| ABI | arm64-v8a |
| 分辨率 | 1216x2688 |
| agent.so md5 | ebd787f91a55c968d837f09e80ad10cd  /data/local/tmp/agent.so |

## 2. 功能验收表

| 能力 | device |
|---|---|
| `connect` | ✅ 1216x2688 |
| `click` | ✅ 36 ms |
| `swipe` | ✅ 418 ms |
| `touch` | ✅ ok |
| `triggerKey` | ✅ ok |
| `captureLayout` | ✅ 178 nodes |
| `captureScreen` | ✅ 147 ms, 74402 B |
| `cropToWindow` | ✅ com.huawei.hmos.settings, 97618 B |
| `streamScreen` | ✅ 17.4 fps |
| `createCast` | ✅ h264, 31 B |
| `createCastRecord` | ✅ 334141 B mp4 |
| `dualCast` | ✅ 31 B / 31 B |
| `dumpLayout` | ✅ 178 nodes |
| `queue` | ✅ 10 calls, 33 ms |
| `rpcDuringStream` | ✅ 4 ms |
| `streamUiActions` | ✅ session opens; synthetic touches are not reported (device behaviour) |

## 3. 性能（各能力端到端耗时）

| 能力 | 环境 | 耗时 |
|---|---|---|
| `connect` | device | 183 ms |
| `click` | device | 155 ms |
| `swipe` | device | 516 ms |
| `touch` | device | 111 ms |
| `triggerKey` | device | 191 ms |
| `captureLayout` | device | 377 ms |
| `captureScreen` | device | 147 ms |
| `cropToWindow` | device | 1168 ms |
| `streamScreen` | device | 584 ms |
| `createCast` | device | 1868 ms |
| `createCastRecord` | device | 4875 ms |
| `dualCast` | device | 5480 ms |
| `dumpLayout` | device | 1455 ms |
| `queue` | device | 238 ms |
| `rpcDuringStream` | device | 264 ms |
| `streamUiActions` | device | 750 ms |

## 4. 失败与跳过项

_无_

## 5. 附录

- 截图：`docs/acceptance/screenshots/`（每个能力 × 环境一张，由 SDK 自己的 `captureScreen()` 产出）
- 日志：`docs/acceptance/logs/`（含时间戳与耗时）
- 最小复现脚本：`docs/acceptance/scripts/`

多实例专项验收见 `test/device/multi-instance.test.ts`（6 用例，独立进程）。
