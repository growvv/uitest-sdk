# 更新日志

本文件记录 `uitest-phone` 的公开版本。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循语义化版本。

## [未发布]

### 修复

- **`uitest-phone mcp` 先答握手、再连设备。** 以前先连设备再服务 stdio，设备慢、没插或转发
  冲突时进程在回 `initialize` 之前就退出，MCP 客户端只看到
  `connection closed: initialize response`，agent 只能当工具坏了。现在握手立刻应答，第一次
  工具调用才连设备；连不上时以 `device_offline` 的工具错误返回，agent 能读懂并停下。
- **被杀的 MCP 进程不再留下转发和租约。** `SIGINT` / `SIGTERM` / `SIGHUP` 会先关会话。

## [0.10.3] — 2026-11-19

- 运行在 `uitest-sdk@0.11.1` 上。本包源码无改动：核心只修了内部生命周期与窗口探测。

## [0.10.2] — 2026-11-18

- 运行在 `uitest-sdk@0.11.0` 上。本包源码无改动：核心只新增了 API。

## [0.10.1] — 2026-11-18

- 运行在 `uitest-sdk@0.10.1` 上。
- `approvals deny` 在审批已被允许时报 `approval_conflict` 并以非零退出，
  不再打印 `denied` 让人以为拒绝生效了。

## [0.10.0] — 2026-11-18

`uitest-sdk` 0.9.4 的 CLI / MCP / skill 部分成为独立产品，运行在
`uitest-sdk@0.10` 之上。

### 迁移

| 0.9.4 | 0.10.0 |
| --- | --- |
| `npx uitest-sdk <command>` | `npx uitest-phone <command>` |
| `npx uitest-sdk mcp` | `npx uitest-phone mcp` |
| `npx uitest-sdk connect` | `npx uitest-phone connect` |
| `npx uitest-sdk install-skill` | `npx uitest-phone install-skill` |
| `npx uitest-sdk live` | `npm i -g uitest-console && uitest-console` |

### 打包

- 21 个命令、MCP 服务与 skill 不变；`--version` 现在同时报告手机包与核心库版本。
- skill 标记从 `uitest-sdk` 迁移为 `uitest-phone`：旧标记在内容未被修改时会被接管并刷新，
  手改过的副本保持不动。
