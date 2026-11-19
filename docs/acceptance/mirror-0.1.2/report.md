# uitest-mirror 0.1.2 验收报告

> 本文件由 `scripts/acceptance-mirror.ts` 生成，请勿手改。生成时间：2026-11-20，提交 `5089788+dirty`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-mirror-0.1.2.tgz · uitest-mirror 0.1.2 (uitest-sdk 0.11.2) |
| `window` | 7544d645 | ✅ | live at http://127.0.0.1:58000/ |
| `bench` | 7544d645 | ✅ | first picture 597 ms · drag 63.8 fps (48/45 60 Hz slots) · input→frame median 47.4 ms |
| `click` | 7544d645 | ✅ | display "global exp" → "7" |
| `keyboard` | 7544d645 | ✅ | display now "123" |
| `scroll` | 7544d645 | ✅ | the history list moved (layout comparison; the list holds the person's own sums, so no picture is kept) |
| `keys` | 7544d645 | ✅ | three keys changed the device · recents proven by layout only (its screen shows other apps, so no picture is kept) |
| `record` | 7544d645 | ✅ | 160002 B · ftyp ok · picture live · stay-awake override 3600000 ms · override removed |
| `max-size` | 7544d645 | ✅ | longest 2560 → expected -scale 3, daemon got 3 · frame 534 px (bound 1024) |
| `no-control` | 7544d645 | ✅ | no key row; tap+enter dispatched left the display unchanged |
| `lease` | 7544d645 | ✅ | exit 1 · lease_held · this device already runs task "mirror" / If that task is gone, remove <state dir> |

## 汇总

通过 11，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-mirror.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
