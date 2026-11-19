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
