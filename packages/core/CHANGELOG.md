# 更新日志

本文件记录 `uitest-sdk` 每个公开版本的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循语义化版本。逐条的实现细节与实测数据在 [`site/changelog.html`](site/changelog.html) 与
[`docs/13-stage-log.md`](docs/13-stage-log.md)；本文件是给升级者看的摘要。

升级前请读「破坏性变更」一节——本项目目前没有，将来有了会写在对应版本的第一行。

## [未发布]

## [0.10.1] — 2026-11-18

全分支评审后的修正版。一处类型收窄：`observe.apps()` 现在只承诺它真的返回的字段。

- **`observe.apps()` 的返回类型收窄**：`AppInfo[]` → `Array<{ bundle: string }>`。
  `ability` 从来没被填过（启动时才解析），一直读到 `undefined`。运行时行为不变；
  但如果你在 TypeScript 里读 `apps[0].ability`，这段代码现在不编译了——删掉它，
  或在启动时从 `launch` 的结果取。
- **审批的授权范围由人决定**：`approvals allow` 不带 `--scope` 就是「这一次」。
  此前 agent 重放时加 `--approval-scope always` 能把一句普通的「同意」变成覆盖
  该状态目录下所有任务的长期授权。
- **失败的拒绝不再假装成功**：审批已经有相反答案时返回 `conflict`，CLI 以非零
  退出并说明「已被允许，重放会继续」，console 同样提示。
- **审批请求写不进磁盘时抛 `ApprovalWriteError`**（`code: EAPPROVALWRITE`），
  不再返回一个没人能答的 id。它是 `UitestError` 的子类，CLI 与 MCP 都能归类。
- **console 的冲突提示不会再被刷新冲掉**：提示写在审批列表之外，先发列表、后发
  原因，下一次点击时才清掉。
- 公开类型补齐：`WindowResult`、`InspectResult`、`DragOptions`、`Point`、`Rect`、
  `H264Chunk`、`SessionAgent` / `SessionDevice` 等签名里出现的类型都能从包里导入。
- 文档与示例修正：quickstart 的 `tap` 改用真实目标；README、API 参考与站点示例的
  导入路径指向实际存在的入口。
- **查看器关闭时不再漏掉正在打开的投屏**：`close()` 只释放它已经拿到的 cast；
  一个在关闭途中才返回的 cast 无人释放，会留下设备端 daemon 和一条 fport，进程
  也退不出去。实测每次验收每台设备漏一条 `localabstract:uitest_live_*`。
- **截图按钮不再给一个不存在的文件路径**：锁屏时设备不写文件，页面此前仍返回
  路径，让人去找一个没有的图片；现在把 session 给的原因显示出来。

## [0.10.0] — 2026-11-18

核心库与产品的拆分版本：`uitest-sdk` 现在是纯库（连接、观察、动作、投屏、查看器、治理），
CLI / MCP / skill 移到 `uitest-phone`，浏览器投屏界面移到 `uitest-console`。
根入口收缩为 `connect` 与分类命名空间（`observe` / `act` / `wait` / `cast` / `view` / `govern`），
其余能力走 `uitest-sdk/commands`、`/cast`、`/viewer`、`/govern`、`/drivers` 子路径。

## [0.9.4] — 2026-11-18

在两台真机上从环境跑到发布产物的完整验收（9 个步骤，见
[`site/acceptance.html`](site/acceptance.html)）。这一版就是那次验收修出来的东西：三个产品
缺陷、两个报告缺陷、两个验收工具缺陷。没有新功能。

### 修复

- **`--apps` 现在也管住 `launch`**。白名单此前只在 `tap` / `type` 这类动作上生效，`launch --app
  settings` 直接问 hdc 就启动了——白名单最该管住的就是「换到别的应用」，恰恰漏了。现在
  `launch` 走同一套策略，越界返回 `blocked_by_policy · rule: scope`。
- **`--apps` 接受短名**。名单此前只认完整 bundle id，`--apps calculator` 于是把计算器自己也拦了。
  现在与会话开始前用 `launch` 同一套解析（`resolveAppList`），写错了会直接报错而不是悄悄变成
  空名单。
- **`resume` / `hold` / `status` 认 `HDC_TARGET`**。两台设备同时插着时，`resume` 报「多台设备」
  而无法交还刚被 `hold` 占住的设备；`Device` 和 `HdcRunner` 本来就认这个变量。多台设备时仍拒绝
  猜，但提示里只出现 8 位标签，不出现序列号。
- **`doctor` 与 `status` 用同一个设备标签**。`doctor` 自己算了一套哈希（`dev-` 前缀），同一台设备
  在报告里叫 `dev-bff94761`、在会话里叫 `7544d645`。现在共用 `tagOf`。
- **`apps --current` 取启动时间最新的前台应用**。设备会把两个 mission 都标成 `FOREGROUND`，
  取第一个会报出被压到后台的那个。
- **验收报告的两列不再互相覆盖**。两台设备一起跑时，第二台的 16 行结果把第一台的盖掉了；列键
  改成设备标签。
- **通知栏守卫不再误报**。`closeShade()` 在手机上 208 ms 就返回，紧接着一次读取仍判为「打开」，
  导致一次已经成功的运行被判失败；改成有上限的轮询等待。

### 新增

- `scripts/acceptance-security.ts`：不测函数，测线上那台服务器——真的建 TCP 连接、真的发 WebSocket
  握手，核对 7 种来源的响应码（自有来源 101，四种攻击面 403，无 `Origin` 101，错路径 404）。
- `site/acceptance.html`：9 个步骤在两台真机上的完整记录，含 34 张截图、命令与原始输出。同时是
  教程，照着做可以复现全部结论。
- `scripts/check-site.mjs` 增加对验收页的检查：14 个锚点、每张表的行数、16 个能力名、32 张矩阵截图
  必须是完整 JPEG，以及一条「页面里不得出现设备序列号」的断言。
- 验收脚本默认把设备停在计算器上再截图（`stageNeutralSurface`），结束后恢复原应用；证据目录可用
  `UITEST_ACCEPTANCE_DIR` 指到仓库外。

## [0.9.3] — 2026-11-18

安全修复。`live` 页面此前会接受**任何**网页发来的 WebSocket：你随便打开的一个标签页，
本来就能接管你的手机。

### 修复

- **`live` 的 WebSocket 现在校验 `Origin`**。浏览器对 WebSocket 不做同源限制，而 `live` 的端口
  是固定常量 7000，所以校验必须在服务端做，且是白名单：`Origin` 的 host 与 port 必须等于客户端
  实际拨号的 `Host`，scheme 必须是 `http:`。绑在回环上时拨号名本身必须是回环名，这条挡的是
  DNS rebinding；`Origin: null`（沙箱 iframe、`file://` 页面）一律拒绝；没有 `Origin` 头的
  非浏览器客户端放行（它本来就能自己跑 `hdc`）。拒绝时直接回 **403**，不先升级再断开，会话内容
  一个字节都不发出去。
- **被拒绝的连接不再拖住进程**。只调 `socket.end()` 时，对方继续写就永远关不掉；该 socket 一直
  算在服务的连接数里，`close()` 的回调永不触发。改为写完后在 `finish` 上 `destroy()`，同一场景
  从「永不关闭」变成 1 ms 关闭。
- **包入口补上 `DeviceStateError`**。`src/errors.ts` 有 13 个错误类，`src/index.ts` 只导出了 12 个，
  漏掉的那个在运行时是 `undefined`，`instanceof` 会直接抛。同时导出它的 `DeviceState` 类型。

### 新增

- 根目录 `SECURITY.md`：漏洞报告渠道、`live` 暴露什么、Origin 校验挡住什么、以及**不在**防护
  范围内的部分（`--privacy off`、屏幕上本来就有的东西、`policy` 只按词汇识别）。随包发布。
- `test/unit/live-origin.test.ts`（10 条）与 `live-server.test.ts` 里 5 条端到端用例：
  外部来源、`null`、DNS rebinding、同端口不同 host 全部被拒，自有来源通过。
- `test/unit/package-entry.test.ts`：从 `errors.ts` 正则提取全部类名逐个核对包入口，另查
  入口里的每个名字在运行时都不是 `undefined`、且没有重复导出。
- `test/unit/live-cli-wiring.test.ts`（10 条）：`startLive` 的取租约顺序、会话或服务启动失败时
  释放设备、`0.0.0.0` / `::` 打印回环地址、`--no-layout` 仍取显示尺寸。

## [0.9.2] — 2026-11-17

包质量修补：没有新功能，也没有改动任何运行时行为。四处对外文档此前各说各话，现在都以
`docs/acceptance/report.md` 为准，并各加了一条测试防止再次漂移。

### 新增

- 根目录 `NOTICE`：逐条列出 `assets/` 里三个华为签名二进制的版本、大小、md5 与来源，说明 MIT 只覆盖本仓库源码、二进制不随 MIT 授权、也不提供任何担保。
- 根目录 `CHANGELOG.md`（本文件）。两者都进 `files`，随包发布。
- `test/unit/package-docs.test.ts`：错误类清单、版本条目、`NOTICE` 内容、路线图、README / `docs/api.md` / 官网的实测数字与 tarball 内容，全部对着源码与验收报告断言。

### 修复

- `docs/api.md` 的错误表补齐 6 个此前漏掉的类：`DeviceStateError`、`AppNotFoundError`、`LaunchError`、`ElementNotFoundError`、`LeaseHeldError`、`UnsupportedError`。原来只列了 7 个，导出了 13 个。
- 官网路线图删掉「`live` 页的点击交互」——0.9.0 已发。`scripts/check-site.mjs` 新增否定断言：这一段不得再出现已发布的功能。
- 截图耗时从 `107–193 ms` 改为 `109–222 ms`（README、`docs/api.md`、官网两处、`check-site` 的 needle）。`193` 低于最新验收实测的 `218 ms`，等于告诉读者 SDK 比实际快。
- README 的验收日期 `2026-11-14` 改为 `2026-11-17`，与它引用的报告一致。
- README 的 UI 树节点数 `~180~250` 改为 `~180~430`，覆盖最新实测的 349 节点。

## [0.9.1] — 2026-11-17

接管输入的八处修补。都是真机与分支复核发现的问题，不涉及新功能。

### 修复

- **退出接管不再吞掉刚输入的字**：`LiveInput.cancel()` 清空队列时保留了排队中的文字，抬指后再发送。
- **系统键先冲文字**：返回 / Home / 删除在发送按键前先 flush 缓冲的文字，与回车一致，避免键落到已经换掉的界面上。
- **写通道重开**：`openInputLane()` 同步抛错时清掉缓存的 promise，五秒退避后可以重试，不再永久拿到同一个拒绝。
- **延迟读数只算触摸**：滚轮与粘贴不计入 p50/p95，改在 `slow` 里单独报次数。
- **注入计数不封顶**：新增 `LiveStats.total`；`n` 仍是 200 条缓冲的长度。
- **不再往 (0,0) 发文字**：没有已知落点时拒绝发送，不会打进状态栏。

### 官网与验收脚本

- 接管演示滚出视口时清掉整条定时器链，滚回来从头播一次。
- `--only` 局部跑写 `report-only.md`，不覆盖已提交的完整报告。
- 无头 Chrome 在 macOS / Linux 上也能被真正结束。
- 长按证据的裁切留白跟随输入助手条的高度。

## [0.9.0] — 2026-11-17

`live` 页从「看」变成「能操作」。

### 新增

- **接管**：页面默认只读，点页头「接管」后画布就是设备——点击、长按、拖动、滚动、双指缩放、键盘输入、返回 / Home。触摸延迟 p50 3.9 ms（点击场景）。
- **第二条输入通道**：`device.openInputLane()` 起独立的 `hdc fport` 与 agent 连接，不排在读布局那条后面；长按期间节点表照常刷新。
- 接管独占：第二个页面收到 `busy by <clientId>` 并广播 `readonly`；按住 10 s 不动只抬指针，控制权保留。
- 键盘两条规则：普通输入停顿 300 ms 整段落设备；拼音组合期间不上屏，`compositionend` 时整词落下。

### 实测

- 知乎上 10 个场景全过；10 分钟长跑 12.7 fps（基线 13.9 fps，1167 次输入），中途换手 ack 33 ms。

## [0.8.0] — 2026-11-16

### 新增

- `live` 页页头 **Shot** 与 **Record**：截图走 `Session.observe({ out })`，遮罩规则与节点表同一套；录屏另起 record daemon。
- `CastOptions.durationMs` 生效：到点自动停止、关闭 muxer、拉回文件。

### 修复

- 同一台设备可以开多个 `live` 页面：每个进程用自己的 socket 名，daemon 归因改用 `ps -ef` 的 argv 精确匹配（原来两个页面会互相杀掉对方刚起的 daemon）。
- 租约同名 task 重入要求 pid 相同；人的 `hold` 是例外。
- `hdc file recv` 失败时退出码仍为 0，现在读状态行并抛错。

### 工程

- `test/` 与 `scripts/` 纳入类型检查（`tsconfig.test.json`）；CI 部署前先跑单元测试。

## [0.7.1] — 2026-11-16

### 修复

- 不再写死 `hardwareAcceleration: 'prefer-hardware'`：没有 GPU 解码的机器上交给浏览器挑，默认配置被拒才重试一次软解。
- 解码中途出错后自己重开解码器并请求关键帧，画面不再永久卡住。

## [0.7.0] — 2026-11-16

### 新增

- `uitest-sdk live`：一个本地页面同时给出画面与节点表；点节点复制 ref、角色、标签与中心坐标，编号与 `tap --ref` 共用。
- 浏览器内解码：H.264 走 WebCodecs，服务端把 Annex-B 转 AVCC 并把 SPS/PPS 拼成 `avcC`。
- `LiveServer.start({ source: { createCast, readScreen } })`。
- 隐私开关默认打开：密码框与验证码在节点表和画面上都被遮住，遮罩在读的时候完成。

### 修复

- 只把带 IDR 切片的帧标成关键帧（6.8 扩展开场帧只有 SPS/PPS，WebCodecs 会拒绝）。

### 实测

- 真机 `--fps 30`：首帧约 3.1 s，页面绘制 18.5 fps，帧间隔中位 33 ms、p90 55 ms。

## [0.6.0] — 2026-11-16

### 新增

- `createCast({ transport: "ws" })`：走 7.0 扩展的 RFC6455 通道，客户端不需要 gRPC 运行时。真机实测 20.8–23.2 fps，首帧 82–137 ms。
- `wsExtension` 指向本地 7.0 `.so`；传输是显式选择的，缺文件或 ABI 不支持直接抛 `ExtensionMissingError`，不静默退回 gRPC。

### 说明

- SDK 不打包 7.0 二进制。

## [0.5.0] — 2026-11-16

### 新增

- `dev.hypium`（`HypiumDriver`）：hypium 6.1.0.210 的 106 个方法与兼容层 12 个方法铺平成 TypeScript 驼峰方法。
- `Target` 统一位置参数：绝对坐标、屏幕比例、矩形、`On` 选择器、`ComponentHandle` 可互换。
- `HYPIIUM_CATALOG` 导出 118 条映射。
- 官网独立页面 `api.html`：118 条方法表，由 catalog 生成。

### 修复

- `isDisplayLocked()` 在解锁状态下报 `true`（`hidumper` 表格按空白切分错位）。
- `pushFile()` 用相对路径时在设备上建出同名目录。
- `setDisplayRotation()` 传字符串被设备拒绝，类型收窄为 `0 | 1 | 2 | 3`。

### 实测

- 真机逐条：106 `verified`、4 `device`、3 `hardware`、5 `unsupported`。

## [0.4.0] — 2026-11-16

### 新增

- 凭据脱敏：密码框显示 `••••••`，验证码 / PIN / CVV 显示等长圆点；`observe`、diff、`read-list`、`screenshot`、`--trace-shots`、`report` 共用同一份脱敏屏幕。
- 设备状态 `device_locked` / `device_needs_setup` / `device_offline`，退出码统一为 2。
- `--approval-scope once|task|always`：同一条审批可以按任务或按 state dir 记住。
- `connect --agent gemini|copilot`。
- Skill 自更新：安装时写 `.uitest-skill.json`，包升级后 `mcp` 启动时就地刷新未被改过的副本。

## [0.3.0] — 2026-11-16

### 变更

- 默认审批集从「支付、金融」扩到「支付、金融、删除、发送」。

### 新增

- `uitest-phone hold` / `resume`：人可以把设备租约写成 `"held by a person"`，Agent 命令以 `lease_held` 停下。
- `uitest-phone handoff --reason`（MCP 工具 `uitest_handoff`）：Agent 遇到登录、验证码这类只有人能做的一步时把手机交给人并立即返回。
- `connect --agent claude|codex`；`install-skill` 同时写 `~/.claude/skills` 与 `~/.agents/skills`。

### 修复

- `lease_held` 的退出码一直是 1，改为 2。
- 被 hold 的设备上命令要挂 60 s 才退出。
- `hold` 不生效：租约按 pid 判断存活，而写租约的命令早已退出。

## [0.2.0] — 2026-11-16

### 新增

- 命令行 19 条命令：`observe`、`tap`、`type`、`swipe`、`double-click`、`drag`、`fling`、`pinch`、`key`、`wait-for`、`read-list`、`scroll-until`、`launch`、`apps`、`window`、`doctor`、`screenshot`、`report`、`status`。
- 跨进程状态：`refs-<hash>.json`、`approvals-<hash>.json`，ref 在下一条命令里仍指向同一元素。
- `npx uitest-sdk mcp`（stdio JSON-RPC 2.0）与 `install-skill`。
- 策略层与审批：凭据类永久拦截，支付 / 金融默认需要人工审批。

### 修复

- `--read-only` 之前从未生效（flag 以 kebab-case 存、以 camelCase 读）。
- 报告里的截图链接指向文件系统路径。
- 同一毫秒创建的两个 trace 记录器文件名相同，后者截断前者的文件。
- `apps`、`launch`、`doctor` 之前完全不进 trace。

## [0.1.0] — 2026-11-15

首个公开版本。把鸿蒙 `uitest` 扩展封装成 Node.js SDK：一条长连接做 UI 自动化，一条 gRPC 通道做投流与录制。

- 一条 TCP 长连接（`agent.so`，8012）承载全部 UI 请求，串行队列 + 指数退避。
- 按 ABI 自动推送 `agent.so` 与 `libscreen_casting.z.so`。
- 点击、原子触摸、三段式滑动、文本输入、按键、UI 事件流；`captureScreen()`、`cropToWindow()`、`captureLayout()`。
- H.264 over gRPC（6.8 casting）与 MP4 录制；x86_64 显式走 MJPEG。
- 实测：点击 8–30 ms，滑动 389–395 ms，整屏截图 109–222 ms；对比 hdc CLI 分别快 59.0× / 6.9× / 4.5×。
- Node.js ≥ 20，ESM，TypeScript 类型随包发布。

## [0.0.0-stage] — 2026-11-15

npm 分阶段发布（staged publishing）为新包名预留的占位版本，不包含代码。不要安装。

[未发布]: https://github.com/growvv/uitest-sdk/compare/v0.9.2...HEAD
[0.9.3]: https://github.com/growvv/uitest-sdk/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/growvv/uitest-sdk/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/growvv/uitest-sdk/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/growvv/uitest-sdk/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/growvv/uitest-sdk/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/growvv/uitest-sdk/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/growvv/uitest-sdk/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/growvv/uitest-sdk/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/growvv/uitest-sdk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/growvv/uitest-sdk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/growvv/uitest-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/growvv/uitest-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/growvv/uitest-sdk/compare/v0.0.0-stage...v0.1.0
[0.0.0-stage]: https://github.com/growvv/uitest-sdk/releases/tag/v0.0.0-stage
