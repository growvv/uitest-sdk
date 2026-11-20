# 更新日志

本文件记录 `uitest-phone` 的公开版本。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循语义化版本。

## [Unreleased]

- 运行在 `uitest-sdk@0.11.2` 上。

### 新增

- **`type --clear`：先清空再输入。** 搜索框会保留上一次的查询词，`type` 追加后变成两个词，
  回读报 `uncertain`，agent 只能逐字删——而搜索框每删一个字就重跑一次查询。meituan-05
  因此 485 s 超时。`--clear` 一次调用清空。skill 与 MCP 工具描述都写明了（只有 45% 的
  agent 会读 skill，工具描述是 100% 都看得到的那个）。

### 修复

- **`observe --out` 的图现在会随结果返回。** 它一直会写 JPEG，但 MCP 层只把 `screenshot`
  和 `inspect` 的图像附上，所以 `observe --out` 的图从没到过模型手里。拨号盘十二个按键
  没有任何文字（`accessibilityId` 只是节点序号），contacts-05 要了十次图都只拿到路径，
  靠试按猜键位，36 次调用、412 秒。现在一次 `observe --out` 同时给文字和像素。
- **`launch --app 天气` 能用了。** 短名会匹配桌面上的应用名，不再只匹配 bundle id。
  实测 1000 条跑批的前 24 次 `launch` 里 13 次因为中文名失败。
- **skill 把无标签控件指到了 `inspect`。** 原来写「拿 `screenshot`，看图上的 ref 编号」，
  但画编号的是 `inspect`。`check-skill` 增加检查，文档再这么写会报错。

## [0.10.4] — 2026-11-20

- 运行在 `uitest-sdk@0.11.2` 上。

### 修复

- **截图通过 MCP 返回图像本身。** skill 让 agent 在屏幕文字回答不了问题时截图，但 MCP 只回
  一个文件路径——模型打不开文件。计算器的 `×`、`÷` 既没有 text 也没有 description，屏幕
  模型把它们显示成 `keyCode 14`、`keyCode 13`（资源 id），agent 分不清就靠位置猜，按错、
  清空、重来：实测两条任务分别用掉 47 和 80 次调用后超时。`screenshot` 与 `inspect` 现在
  把 JPEG 作为 MCP image 内容块一起返回；`inspect` 也像 `screenshot` 一样在 `path` 里报出
  写的文件。文件不存在不算错误：文字结果照常返回，调用成败由工具状态决定。
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
