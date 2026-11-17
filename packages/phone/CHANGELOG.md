# 更新日志

本文件记录 `uitest-phone` 的公开版本。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循语义化版本。

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
