# uitest-console 0.1.3 验收报告

> 本文件由 `scripts/acceptance-console.ts` 生成，请勿手改。生成时间：2026-11-19，提交 `3ae6a42+dirty`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-console-0.1.3.tgz · uitest-console 0.1.3 (uitest-sdk 0.11.1) |
| `console-mirror` | 7544d645 | ✅ | 57422 · 0 notes |
| `console-inspect` | 7544d645 | ✅ | 9 node rows |
| `console-inbox-pending` | 7544d645 | ✅ | 1 行 · id 2d339940e452 |
| `console-inbox-allow` | 7544d645 | ✅ | replay exit 0 (expect 0) · page row: 2d339940e452 tap deletes allowedcom.huawei.hmos.calculator · task tap · device |
| `console-hold` | 7544d645 | ✅ | hold button → Resume · agent observe exit 2 (expect 2) |
| `console-resume` | 7544d645 | ✅ | button on join → Resume, after click → Resume · agent observe exit 0 (expect 0) |
| `console-privacy` | 7544d645 | ✅ | privacy on->off->on |
| `console-selfcontained` | 7544d645 | ✅ | 0 local resources |
| `console-origin` | 7544d645 | ✅ | own origin=101 · another site=403 · null origin=403 · DNS rebinding=403 |

## 汇总

通过 10，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-console.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
