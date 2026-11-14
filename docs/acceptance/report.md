# uitest SDK 验收报告

> 本文件由 `scripts/acceptance.ts` 生成，请勿手改。生成时间：2026-11-14T23:02:18.340Z

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
| `click` | ✅ 35 ms |
| `swipe` | ✅ 443 ms |
| `touch` | ✅ ok |
| `triggerKey` | ✅ ok |
| `captureLayout` | ✅ 178 nodes |
| `captureScreen` | ✅ 193 ms, 74402 B |
| `cropToWindow` | ✅ com.huawei.hmos.settings, 97618 B |
| `streamScreen` | ✅ 15.1 fps |
| `createCast` | ✅ h264, 31 B |
| `createCastRecord` | ✅ 335615 B mp4 |
| `dualCast` | ✅ 31 B / 31 B |
| `dumpLayout` | ✅ 178 nodes |
| `queue` | ✅ 10 calls, 44 ms |
| `rpcDuringStream` | ✅ 5 ms |
| `streamUiActions` | ✅ session opens; synthetic touches are not reported (device behaviour) |

## 3. 性能（各能力端到端耗时）

| 能力 | 环境 | 耗时 |
|---|---|---|
| `connect` | device | 237 ms |
| `click` | device | 139 ms |
| `swipe` | device | 546 ms |
| `touch` | device | 106 ms |
| `triggerKey` | device | 197 ms |
| `captureLayout` | device | 389 ms |
| `captureScreen` | device | 195 ms |
| `cropToWindow` | device | 1175 ms |
| `streamScreen` | device | 671 ms |
| `createCast` | device | 1926 ms |
| `createCastRecord` | device | 4603 ms |
| `dualCast` | device | 3310 ms |
| `dumpLayout` | device | 1459 ms |
| `queue` | device | 284 ms |
| `rpcDuringStream` | device | 239 ms |
| `streamUiActions` | device | 684 ms |

## 4. 失败与跳过项

_无_

## 5. 附录

- 截图：`docs/acceptance/screenshots/`（每个能力 × 环境一张，由 SDK 自己的 `captureScreen()` 产出）
- 日志：`docs/acceptance/logs/`（含时间戳与耗时）
- 最小复现脚本：`docs/acceptance/scripts/`

多实例专项验收见 `test/device/multi-instance.test.ts`（6 用例，独立进程）。
