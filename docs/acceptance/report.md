# uitest SDK 验收报告

> 本文件由 `scripts/acceptance.ts` 生成，请勿手改。生成时间：2026-11-17T11:26:11.056Z

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
| `click` | ✅ 43 ms |
| `swipe` | ✅ 403 ms |
| `touch` | ✅ ok |
| `triggerKey` | ✅ ok |
| `captureLayout` | ✅ 428 nodes |
| `captureScreen` | ✅ 204 ms, 78949 B |
| `cropToWindow` | ✅ com.zhihu.hmos, 96598 B |
| `streamScreen` | ✅ 11.3 fps |
| `createCast` | ✅ h264, 31 B |
| `createCastRecord` | ✅ 1379221 B mp4 |
| `dualCast` | ✅ 31 B / 31 B |
| `dumpLayout` | ✅ 317 nodes |
| `queue` | ✅ 10 calls, 89 ms |
| `rpcDuringStream` | ✅ 8 ms |
| `streamUiActions` | ✅ session opens; synthetic touches are not reported (device behaviour) |

## 3. 性能（各能力端到端耗时）

| 能力 | 环境 | 耗时 |
|---|---|---|
| `connect` | device | 1102 ms |
| `click` | device | 567 ms |
| `swipe` | device | 763 ms |
| `touch` | device | 386 ms |
| `triggerKey` | device | 630 ms |
| `captureLayout` | device | 1854 ms |
| `captureScreen` | device | 601 ms |
| `cropToWindow` | device | 2128 ms |
| `streamScreen` | device | 1301 ms |
| `createCast` | device | 1507 ms |
| `createCastRecord` | device | 5034 ms |
| `dualCast` | device | 3821 ms |
| `dumpLayout` | device | 1899 ms |
| `queue` | device | 669 ms |
| `rpcDuringStream` | device | 765 ms |
| `streamUiActions` | device | 1163 ms |

## 4. 失败与跳过项

_无_

## 5. 附录

- 截图：`docs/acceptance/screenshots/`（每个能力 × 环境一张，由 SDK 自己的 `captureScreen()` 产出）
- 日志：`docs/acceptance/logs/`（含时间戳与耗时）
- 最小复现脚本：`docs/acceptance/scripts/`

多实例专项验收见 `test/device/multi-instance.test.ts`（6 用例，独立进程）。
