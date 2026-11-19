# 外部基准调研：mobile testing 论文与 pinky 的自测方法

> 记录于 2026-11-19。用于以后决定「拿什么证明我们的水平」，不是结论，是待办依据。
> 相关实测见 [benchmarks.md](benchmarks.md)（动作时延）与 [benchmarks-mirror.md](benchmarks-mirror.md)（投屏质量）。

## 两类基准，测的不是一回事

| 类别 | 测什么 | 代表 | 我们现状 |
|---|---|---|---|
| Agent 任务成功率 | 一句自然语言指令，agent 能否在真机把事做完 | AndroidWorld、Mobile-Bench、MobileAgentBench、MAS-Bench | **没有** |
| 镜像 / 传输质量 | 首帧多快、拖动掉不掉帧、输入到画面多久 | pinky-mirrorbench | **已有**（`scripts/bench-mirror.ts`） |

两类不能互相替代。前者测 agent，后者测驱动与投屏。我们的 SDK 在论文基准里是「被使用的一方」，
不是被测对象；拿 AndroidWorld 跑我们当 driver，得到的是「我们的 UI 树 + 动作 + 等待语义够不够让 agent 成功」，
这个数字有价值，但需要写 HarmonyOS 适配层。

## 学术基准清单

| 名称 | 出处 | 规模 / 特点 |
|---|---|---|
| AndroidWorld | arXiv:2405.14573（Google Research） | 动态 Android 环境，任务可参数化，目前引用最多的事实标准 |
| MobileAgentBench | arXiv:2406.08184 | 轻量、任务集固定，方便横向比 |
| Mobile-Bench | arXiv:2407.00993 | 832 条 / 200+ 任务；GUI 与 API 动作混合；check-item 判分 |
| MAS-Bench | arXiv:2509.06477 | 139 任务 / 11 app / 88 shortcut / 9 指标；多 agent |
| MobileWorld | ACL 2026 | 较新的综合环境 |
| MobilePA-Bench | arXiv:2608.23035 | 面向 planner agent |
| VenusBench-Mobile | arXiv:2604.06182（PMLR v306） | 多任务基准 |

全部绑 adb / Android，HarmonyOS 上要自写适配层。**都是 agent 级，不是 driver 级。**

## pinky（DIYgod/pinky）怎么测自己

Go 桌面 app，Apache-2.0，pre-alpha，让 MCP agent（Claude Code / Codex / Cursor / Gemini CLI）
驱动真机 iPhone / Android，带实时镜像、危险步骤人工批准、接管与停止。

### 1. `cmd/pinky-mirrorbench` —— 镜像质量，四项指标

- 打开手机 / 请求推流到**第一帧**的时间
- 拖动一个列表期间**每秒变化帧数**
- **输入到光子延迟**：第一次手指移动 → 第一帧变化
- 60 Hz / 120 Hz 屏上**会丢多少帧**

```sh
scripts/devlock.sh emulator-5560 go run ./cmd/pinky-mirrorbench -android emulator-5560   # 可加 -bg
```

结果落在 `docs/notes/mirror-smoothness.md`。它的「光子延迟」是从自己的帧流打时间戳推出来的
端到端可见延迟，不是外部高速相机——只有双方同一套方法，数字才可直接比。

### 2. Android companion 的 device 测试

- `make companion` → `android/companion/app/build/outputs/apk/debug/app-debug.apk`
- `companionctl`：装 app、开关无障碍服务、读 UI 树、设置文本、监听事件
- `PINKY_DEVICE=… go test -tags device ./internal/driver/android/companion/`
- `scripts/devlock.sh $ID` 把每条命令串行化——真机只有一台，并发就是噪声
- `make check` / `make app` / `make e2e` / `scripts/smoke.sh`
- 无手机时 `go run ./cmd/pinky --fake`
- 模拟器锁屏时套件**跳过**并打印 "the phone is locked"，不假装通过

值得学的是**结构**：设备锁串行化 + device tag 分离 + fake 模式。
pinky 没有公开的「agent 能力」基准——它测的是镜像好不好用。

### 3. 它没测的

- 没有 agent 任务成功率基准
- 没有和同类产品的横向对比数字
- 没有 CI 里跑的镜像质量门限

## mirrorbench 第二轮：两处修正与一个产品问题（2026-11-19）

- **旧口径把惯性算进了拖动。** 窗口原本是「按下 → 松手 + 400 ms」，松手后的惯性滚动以 ~60–120 fps 出帧，把按住阶段的 ~33 fps 抬成 43–49。现在按住与惯性分行报告，官网与 `docs/benchmarks-mirror.md` 已按新口径重跑。
- **`-frameRate` 是硬限制，不是天花板。** 同一台 MLR-AL10（120 Hz 屏）实测：30 → 拖动 ~23 fps / 惯性 ~32；60 → ~33–35 / ~63；120 → ~59–64 / ~112–120。三档的「输入→画面」都是 45–48 ms，开高不花延迟。上限把编码器的采样间隔定死，60 会让按住阶段的帧率掉到一半。
- **产品问题：`uitest-mirror --max-fps` 默认 30。** 默认体验就是拖动 ~23 fps、惯性 ~32 fps。待办：默认值改为 120（或在 120 Hz 屏上跟随面板），补 CLI 测试，重新验收。**未做**。
- **IDR 请求确实换回参数集帧。** 查看器挂载后 ~1–2 s 内进入 live，不会永远停在 starting；但「静止屏幕的第一幅画面」仍要等真实内容变化（轻推 20 px → 68–82 ms）。这条以前被误读过一次，记录在此。

## agent 任务成功率：第一轮 20 条（2026-11-19）

评测台在 `.work-bench/eval-phone/`（不入库）：Codex 会话通过 `uitest-phone` 的 MCP 服务操作真机，
agent 收工后由脚本回设备判分，不看 agent 自述。20 条任务，单轮不重试，手机未登录任何账号。

结果：**13 通过 / 1 失败 / 5 被登录墙拦住 / 1 超时**；已判分任务里 13/14 通过，293 次 MCP 调用、
12 次调用报错、65 分钟。

三条值得记的产品问题：

- **`uitest-phone mcp` 先连设备、后答 `initialize`。** 设备没挂上、转发冲突或启动慢时，进程在回
  握手之前就退出，MCP 客户端只能看到 `connection closed: initialize response`，看不出原因。
  实测：`--device 0000000000000000` → 214 ms 退出、stdout 一行没有，真正的错误只在 stderr。
  一个 agent 遇到这个会把「服务起不来」当成工具不可用，转去用 PowerShell 杀进程、手拼 JSON-RPC
  （点评那条 484 s 超时就是这么烧掉的）。**待办：先答握手再连设备；连不上时把 `device_offline`
  作为 `initialize` 之后的工具错误返回，而不是让进程消失。**
- **`--confirm sends` 在知乎误伤。** 点开一个问题，标题里含「发布」二字就触发了发送审批，
  agent 停在审批上，任务被记成 blocked。发送类防护应该看控件的语义（按钮/输入框），不是页面文字。
- **天猫「加入购物车」点了没反馈。** 27 次调用后 agent 无法确认加购成功，如实报了 blocked。
  需要确认是页面的无响应，还是工具没把反馈读回来。

评测口径的教训：只比「答案里有没有句号/温度字」这类结构判据会把成功率抬高。规模版把判据分成
内容、设备、结构三档，结构判据单独统计。

## 我们的位置

`docs/benchmarks.md`（动作时延，对比 hdc CLI 与官方路径）：
点击 44.9×、滑动 6.1×、截图 3.8×；H.264 流 15–89 fps vs `screenCap` 轮询约 1.4 fps。

`docs/benchmarks-mirror.md`（本轮新增，四项 mirrorbench 口径）：
首帧、拖动帧率、输入→画面、60/120 Hz 掉帧格子。

仍然没有的：agent 任务成功率。

## 后续可做（按性价比）

1. ~~照搬 mirrorbench 四项指标~~ —— 已完成，`scripts/bench-mirror.ts`。
2. 把 `bench-mirror.ts` 接进发布流程：每版跑一次，数字进验收报告。**未做**
3. 挑 Mobile-Bench 或 AndroidWorld 的一个子集，写 HarmonyOS 适配层，报成功率。**未做**
4. 不要拿 scrcpy README 的 35–70 ms 当基准比：那是非正式宣称，且 scrcpy 帧率随内容变化，不可比。**已记录**
