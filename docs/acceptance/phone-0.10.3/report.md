# uitest-phone 0.10.3 验收报告

> 本文件由 `scripts/acceptance-phone.ts` 生成，请勿手改。生成时间：2026-11-19，提交 `1436469`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-phone-0.10.3.tgz · uitest-phone 0.10.3 (uitest-sdk 0.11.1) · --help exit 2 |
| `cmd-launch` | 7544d645 | ✅ | settled · 5330 ms |
| `cmd-observe` | 7544d645 | ✅ | settled · 4016 ms |
| `cmd-tap` | 7544d645 | ✅ | settled · 5630 ms |
| `cmd-type` | 7544d645 | ✅ | settled · 14889 ms |
| `cmd-swipe` | 7544d645 | ✅ | settled · 6003 ms |
| `cmd-double-click` | 7544d645 | ✅ | settled · 5574 ms |
| `cmd-drag` | 7544d645 | ✅ | settled · 6255 ms |
| `cmd-fling` | 7544d645 | ✅ | settled · 5903 ms |
| `cmd-pinch` | 7544d645 | ✅ | settled · 6450 ms |
| `cmd-wait-for` | 7544d645 | ✅ | settled · 24226 ms |
| `cmd-read-list` | 7544d645 | ✅ | settled · 8042 ms |
| `cmd-scroll-until` | 7544d645 | ✅ | settled · 9454 ms |
| `cmd-key` | 7544d645 | ✅ | settled · 5892 ms |
| `cmd-apps` | 7544d645 | ✅ | settled |
| `cmd-window` | 7544d645 | ✅ | settled |
| `cmd-doctor` | 7544d645 | ✅ | settled · doctor |
| `cmd-screenshot` | 7544d645 | ✅ | settled · 49 KB |
| `cmd-inspect` | 7544d645 | ✅ | settled · 156 KB |
| `cmd-report` | 7544d645 | ✅ | settled |
| `cmd-status` | 7544d645 | ✅ | settled · connected |
| `cmd-handoff` | 7544d645 | ✅ | handoff exit 0 · resume exit 0 |
| `approval-pending` | 7544d645 | ✅ | approval_pending · id b948e4275bf7 · 60 s |
| `approval-unanswered` | 7544d645 | ✅ | replay without a decision → exit 3 (expect 3) |
| `approval-agent-cannot-answer` | 7544d645 | ✅ | after an unanswered replay the approval b948e4275bf7 holds 0 decision file(s) (expect 0) |
| `approval-deny` | 7544d645 | ✅ | denied b948e4275bf7 |
| `approval-denied-replay` | 7544d645 | ✅ | exit 4 (expect 4) · acceptance: deny path |
| `approval-allow` | 7544d645 | ✅ | allow exit 0 · replay exit 0 (expect 0) |
| `approval-single-use` | 7544d645 | ✅ | replay of the used id → exit 4 (expect 4) |
| `hold-blocks-agent` | 7544d645 | ✅ | hold exit 0 · observe exit 2 (expect 2) |
| `resume-releases` | 7544d645 | ✅ | resume exit 0 · observe exit 0 (expect 0) |
| `mcp` | 7544d645 | ✅ | 21 个工具 · uitest_observe → screen 1600x2560 · app: com.huawei.hmos.calculator · rotatio |
| `skill-install` | host | ✅ | install 0 · marker 0.10.3 · 再装 2（期望非 0）· --force 0 |
| `live-moved` | host | ✅ | live moved to uitest-console · npm i -g uitest-console · uitest-console |

## 汇总

通过 34，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-phone.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
