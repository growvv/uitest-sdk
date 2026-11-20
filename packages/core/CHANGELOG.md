# 更新日志

本文件记录 `uitest-sdk` 每个公开版本的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循语义化版本。逐条的实现细节与实测数据在 [`site/changelog.html`](site/changelog.html) 与
[`docs/13-stage-log.md`](docs/13-stage-log.md)；本文件是给升级者看的摘要。

升级前请读「破坏性变更」一节——本项目目前没有，将来有了会写在对应版本的第一行。

## [Unreleased]

### 新增

- **`type --clear`：先清空再输入。** `type` 是追加，不是替换：搜索框会保留上一次的查询词，
  再搜一次就变成两个词拼在一起，回读如实报 `uncertain`，agent 只剩逐字删一条路——而搜索框
  每删一个字就重跑一次查询。实测 meituan-05 在一个框上花了 21 次 tap 和 3 次 backspace，
  然后 485 s 超时。`--clear` 先调设备的 `Component.clearText`（一次调用，任意长度）再输入。
  73 次 `type` 调用里有 26 次回读不一致，其中 14 次就是这种追加。

### 修复

- **`type --clear` 在设备丢掉控件时照样输入。** 美团的搜索框用的是动态 id
  （`1795148153645`），下一次布局就重建：`Component.clearText` 拿到的是上一帧的控件，
  设备回 `does not exist on current UI!(NoCandidates)`。它是作为异常抛出来的，整条
  MCP 调用失败，agent 只看到 `-32603`，没有任何可操作的信息。清空本来就是尽力而为——
  控件没了就按坐标输入，回读照旧报出框里现在是什么。
- **`type --clear` 清空之后改用同一个句柄输入。** 设备清空输入框会丢掉焦点，接着按坐标的
  `Driver.inputText` 就输到了页面上——回读看到的是一个空的输入框，正是「字哪儿也没去」的
  样子。books-05、settings-05 都是这样。现在清空和输入都走 `Component.clearText` /
  `Component.inputText`，同一个句柄，不依赖焦点和坐标。输入框没有资源 id 时清空做不了，
  但输入照做、回读照报——以前整条命令报 `not_found`，把一次能做成的输入直接废掉了。
- **ref 查不到时先等屏幕稳定再看一次（`tap` 与 `type`）。** ref 是在一次布局抓取里读的，
  下一次调用再去用；一次 tap 刚移动焦点、键盘还在滑入时，第二次抓取可能拿不到那个元素，
  于是 agent 刚看到的 ref 被报成不存在。zhihu-07 对自己的 `observe` 刚打印的 ref 29407
  连收三次 `not_found`，一秒后一模一样的调用却成功了；jd-07 在同一页上 `tap --ref`
  与 `type --ref` 轮流失配，中间插一次 `observe` 又能打印出同一个 ref。现在失配后先
  `settle` 再查一遍，仍是失配才报——ref 在稳定屏幕上存在，就不能读成「不存在」。
- **`observe --out` 只给了路径，没给图。** 它会写一张 JPEG，但 MCP 层只把 `screenshot`
  和 `inspect` 的图像附在结果里，`observe --out` 的图从来没到过模型手上。拨号盘是代价：
  十二个按键既没有 text、也没有 description、也没有 id（`accessibilityId` 在真机 dump 里
  只是节点序号），屏幕输出只有 `button @960,1690`。contacts-05 用 `observe --out`
  要了十次图，每次只拿回一个路径，只好靠试按去猜键位——36 次调用、412 秒才过。
  现在 `observe --out` 的图随结果一起返回，工具描述也写明了。同批的 contacts-06
  直接用 `type --clear` 输入，6 次调用、153 秒。
- **卡片类的控件只报了前三段文字，把关键数字丢掉了。** 一个可点击的商家卡片里有店名、
  评分、月售、起送价、配送费，还有一排菜品价格；`labelOf` 只把**前三段**子文字拼进标签，
  「起送 ¥20」「配送费 ¥0.2」——正是任务要问的两个数——从来没出现在屏幕输出里。
  实测美团搜索结果页 88 个节点里 76 个是无标签的 button；整批美团屏幕的标签覆盖率
  53%，同门的大众点评是 97%。meituan-06 因此在一个模型已经丢掉的数字上耗到 480 s 超时。
  现在上限是 12 段，标签仍截断到 80 字符（实测一张最挤的卡片拼完 68–72 字，两个数字都还在）。
- **`launch --app 天气` 能用了：短名会匹配桌面上的应用名。** 中文写的任务用桌面上的名字称呼
  应用（「天气」「微博」「备忘录」），这些字在 bundle id 里一个都没有；此前 `launch` 只匹配
  bundle id，agent 只好退回「观察桌面 → 点图标」。实测 1000 条跑批的前 24 次 `launch` 里
  13 次因此失败。现在 bundle id 匹配不到时会读 `bm dump -a -l`，按桌面名匹配；一个名字对应
  多个 bundle 时报错并列出全部候选。这台机器上 `备忘录` 是 `com.huawei.hmos.notepad`、
  `笔记` 是 `com.huawei.hmos.hinote`，两个都装了，按名字才分得开。
- **skill 把无标签控件指到了 `inspect`。** 原来写的是「拿 `screenshot`，看图上的 ref 编号」，
  但画编号的是 `inspect`；`screenshot` 只存原图。`check-skill` 增加一条检查，文档里再出现
  「screenshot 上的 ref 编号」就会报错。
- **`launch --app 图库` 打开的是投屏页，不是图库。** 选入口 ability 时依次试
  `mainAbility`、它的最后一段、任意 PAGE ability。图库声明的是裸词 `MainAbility`，
  真正由桌面图标启动的是全限定的 `com.huawei.hmos.photos.MainAbility`，而且排在
  `CastAbility`、`GalleryCleanupAbility` 之后，于是第三条规则选中了投屏页。现在优先选
  声明了 `action.system.home` 的 ability——它就是桌面图标启动的那个。20 个应用的
  bundle 全部扫过，每个都落到自己的 launcher ability，原来对的没变。
- **`launch` 的工具描述说清了怎么用。** 原来只有一句「Start an app by name or bundle id.」，
  没提桌面上的名字。1000 条跑批里 78 条任务只有 35 条读了 skill（45%），其余只看到
  MCP 工具描述——四条 notepad 任务因此去点 dock 里那个标签是 bundle 转储的图标，
  打开的是「笔记」而不是「备忘录」。现在描述写明「按屏幕上的名字启动，优先用它，
  不要点桌面图标」。

## [0.11.2] — 2026-11-20

四个包同批发布；本版只有修复，无破坏性变更。

### 修复

- **`type` 会回读输入框，打错字不再报 `settled`。** 电话拨号盘的输入框会把 `10086` 变成
  `1086` / `10 1080 86`：逐字输入时每个数字进了它自己的格式化缓冲，设备自带的
  `uitest uiInput text` 也一样。此前 `type` 不看结果，直接报 `settled`，agent 于是相信一个
  根本没输进去的号码——假成功比丢字更糟。现在写完会读回同一个输入框，值不一致时报
  `uncertain` 并说明框里实际是什么；密码框的值不会出现在消息里；`1,000` 这类只差格式的
  渲染仍算成功。实测：`type --ref 4392 --text 10086` 返回
  `uncertain · the field does not hold "10086" after typing`（退出码 1），
  `--paste` 则精确写入。
- **`inspect` 在结果里报出写的文件。** 它已经返回 `image` 字段，但 MCP 服务要读的是 `path`；
  `screenshot` 两个都有，`inspect` 缺一个，于是带编号的标注图拿不到。现在两者一致。
- **`--confirm sends` 不再把信息流里的文字当成动作。** 点开一条知乎问题，标题里的「发布」
  触发了发送审批，agent 只能停下。元素类型分不开两者——知乎把整行渲染成可点击容器，角色
  也是 `button`——但标签形状可以：控件用几个词命名动作（发布 / 发布笔记 / 立即付款），
  信息流是一整句。现在点击、滑动这类步骤只在标签像控件名时按动作判定；打字仍看原始标签，
  因为输入的文字本身就是动作。用 20 条跑批里真实的 1715 个标签回放：会触发审批的从 50
  降到 10，去掉的 27 条全是内容行或「35人付款」这类统计，新增误报 0。
- **复用已存在的端口转发。** 进程被硬杀（宿主杀掉 MCP 子进程、agent 崩溃）时转发会留下，
  下一次连接不再新加一个，而是用已有的那个，并记为「复用」——`fportRemove` 不动它，因为不是
  本进程建的、可能有别的进程在用。指向别的端点的端口仍然跳过，不会被抢占。长跑批里每条任务
  漏一个本地端口，几百条之后 `hdc fport` 就不再接受新转发。

## [0.11.1] — 2026-11-19

第二轮全仓评审（`docs/reviews/codex-architecture-review-2.md`）之后的修正版，
外加验收 `uitest-mirror` 时暴露的窗口缺陷，以及一个关闭时的投流泄漏。没有
破坏性变更；一处行为变化写在下面第一条。

- **`openWindow` 不再把「浏览器没启动」当成「窗口被关掉」**。`spawn` 找不到
  可执行文件时不会抛错，而是异步发出 `error` 和退出码为负的 `close`；把那次
  `close` 当作人关窗，让 `uitest-mirror` 一启动就退出。现在只有真正发出过
  `spawn` 的子进程退出才算关窗。
- **Windows 上按安装路径找浏览器**。`msedge.exe` / `chrome.exe` 不在 PATH 上，
  此前打印了 URL 却从不打开窗口。新增 `resolveBrowserPath`。
- **`openWindow({ profile: true })`**：给窗口一个独立 profile。浏览器已有实例时，
  新进程只是把 URL 交给它并在几十毫秒内退出——那不是窗口的寿命。镜像类产品用这个
  选项，让进程就是窗口。
- **`openWindow` 返回 `close()`**：产品因 stdin 关闭或 Ctrl+C 停止时关掉自己开的
  窗口，不留一个指向已停服务的页面。
- **`ViewerServer.close()` 不再漏掉关闭途中被丢弃的投流**。流循环在
  `closing` 置位后跳出，`finally` 把 `this.cast` 清空——但 `finishClose` 是在
  等完录制启动和输入通道之后才读这个字段的。手机只要在这段窗口里送来一帧，
  那个即将被 `dispose()` 的投流就不见了：设备上的 `libscreen_casting` daemon
  和 hdc 转发留在原地，那条没关的 socket 还撑住事件循环，产品自己的
  `close()` 都返回了进程却不退出。实测每次镜像停止都可能漏一个 daemon + 一个
  转发，验收脚本等 20 秒后强杀。现在 `finally` 在关闭途中丢弃投流时把它交给
  `castDisposal`，`finishClose` 会等它。
- **`AgentClient` 的重连落在 `close()` 之后时不再留下 socket**。`close()`
  销毁的是它认识的那条连接；重连如果正在进行，新 socket 落地后没人关它，
  同样撑住事件循环。现在重连落地时若已 `disposed` 就直接销毁并报错。
- **每个 ws 视图有自己的设备端口**：`session.view.open()` 的第二个及以后的视图在
  ws 传输上此前都落到设备端口 5000，第二个页面会接管第一个的 daemon。现在按视图
  序号分配 5000、5002、5004……
- **并发生命周期收口**：`Session.close`、`Recording.start/stop`、
  `Device.dispose`、`ViewerServer.close` 都改为等待同一个进行中的操作，第二次调用
  不再提前返回；`Device.connect` 重连或健康检查重启起的 daemon 也会被 `dispose()`
  收掉；两个投流客户端在 `ps -ef` 还没显示自己的 daemon 时，按 pidof 差值只杀那一个
  新进程。
- **启动失败的错误不再残留**：一次 `--record` 启动失败后，后续重试成功时新接入的
  标签页不再被告知「录制失败」。

## [0.11.0] — 2026-11-18

第四个产品 `uitest-mirror` 需要的四处能力。全部是新增，没有破坏性变更。

- **`Session.keepAwake(seconds?)`**：覆盖设备的休眠超时（`power-shell timeout -o`），
  返回的句柄 `restore()` 幂等、失败可重试。会话自己记着发出去的句柄：`session.close()`
  会把还没复位的一个个复位，所以产品只要 `close()` 会话就不必再管它。默认 3600 秒。
  进程被强杀时覆盖会留在设备上，用 `hdc shell power-shell timeout -r` 复位。
- **`CastOptions.maxSize`**：按最长边（像素）指定投流尺寸，由 `resolveCastScale`
  按传输换算——grpc/ws 是 1..5 的整数除数，mjpeg 是小数比例。与 `scale` 同时给是
  `EBADARG`；超过扩展能缩到的极限也报错并给出可达尺寸，不静默取整。
- **`ViewerServerOptions.recordOnStart`**：流一进入 `live` 就开始录制，不需要点页面上的
  录制按钮。带 `--record <file>` 的产品用它；`close()` 会等这个录制落地再停止它。
- **`uitest-sdk/viewer` 新增 `openWindow` / `appWindowCommand`**：无边框浏览器窗口
  （`--app=<url>`），没有 Edge/Chrome 时打印 URL。从 `uitest-console` 提升上来，
  两个产品共用一份。
- **Recents 键**：播放器多了一个「任务」按钮，`LiveInput.key("recents")` 发送它。
  HarmonyOS 没有「最近任务」的键值——`oh_key_code.h` 里没有 `APP_SWITCH`，AOSP 的
  187 以及 `KEYCODE_VIRTUAL_MULTITASK`（2210）、`KEYCODE_TASKMANAGER`（2717）在真机上
  都无反应。系统自己的路径是**从底边向上滑并按住 3.5 s**，这里发的就是这条手势。
  `parseKeyName("recents")` 因此仍然报未知键，而不是静默什么都不做。

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
