# uitest-phone 0.10.0 验收报告

> 本文件由 `scripts/acceptance-phone.ts` 生成，请勿手改。生成时间：2026-11-18，提交 `8012195`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 6c585f5b | BRA-AL00 | 1216x2688 |
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
| `package` | host | ✅ | uitest-phone-0.10.0.tgz · uitest-phone 0.10.0 (uitest-sdk 0.10.0) · --help exit 2 |
| `cmd-launch` | 6c585f5b | ✅ | settled · 4045 ms |
| `cmd-observe` | 6c585f5b | ✅ | settled · 2868 ms |
| `cmd-tap` | 6c585f5b | ✅ | settled · 3819 ms |
| `cmd-type` | 6c585f5b | ✅ | settled · 10482 ms |
| `cmd-swipe` | 6c585f5b | ✅ | settled · 4752 ms |
| `cmd-double-click` | 6c585f5b | ✅ | settled · 4041 ms |
| `cmd-drag` | 6c585f5b | ✅ | settled · 5126 ms |
| `cmd-fling` | 6c585f5b | ✅ | settled · 4223 ms |
| `cmd-pinch` | 6c585f5b | ✅ | settled · 5160 ms |
| `cmd-wait-for` | 6c585f5b | ✅ | settled · 18722 ms |
| `cmd-read-list` | 6c585f5b | ✅ | settled · 4874 ms |
| `cmd-scroll-until` | 6c585f5b | ✅ | settled · 7678 ms |
| `cmd-key` | 6c585f5b | ✅ | settled · 3923 ms |
| `cmd-apps` | 6c585f5b | ✅ | settled |
| `cmd-window` | 6c585f5b | ✅ | settled |
| `cmd-doctor` | 6c585f5b | ✅ | settled · doctor |
| `cmd-screenshot` | 6c585f5b | ✅ | settled · 43 KB |
| `cmd-inspect` | 6c585f5b | ✅ | settled · 134 KB |
| `cmd-report` | 6c585f5b | ✅ | settled |
| `cmd-status` | 6c585f5b | ✅ | settled · connected |
| `cmd-handoff` | 6c585f5b | ✅ | handoff exit 0 · resume exit 0 |
| `approval-pending` | 6c585f5b | ✅ | approval_pending · id 19aea9be7992 · 60 s |
| `approval-unanswered` | 6c585f5b | ✅ | replay without a decision → exit 3 (expect 3) |
| `approval-deny` | 6c585f5b | ✅ | denied 19aea9be7992 |
| `approval-denied-replay` | 6c585f5b | ✅ | exit 4 (expect 4) · acceptance: deny path |
| `approval-allow` | 6c585f5b | ✅ | allow exit 0 · replay exit 0 (expect 0) |
| `approval-single-use` | 6c585f5b | ✅ | replay of the used id → exit 4 (expect 4) |
| `approval-agent-cannot-answer` | 6c585f5b | ✅ | 重放一个未回答的 id 只会再次返回 approval_pending；决定文件只能由 approvals CLI 或 console 写入 |
| `hold-blocks-agent` | 6c585f5b | ✅ | hold exit 0 · observe exit 2 (expect 2) |
| `resume-releases` | 6c585f5b | ✅ | resume exit 0 · observe exit 0 (expect 0) |
| `mcp` | 6c585f5b | ✅ | 21 个工具 · uitest_observe → screen 1216x2688 · app: com.huawei.hmos.calculator · rotatio |
| `cmd-launch` | 7544d645 | ✅ | settled · 4462 ms |
| `cmd-observe` | 7544d645 | ✅ | settled · 3237 ms |
| `cmd-tap` | 7544d645 | ✅ | settled · 4428 ms |
| `cmd-type` | 7544d645 | ✅ | settled · 12645 ms |
| `cmd-swipe` | 7544d645 | ✅ | settled · 5506 ms |
| `cmd-double-click` | 7544d645 | ✅ | settled · 4799 ms |
| `cmd-drag` | 7544d645 | ✅ | settled · 5871 ms |
| `cmd-fling` | 7544d645 | ✅ | settled · 5195 ms |
| `cmd-pinch` | 7544d645 | ✅ | settled · 5993 ms |
| `cmd-wait-for` | 7544d645 | ✅ | settled · 21053 ms |
| `cmd-read-list` | 7544d645 | ✅ | settled · 5184 ms |
| `cmd-scroll-until` | 7544d645 | ✅ | settled · 8357 ms |
| `cmd-key` | 7544d645 | ✅ | settled · 5397 ms |
| `cmd-apps` | 7544d645 | ✅ | settled |
| `cmd-window` | 7544d645 | ✅ | settled |
| `cmd-doctor` | 7544d645 | ✅ | settled · doctor |
| `cmd-screenshot` | 7544d645 | ✅ | settled · 48 KB |
| `cmd-inspect` | 7544d645 | ✅ | settled · 148 KB |
| `cmd-report` | 7544d645 | ✅ | settled |
| `cmd-status` | 7544d645 | ✅ | settled · connected |
| `cmd-handoff` | 7544d645 | ✅ | handoff exit 0 · resume exit 0 |
| `approval-pending` | 7544d645 | ✅ | approval_pending · id 98a56cb39cec · 60 s |
| `approval-unanswered` | 7544d645 | ✅ | replay without a decision → exit 3 (expect 3) |
| `approval-deny` | 7544d645 | ✅ | denied 98a56cb39cec |
| `approval-denied-replay` | 7544d645 | ✅ | exit 4 (expect 4) · acceptance: deny path |
| `approval-allow` | 7544d645 | ✅ | allow exit 0 · replay exit 0 (expect 0) |
| `approval-single-use` | 7544d645 | ✅ | replay of the used id → exit 4 (expect 4) |
| `approval-agent-cannot-answer` | 7544d645 | ✅ | 重放一个未回答的 id 只会再次返回 approval_pending；决定文件只能由 approvals CLI 或 console 写入 |
| `hold-blocks-agent` | 7544d645 | ✅ | hold exit 0 · observe exit 2 (expect 2) |
| `resume-releases` | 7544d645 | ✅ | resume exit 0 · observe exit 0 (expect 0) |
| `mcp` | 7544d645 | ✅ | 21 个工具 · uitest_observe → screen 1600x2560 · app: com.huawei.hmos.calculator · rotatio |
| `skill-install` | host | ✅ | install 0 · marker 0.10.0 · 再装 2（期望非 0）· --force 0 |
| `live-moved` | host | ✅ | live moved to uitest-console · npm i -g uitest-console · uitest-console |

## 汇总

通过 65，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-phone.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
