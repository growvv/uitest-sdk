# uitest-console 0.1.0 验收报告

> 本文件由 `scripts/acceptance-console.ts` 生成，请勿手改。生成时间：2026-11-18，提交 `6423f4d`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 6c585f5b | BRA-AL00 | 1216x2688 |
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-console-0.1.0.tgz · uitest-console 0.1.0 (uitest-sdk 0.10.0) |
| `console-mirror` | 6c585f5b | ✅ | 56601 · 0 notes |
| `console-inspect` | 6c585f5b | ✅ | 16 node rows |
| `console-inbox-pending` | 6c585f5b | ✅ | 1 行 · id cb7f5ec303e0 |
| `console-inbox-allow` | 6c585f5b | ✅ | replay exit 0 (expect 0) · page row: cb7f5ec303e0 tap deletes allowedcom.huawei.hmos.calculator · task tap · device |
| `console-hold` | 6c585f5b | ✅ | hold button → Resume · agent observe exit 2 (expect 2) |
| `console-resume` | 6c585f5b | ✅ | button on join → Resume, after click → Resume · agent observe exit 0 (expect 0) |
| `console-privacy` | 6c585f5b | ✅ | privacy on->off->on |
| `console-selfcontained` | 6c585f5b | ✅ | 0 local resources |
| `console-origin` | 6c585f5b | ✅ | own origin=101 · another site=403 · null origin=403 · DNS rebinding=403 |
| `console-mirror` | 7544d645 | ✅ | 49836 · 0 notes |
| `console-inspect` | 7544d645 | ✅ | 8 node rows |
| `console-inbox-pending` | 7544d645 | ✅ | 1 行 · id ced84f2ff75c |
| `console-inbox-allow` | 7544d645 | ✅ | replay exit 0 (expect 0) · page row: ced84f2ff75c tap deletes allowedcom.huawei.hmos.calculator · task tap · device |
| `console-hold` | 7544d645 | ✅ | hold button → Resume · agent observe exit 2 (expect 2) |
| `console-resume` | 7544d645 | ✅ | button on join → Resume, after click → Resume · agent observe exit 0 (expect 0) |
| `console-privacy` | 7544d645 | ✅ | privacy on->off->on |
| `console-selfcontained` | 7544d645 | ✅ | 0 local resources |
| `console-origin` | 7544d645 | ✅ | own origin=101 · another site=403 · null origin=403 · DNS rebinding=403 |

## 汇总

通过 19，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-console.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
