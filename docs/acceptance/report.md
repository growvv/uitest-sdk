# uitest SDK 验收报告

> 本文件由 `scripts/acceptance.ts` 生成，请勿手改。生成时间：2026-11-16T15:33:06.917Z

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
| `click` | ✅ 17 ms |
| `swipe` | ✅ 399 ms |
| `touch` | ✅ ok |
| `triggerKey` | ✅ ok |
| `captureLayout` | ✅ 214 nodes |
| `captureScreen` | ✅ 176 ms, 88014 B |
| `cropToWindow` | ✅ com.zhihu.hmos, 107610 B |
| `streamScreen` | ✅ 11.8 fps |
| `createCast` | ✅ h264, 31 B |
| `createCastRecord` | ✅ 1796167 B mp4 |
| `dualCast` | ✅ 31 B / 31 B |
| `dumpLayout` | ✅ 324 nodes |
| `queue` | ✅ 10 calls, 75 ms |
| `rpcDuringStream` | ✅ 5 ms |
| `streamUiActions` | ✅ session opens; synthetic touches are not reported (device behaviour) |

## 3. 性能（各能力端到端耗时）

| 能力 | 环境 | 耗时 |
|---|---|---|
| `connect` | device | 861 ms |
| `click` | device | 467 ms |
| `swipe` | device | 749 ms |
| `touch` | device | 394 ms |
| `triggerKey` | device | 721 ms |
| `captureLayout` | device | 819 ms |
| `captureScreen` | device | 530 ms |
| `cropToWindow` | device | 1264 ms |
| `streamScreen` | device | 1201 ms |
| `createCast` | device | 1410 ms |
| `createCastRecord` | device | 5121 ms |
| `dualCast` | device | 36765 ms |
| `dumpLayout` | device | 1895 ms |
| `queue` | device | 779 ms |
| `rpcDuringStream` | device | 881 ms |
| `streamUiActions` | device | 1079 ms |

## 4. 失败与跳过项

_无_

## 5. 附录

- 截图：`docs/acceptance/screenshots/`（每个能力 × 环境一张，由 SDK 自己的 `captureScreen()` 产出）
- 日志：`docs/acceptance/logs/`（含时间戳与耗时）
- 最小复现脚本：`docs/acceptance/scripts/`

多实例专项验收见 `test/device/multi-instance.test.ts`（6 用例，独立进程）。
