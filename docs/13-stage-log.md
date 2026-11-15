# 13 · 阶段记录（stage log）

按阶段记录交付内容、发布结果、架构实测、决策与待办。新阶段追加在文末，不覆盖旧记录。

---

## 2026-11-16 · 0.3.0 → 0.4.0

本阶段把「Agent 能做什么」和「人什么时候拿回手机」两条主线补齐：默认值更保守、人可随时接管、
屏幕上的凭据不外泄、设备状态有名字、审批可以记住、Skill 跟着包升级走。

### A. 本阶段交付

| 分类 | 内容 | 版本 |
|---|---|---|
| 安全默认值 | 默认审批集扩到 `payments,finance,deletes,sends`；`commits` 保持 opt-in；`--read-only` 拒绝改数据 | 0.3.0 |
| 接管与交接 | `hold` / `resume` 人工持租约；`handoff --reason` 让 Agent 请人接手；`lease_held` / `handoff` 退出码 2 | 0.3.0 |
| Agent 接入 | `connect` 写 `claude` / `codex` 设置文件，只改本包一项；同时写 `~/.claude/skills` 与 `~/.agents/skills` | 0.3.0 |
| 凭据脱敏 | `observe` / diff / `read-list` / `screenshot` / `--trace-shots` / `report` 共用脱敏屏幕；密码框 `••••••`，凭据语境数字等长圆点；截图盖灰块；低层 `captureLayout()` / `captureScreen()` 保持原样 | 0.4.0 |
| 设备状态 | 新增 `device_locked` / `device_needs_setup` / `device_offline`，统一退出码 2；连接阶段读 `hdc list targets -v`；锁屏用 `ScreenLockWidget` 标签兜底（真机锁屏 bundle 是 `com.ohos.sceneboard`） | 0.4.0 |
| 审批记忆 | `--approval-scope once/task/always`；按 rule + bundle 记；`resume` 清 task 留 always；记住的授权只跳过审批，不越过凭据、`--read-only`、`--apps` | 0.4.0 |
| Skill 生命周期 | 安装写 `.uitest-skill.json`（版本 + 摘要）；`mcp` 启动刷新本包写的那份；人改过/手写的不动；0.3.0 副本按发布摘要识别接管 | 0.4.0 |
| Agent 覆盖 | `connect --agent gemini`（`~/.gemini/settings.json`）与 `--agent copilot`（`~/.copilot/mcp-config.json`，`type: "local"`、`tools: ["*"]`） | 0.4.0 |

### B. 发布与验证

| 项目 | 结果 |
|---|---|
| Release commit | `2599c5b release: 0.4.0 — credential masking, device states and remembered approvals` |
| Git tag | `v0.4.0`（已推 origin）；`v0.3.0` 保持原 tag |
| GitHub Release | https://github.com/growvv/uitest-sdk/releases/tag/v0.4.0 |
| npm | `0.0.0-stage, 0.1.0, 0.2.0, 0.3.0, 0.4.0`；`latest = 0.4.0`，`0.3.0` 发在 `legacy` tag |
| npm 安装验证 | 全新目录 `npm install uitest-sdk@0.4.0` → `node_modules/.bin/uitest-phone --version` 输出 `0.4.0` |
| 官网 | master 推送后 GitHub Pages 重新发布：首页、docs、changelog 均显示 0.4.0 |
| 测试 | 434 个单元测试全过；0.3.0 tag 树 385 个全过；`tsc`、`build`、`check-site` 全绿 |

### C. 架构实测（本阶段新增，可复用）

#### C1. 「单次模式、不常驻」的准确含义

官网说「宿主侧不常驻」：每条 CLI 命令是一个新的本地进程，跑完退出；跨命令状态（refs、审批、租约、
trace）全在磁盘。但**设备侧**仍有一个 `uitest start-daemon singleness --extension-name agent.so` 进程：

```text
运行前:            pidof uitest → 空
第 1 条 status:    4.1 s，拉起 agent.so daemon
第 2 条 status:    2.7 s，复用同一个 pid
命令退出后:        daemon 仍在
```

`Device.connect` 探测 8012：没有监听就拉起，有就复用；`dispose()` 默认**不杀**（`ownDaemon: true`
才杀自己拉起的那一个）。所以「没有后台 daemon」描述的是宿主侧，不是设备侧。官网文案已按此修正。

#### C2. `uitest uiRecord` 与 agent daemon 互斥

| 顺序 | 结果 |
|---|---|
| daemon 已监听 → `uitest uiRecord record -c true` | 立即失败：`Can not connect to AAMS, RET_ERR_CONNECTION_EXIST`；记录器进程退出；agent 会话 14 次 `captureLayout` 心跳全部正常 |
| `uiRecord` 先启动 → `Device.connect` | agent 连接被关：`AgentConnectionError: agent connection closed` |

`uiRecord` 本身是 **hdc shell 拉起的常驻设备进程**（杀掉本地 hdc shell 后设备进程消失），
记录 `/data/local/tmp/record.csv`（逐行 JSON，含控件 bounds/hierarchy），合成点击也会记录。
结论：MCP 会话活着就一定有 daemon，接管期间 `uiRecord` 永远起不来；它不是接管记录的可行路径。

#### C3. 扩展内部 UI 事件流同样不可用

- 扩展 ABI：`startCapture("recordUiAction", cb)` / `stopCapture`
- daemon JSON：`Captures.startCaptureUiAction` / `stopCaptureUiAction`（即 `streamUiActions()`）

两者是同一套 `UIEventObserver`。实测 `stopCaptureUiAction` 会关闭整个会话、能把 daemon 卡死
（连续三次），且合成输入也会回传。**内部接口存在，但不能用于接管记录。**

#### C4. `captureLayout` 轮询可行

- 真机单次 **169–252 ms**，与 agent 会话正常共存（14 次心跳无失败）。
- layout 自带 `bundleName` / `abilityName` / `pagePath` / `text` / `hint` / `focused`，足以生成线性时间线。
- 两个客户端并发：首轮会撞 `Capture already running: dumpLayout`，其中一个请求可能卡满 30 s；
  之后并发正常。记录器应使用短超时 + `retryOnBusy`，并且只在租约被人持有时轮询。

### D. 决策与放弃

- **接管记录暂不做**（2026-11-16）：`uiRecord` 与 daemon 互斥，内部事件流会卡死 daemon；
  Pinky 也没有这个能力，不阻塞对齐。
- 若将来重做：用 `captureLayout` 轮询写脱敏的线性 JSONL（页面/焦点/文本变化 + hold 起止快照），
  不做 Graph；线性日志天然适合直接进上下文或做 RAG 片段。
- 不引入自动回退：记录路径要么是轮询，要么不做；不在 uiRecord 与轮询之间静默切换。

### E. 已知问题与技术债

| 问题 | 状态 / 处理 |
|---|---|
| npm staged publishing | bypass-2FA token 现在会把 `npm publish` 先放入 staged 区；`npm stage list` 在验证期间可能返回空，`npm view` 也暂时看不到新版本。本次两版最终都已上线。发版后应以 registry (`npm view ... dist-tags`) 为准再宣布 |
| `package.json` 的 `bin` 写成 `./dist/bin.js` | npm 11.20 发布时会警告并自动修正为 `dist/bin.js`；发布产物正确（已用全新安装验证）。下次发版前去掉开头的 `./` |
| npx 缓存串版本 | 用默认 mirror 安装失败后，同一 `_npx` 目录可能残留旧版本；用官方 registry + 独立 cache 全新安装验证，package 本身正常 |
| 设备侧 daemon 默认保留 | 有意的复用设计；文档已说明 `ownDaemon`。不要盲杀 `uitest` 进程，MCP 会话可能正在使用 |
| 官网「没有后台 daemon」表述 | 已改为「宿主侧不常驻；设备侧扩展按需拉起并复用」 |

### F. 下一阶段候选

来自站点「计划中」，均未承诺，按实测收益再排优先级：

1. 7.0 casting（WebSocket 分支）实验支持，作为可选传输；
2. `perfmonitor_260608.so`（HTTP 9999）性能指标接入；
3. 录制参数在设备侧可配置（当前文件路径写死在扩展里）；
4. 更多 hypium 方法的一等封装（当前可用 `agent.hypium()` 直调）；
5. （可选，若重新考虑）接管时的线性「人的操作」时间线。

### 参考

- 能力与协议：[01](01-extension-abi.md)、[02](02-agent-so.md)、[08](08-missing-capabilities.md)、[09](09-capability-gaps-roadmap.md)
- SDK 行为与命令：[api.md](api.md)
