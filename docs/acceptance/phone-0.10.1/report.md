# uitest-phone 0.10.1 验收报告

> 本文件由 `scripts/acceptance-phone.ts` 生成，请勿手改。生成时间：2026-11-18，提交 `e5946be`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 6c585f5b | BRA-AL00 | 1216x2688 |
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-phone-0.10.1.tgz · uitest-phone 0.10.1 (uitest-sdk 0.10.1) · --help exit 2 |
| `cmd-launch` | 6c585f5b | ✅ | settled · 3618 ms |
| `cmd-observe` | 6c585f5b | ✅ | settled · 2303 ms |
| `cmd-tap` | 6c585f5b | ✅ | settled · 4165 ms |
| `cmd-type` | 6c585f5b | ✅ | settled · 8996 ms |
| `cmd-swipe` | 6c585f5b | ✅ | settled · 3959 ms |
| `cmd-double-click` | 6c585f5b | ✅ | settled · 3513 ms |
| `cmd-drag` | 6c585f5b | ✅ | settled · 4490 ms |
| `cmd-fling` | 6c585f5b | ✅ | settled · 3683 ms |
| `cmd-pinch` | 6c585f5b | ✅ | settled · 4693 ms |
| `cmd-wait-for` | 6c585f5b | ✅ | settled · 15234 ms |
| `cmd-read-list` | 6c585f5b | ✅ | settled · 3946 ms |
| `cmd-scroll-until` | 6c585f5b | ✅ | settled · 6025 ms |
| `cmd-key` | 6c585f5b | ✅ | settled · 4124 ms |
| `cmd-apps` | 6c585f5b | ✅ | settled |
| `cmd-window` | 6c585f5b | ✅ | settled |
| `cmd-doctor` | 6c585f5b | ✅ | settled · doctor |
| `cmd-screenshot` | 6c585f5b | ✅ | settled · 43 KB |
| `cmd-inspect` | 6c585f5b | ✅ | settled · 133 KB |
| `cmd-report` | 6c585f5b | ✅ | settled |
| `cmd-status` | 6c585f5b | ✅ | settled · connected |
| `cmd-handoff` | 6c585f5b | ✅ | handoff exit 0 · resume exit 0 |
| `approval-pending` | 6c585f5b | ✅ | approval_pending · id 7d92870452c3 · 60 s |
| `approval-unanswered` | 6c585f5b | ✅ | replay without a decision → exit 3 (expect 3) |
| `approval-agent-cannot-answer` | 6c585f5b | ✅ | after an unanswered replay the approval 7d92870452c3 holds 0 decision file(s) (expect 0) |
| `approval-deny` | 6c585f5b | ✅ | denied 7d92870452c3 |
| `approval-denied-replay` | 6c585f5b | ✅ | exit 4 (expect 4) · acceptance: deny path |
| `approval-allow` | 6c585f5b | ✅ | allow exit 0 · replay exit 0 (expect 0) |
| `approval-single-use` | 6c585f5b | ✅ | replay of the used id → exit 4 (expect 4) |
| `hold-blocks-agent` | 6c585f5b | ✅ | hold exit 0 · observe exit 2 (expect 2) |
| `resume-releases` | 6c585f5b | ✅ | resume exit 0 · observe exit 0 (expect 0) |
| `mcp` | 6c585f5b | ✅ | 21 个工具 · uitest_observe → screen 1216x2688 · app: com.huawei.hmos.calculator · rotatio |
| `cmd-launch` | 7544d645 | ✅ | settled · 3939 ms |
| `cmd-observe` | 7544d645 | ✅ | settled · 2636 ms |
| `cmd-tap` | 7544d645 | ✅ | settled · 4986 ms |
| `cmd-type` | 7544d645 | ✅ | settled · 11014 ms |
| `cmd-swipe` | 7544d645 | ✅ | settled · 4711 ms |
| `cmd-double-click` | 7544d645 | ✅ | settled · 4048 ms |
| `cmd-drag` | 7544d645 | ✅ | settled · 5022 ms |
| `cmd-fling` | 7544d645 | ✅ | settled · 4539 ms |
| `cmd-pinch` | 7544d645 | ✅ | settled · 5402 ms |
| `cmd-wait-for` | 7544d645 | ✅ | settled · 17099 ms |
| `cmd-read-list` | 7544d645 | ✅ | settled · 4704 ms |
| `cmd-scroll-until` | 7544d645 | ✅ | settled · 6811 ms |
| `cmd-key` | 7544d645 | ✅ | settled · 4367 ms |
| `cmd-apps` | 7544d645 | ✅ | settled |
| `cmd-window` | 7544d645 | ✅ | settled |
| `cmd-doctor` | 7544d645 | ✅ | settled · doctor |
| `cmd-screenshot` | 7544d645 | ✅ | settled · 47 KB |
| `cmd-inspect` | 7544d645 | ✅ | settled · 151 KB |
| `cmd-report` | 7544d645 | ✅ | settled |
| `cmd-status` | 7544d645 | ✅ | settled · connected |
| `cmd-handoff` | 7544d645 | ✅ | handoff exit 0 · resume exit 0 |
| `approval-pending` | 7544d645 | ✅ | approval_pending · id f24da81031f2 · 60 s |
| `approval-unanswered` | 7544d645 | ✅ | replay without a decision → exit 3 (expect 3) |
| `approval-agent-cannot-answer` | 7544d645 | ✅ | after an unanswered replay the approval f24da81031f2 holds 0 decision file(s) (expect 0) |
| `approval-deny` | 7544d645 | ✅ | denied f24da81031f2 |
| `approval-denied-replay` | 7544d645 | ✅ | exit 4 (expect 4) · acceptance: deny path |
| `approval-allow` | 7544d645 | ✅ | allow exit 0 · replay exit 0 (expect 0) |
| `approval-single-use` | 7544d645 | ✅ | replay of the used id → exit 4 (expect 4) |
| `hold-blocks-agent` | 7544d645 | ✅ | hold exit 0 · observe exit 2 (expect 2) |
| `resume-releases` | 7544d645 | ✅ | resume exit 0 · observe exit 0 (expect 0) |
| `mcp` | 7544d645 | ✅ | 21 个工具 · uitest_observe → screen 1600x2560 · app: com.huawei.hmos.calculator · rotatio |
| `skill-install` | host | ✅ | install 0 · marker 0.10.1 · 再装 2（期望非 0）· --force 0 |
| `live-moved` | host | ✅ | live moved to uitest-console · npm i -g uitest-console · uitest-console |

## 汇总

通过 65，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-phone.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
