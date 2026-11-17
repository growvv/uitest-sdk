# 安全说明

## 报告漏洞

请通过 GitHub Security Advisories 私下报告：

https://github.com/growvv/uitest-sdk/security/advisories/new

## 信任边界

`uitest-phone` 是一个**无界面**的 agent 工具。它不打开网络端口；MCP 走 stdio，
其余状态写在 `--state-dir` 指向的目录里。

- **审批由人决定**。策略拦下的步骤返回 `approval_pending` 与一个 id；id 的持有者
  不能替自己批准——批准只能由人在终端（`uitest-phone approvals allow <id>`）或
  console 页面里做出。默认失败即拒绝：没有决定、决定过期、id 与步骤不匹配，都按
  拒绝处理。
- **序列号不落盘**。租约、trace、审批与报告只使用设备序列号的 8 字符哈希。
  trace 在写入前会把已知序列号替换成该哈希。
- **hold 是显式的**。`hold` / `handoff` 会写下「人持有」的租约；所有 agent 命令在
  读取屏幕之前就停在 `lease_held`，直到人运行 `resume`。没有基于进程存活或设备侧
  触摸的隐式接管。

## 依赖

运行时依赖 `uitest-sdk`（设备访问、投屏、治理）与 `jsonc-parser`（保留注释地修改
agent 的 JSON 配置文件）。两者均在本包升级时独立升级。
