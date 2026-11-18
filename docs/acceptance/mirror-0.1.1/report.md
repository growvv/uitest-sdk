# uitest-mirror 0.1.1 验收报告

> 本文件由 `scripts/acceptance-mirror.ts` 生成，请勿手改。生成时间：2026-11-19，提交 `3ae6a42+dirty`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-mirror-0.1.1.tgz · uitest-mirror 0.1.1 (uitest-sdk 0.11.1) |
| `window` | 7544d645 | ✅ | live at http://127.0.0.1:64424/ |
| `click` | 7544d645 | ✅ | display "global exp" → "7" |
| `keyboard` | 7544d645 | ✅ | display now "123" |
| `scroll` | 7544d645 | ✅ | the history list moved (layout comparison; the list holds the person's own sums, so no picture is kept) |
| `keys` | 7544d645 | ✅ | three keys changed the device · recents proven by layout only (its screen shows other apps, so no picture is kept) |
| `record` | 7544d645 | ✅ | 216412 B · ftyp ok · picture live · stay-awake override 3600000 ms · override removed |
| `max-size` | 7544d645 | ✅ | longest 2560 → expected -scale 3, daemon got 3 · frame 534 px (bound 1024) |
| `no-control` | 7544d645 | ✅ | no key row; tap+enter dispatched left the display unchanged |
| `lease` | 7544d645 | ✅ | exit 1 · lease_held · this device already runs task "mirror" / If that task is gone, remove <state dir> |

## 汇总

通过 10，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-mirror.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
