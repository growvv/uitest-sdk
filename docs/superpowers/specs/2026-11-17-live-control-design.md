# live 页接管与输入设计（scrcpy 级跟手 + 双通道）

## 1. 目标

`uitest-phone live` 现在只能看。要把画布变成真正能操作设备的入口：

- **默认只读**，点「接管」之后，画布上的点击、长按、拖动、滚动、双指缩放、键盘输入、返回/Home 才发到设备。
- **跟手**：单指按下即到设备，拖动时移动事件连续上送，不做「先判断再补发」的延迟。
- **不互相拖慢**：读屏/截图/录屏与输入走两条独立的 agent 连接，输入永远不等布局轮询。
- **稳**：掉线不静默、不把设备卡在「一直按着」；任何失败都回到只读，不做隐式降级。
- **功能对齐 scrcpy**（单指全手势、键盘、系统键、双指缩放、滚轮），页面视觉和商业云手机一个水准。
- **可验收**：以知乎为例产出可复现的验收报告；官网加一段真机截图驱动的操作动画。

**成功标准**（真机 BRA-AL00 / HarmonyOS 7.0，下同）：

1. 接管状态下点击注入 p50 ≤ 20 ms、p95 ≤ 50 ms（布局轮询 400 ms 周期同时进行）。
2. 拖动移动事件发送间隔 16 ms，设备端单次 move 3.93 ms，队列里最多积压 1 个待发位置。
3. 接管期间投屏帧率相对基线下降 ≤ 10%。
4. 10 分钟混合操作：0 次卡指针（watchdog 触发 0 次）、0 次需要重开页面、0 次隐式降级。
5. 验收报告里每个场景都有前置状态、操作、设备侧证据（截图或布局 diff）和耗时。

## 2. 已确认的决策

| 决策 | 结论 |
|---|---|
| 控制模型 | 默认只读；显式「接管」，同一时刻只有一个页面能操作 |
| 输入范围 | 点、长按、滑动滚动、键盘、返回/Home、双指缩放；对齐 scrcpy |
| 架构 | 读通道（现有 `session.agent`）只做 capture/layout/screenshot/record；写通道是第二条 fport + `AgentClient`，只做触摸/按键/文本/矩阵 |
| 坐标 | 客户端按画布内在像素换算成设备像素；两端都 clamp |
| 双指 | `PointerMatrix` 分段注入（设备只认预计算的矩阵手势），不是逐帧双指事件 |
| 键盘 | 客户端缓冲，300 ms 空闲或回车时发送；≤12 个 ASCII 字符逐字输入，更长或含非 ASCII 用粘贴（覆盖设备剪贴板） |
| 系统键 | 返回 = 2，Home = 1，回车 = 2054，删除 = 2055 |
| 租约 | 不变：`live` 进程终身持有，接管是页面内的协调，不申请第二份租约 |
| 失败策略 | 写通道坏了就回只读并明确告知；绝不自动切回读通道发输入 |
| 验收载体 | 知乎（公开内容页），生成的报告 + 截图；不点赞、不评论、不发布 |
| 官网动画 | 真机截图 + CSS/JS 合成光标动画；不新增视频编码，零外部依赖 |

## 3. 实测依据

设计不是猜的，下面每条都来自本机的探测脚本（`.work-bench/`，未跟踪）：

| 事实 | 数字 | 对设计的影响 |
|---|---|---|
| 单次 click RPC | p50 7.4 ms，p90 35.4 ms | 输入本身很便宜，慢的是排队 |
| `captureLayout` | p50 322.5 ms，max 596.9 ms | 读屏是长 RPC，和输入共用一条串行队列 |
| 布局读取期间的 click（同一条连接） | 594.7 ms | 单通道方案直接否掉 |
| 同场景改走第二条连接 | 60 次 click 并发 23 次读屏：p50 12.3 ms，p90 16.1 ms，max 41.4 ms，0 错误 | 双通道成立 |
| 流式 `touchMove` | 3.93 ms/move（254 Hz 容量） | 60 Hz 发送只占 1/4 容量 |
| 流式双指（两个 pointer 的 down/move/up） | 设备无任何缩放（截图逐字节相同） | 双指只能走矩阵 |
| `PointerMatrix` 单段（2 指 6 点） | 47–102 ms | 缩放按段发，2–4 段/秒 |
| 3×200 ms 连续矩阵段 | 1272 ms 完成，缩放连续 | 分段可行，段间抬手不重置缩放 |
| `triggerKey` | 112–137 ms | 系统键按钮要有按下反馈，不能连点 |
| `mouseScroll` | ~212 ms | 滚轮做积压合并 |
| `inputText` 逐字 | ~179 ms/字符 | 短文本可接受，长文本太慢 |
| `inputText` 粘贴 | 1.3–1.9 s 常数 | >12 字符或中文走粘贴 |
| `Gestures.multiTouch` 默认 | 548 ms（steps 过多） | 不复用默认参数：显式 `steps: 6`、时长 120–200 ms |
| 屏幕外坐标 | `Illegal touch point coordination`，连接被丢弃 | 坐标必须两端 clamp |
| 捕获互斥 | 第二条连接做 capture 报 `Capture already running: dumpLayout` | 所有 capture 留在读通道 |

## 4. 架构

### 4.1 模块

```
浏览器 player
  │  WS: control / input
  ▼
LiveServer（src/live/server.ts）
  │  仲裁「谁在接管」、watchdog、广播状态
  ▼
LiveInput（src/live/input.ts）
  │  指针状态机、移动合并、文本缓冲、坐标 clamp、看门狗
  ▼
InputLane（src/live/input-lane.ts，接口）
  │  click / touchDown / touchMove / touchUp / key / text / pinch / scroll / close
  ▼
AgentInputLane：第二条 fport + AgentClient → 设备 Gestures/Driver
```

- **`src/live/input-lane.ts`**：定义 `InputLane` 接口和 `AgentInputLane` 适配器。适配器只做协议翻译，不含策略。`pinch` 在适配器里构造 `PointerMatrix`（2 指、6 点、时长按距离变化给 120–200 ms），一次调用注入一段。
- **`src/live/input.ts`**：`LiveInput`，纯策略，不碰 socket。构造时注入 `InputLane`、`bounds()`、时钟与错误回调，因此可以在 vitest 里用假 lane 全量测试。
- **`src/device.ts`**：新增 `Device.openInputLane(): Promise<{ lane: InputLane; close(): Promise<void> }>`。内部用 `hdc.fportAdd(agentPort ?? 8012, "tcp:8012")`（hdc 会自动选下一个空闲端口），`connectTcp`，然后 `new AgentClient(sock, { requestTimeoutMs, retryOnBusy })`（与主通道同配置）。`close()` 关闭 client 并 `fportRemove`。**不做自动重连**：状态在途时透明重连会制造难以推理的重复事件；下一次接管时重新开一条。
- **`src/live/server.ts`**：`LiveSource` 增加可选 `openInput?(): Promise<{ lane: InputLane; close(): Promise<void> }>`。服务器启动时**后台预开**写通道（失败不致命），首次接管通常零等待；打开失败按 5 s 退避，运行中失败按 500 ms 退避，下一次接管再试。
- **`src/live/cli.ts`**：`startLive` 装配 `openInput`；`LiveRun.close()` 里先释放控制器，再关写通道，最后 `session.release()`。
- **`src/live/player.ts`**：只加交互与呈现，协议解析集中在一处。

### 4.2 数据流

1. 用户点「接管」→ `{"type":"control","action":"take"}`。
2. 服务器：无控制器且写通道可用 → `LiveInput` 绑定该 tab；广播 `{"type":"control","state":"controlled","clientId":"c1"}`；之后才接受该 tab 的 `input` 消息。
3. 指针事件在浏览器里换算成设备像素 → `{"type":"input","action":"down","x":...,"y":...}`（move/up 同构）。
4. 服务器把消息交给 `LiveInput`；移动消息进合并槽，down/up/键/文本/矩阵进有序队列。
5. `InputLane` 按序执行；`LiveInput` 记录每次 RPC 的耗时。
6. 服务器在控制期间最多每秒广播一次 `{"type":"control","state":"controlled","clientId":"c1","stats":{"p50":12,"p95":18,"n":24}}`（最近 200 次注入的窗口统计）。页面显示 p50；验收脚本累计 p50/p95。页面不发额外心跳；WS 自己保活。

## 5. WebSocket 协议

现有消息（hello/nodes/cast/privacy/shot/record/state）保持不变，新增：

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{"type":"control","action":"take"}` | 请求接管 |
| C→S | `{"type":"control","action":"release"}` | 主动退出 |
| S→C | `{"type":"control","state":"readonly"}` | 当前无人接管（含初始状态） |
| S→C | `{"type":"control","state":"controlled","clientId":"c1","stats":{"p50":12,"p95":18,"n":24}}` | 有人接管；`clientId` 用于本地判断「是不是我」；`stats` 最多每秒一次 |
| S→C | `{"type":"control","state":"readonly","reason":"busy","by":"c2"}` | take 被拒；`by` 是持有者 |
| S→C | `{"type":"control","state":"readonly","reason":"error","message":"..."}` | 写通道不可用或出错 |
| C→S | `{"type":"input","action":"down","x":0,"y":0}` | 单指按下 |
| C→S | `{"type":"input","action":"move","x":0,"y":0}` | 单指移动 |
| C→S | `{"type":"input","action":"up","x":0,"y":0}` | 单指抬起 |
| C→S | `{"type":"input","action":"pinch","cx":0,"cy":0,"half":120}` | 以中心 + 半距表示的双指段 |
| C→S | `{"type":"input","action":"wheel","x":0,"y":0,"dy":-100}` | 滚轮；正数向下 |
| C→S | `{"type":"input","action":"text","text":"...","x":0,"y":0}` | `x/y` 可选，缺省用焦点输入框中心 |
| C→S | `{"type":"input","action":"key","key":"back"|"home"|"enter"|"delete"}` | 系统键 |

约束：

- `hello` 增加 `clientId`（服务器分配，`c1`、`c2`…）与 `control: {state, by?}`；`nodes` 消息不变。
- 只有当前控制者的 `input` 消息被处理；其他 tab 发来的直接忽略（不报错，避免把一个误触的旧页面变成错误源）。
- 坐标是设备像素整数。服务器收到后先 clamp 到当前显示区域，再交给 `LiveInput`；`LiveInput` 自己也 clamp（双保险，防测试与旧客户端）。`bounds()` 取最近一次布局的 `screen.display`；`--no-layout` 时没有布局，服务器不 clamp（客户端已按画布内在尺寸 clamp）。
- `half` 是两指距离的一半，范围 clamp 到 `[20, 显示短边/2]`。服务器不做增量换算：第一次 `pinch` 只记基线不发；之后每段用上一次的 `half` 作 `from`、新值作 `to`。单指 `down` 会清掉基线。
- 文本消息只接受字符串，长度上限 2000 字符；超长截断（避免一次粘贴把设备卡死）。

## 6. 输入语义

### 6.1 单指：原始事件直通

- `pointerdown`（主键）→ 立即 `touchDown(x,y)`；`pointermove` → `touchMove`（16 ms 节流）；`pointerup`/`pointercancel` → `touchUp`。
- 点击、长按、双击、拖动、甩动全部由设备自己判定——这是跟手的关键；客户端不识别手势，不延迟补发。
- `setPointerCapture(pointerId)`，保证手指移出画布仍能收到 up。
- `lostpointercapture` 或 `pointercancel` → `up`，并清本地拖动状态。
- `LiveInput` 保证顺序：down 未完成时 up 排队不丢；移动只保留最新一个（合并），且不会插到 down 前面。
- 设备端长按阈值由组件决定（通常 500 ms），因为 down 在按下瞬间就发出了，长按反馈与真机一致。

### 6.2 双指缩放

- 浏览器维护指针表。第二个指针按下时：
  1. 若第一指仍按着，先发 `touchUp`（结束单指手势，设备只支持一个指针，别无选择）；
  2. 进入缩放模式，中心 = 两指中点，半距 = 距离/2；
  3. 每隔 ≥120 ms 且半距变化 ≥2 px 发一次 `pinch`；
  4. 任一指针抬起 → 退出缩放模式，**不**恢复拖动；必须全部抬起后重新按下才能开始新手势。
- 桌面：Ctrl + 滚轮 → `pinch`，中心取鼠标在画布上的位置，`half` 按指数变化（`half *= exp(-deltaY * 0.002)`，clamp）。
- 触屏：两指直接缩放，行为同手机。
- 段与段之间设备会抬手再按下，应用不会重置缩放级别；单段内部是完整手势。

### 6.3 滚轮

- 普通滚轮 → `mouseScroll(x, y, dy > 0, steps)`，`steps = clamp(round(|dy| / 100), 1, 5)`。
- 同一时刻只发一个滚轮 RPC；等待期间累计 `dy`，完成后合并发送一次。滚轮是浏览行为，丢中间态无感。
- 方向常量在实现第一步用知乎列表校准（`true` 向下），校准结果写入代码注释与验收报告。

### 6.4 键盘

- 底部输入条是「待发送文本」，不是设备输入框的镜像。输入框里的字消失 = 已经发到设备。**缓冲与发送时机在页面里**（浏览器才知道组合输入状态）；**发送模式由 `LiveInput` 决定**（同一个规则只实现一次，可单测）。
- 发送时机：无输入法组合时 300 ms 空闲；`compositionend` 后 300 ms；回车；「发送」按钮；退出接管前先 flush。
- 已知取舍：一次 flush 之后输入框清空，此时在里面按退格只作用于下一段，不会删设备上已经发出的字；要删设备上的字用「删除」按钮。
- 发送前先 trim；空串不发。换行折成空格（单行输入条本来也输入不了换行）。
- 模式：
  - 全部 ASCII 且 `length ≤ 12` → `inputText(point, text, { addition: true })` 逐字输入（~179 ms/字符）。
  - 否则 → `inputText(point, text, { paste: true, addition: true })`，1.3–1.9 s，**会覆盖设备剪贴板**；输入条下方常驻一行小字提示。
- 目标点优先级：页面消息里带的点（用户刚点的输入框）→ 最近一次布局里 `focused && input` 的节点中心 → 本次接管中最后一次按下的点 → 显示区域中心。
- 回车键的行为：先 flush 文本，再发 `key: "enter"`（2054）。这样「输入 → 搜索」一步到位；只想打字不想回车就用「发送」按钮。
- 组合输入（拼音）期间不 flush；`compositionend` 才把整词放进缓冲。非 ASCII 必然走粘贴，不做逐字 IME 模拟。

### 6.5 系统键

按钮：返回、Home、回车、删除。键盘快捷键只绑 `Esc`（退出接管），不劫持浏览器快捷键。

- 返回 `triggerKey(2)`，Home `triggerKey(1)`，回车 `triggerKey(2054)`，删除 `triggerKey(2055)`。
- 系统键 RPC 112–137 ms；按钮按下后进入 150 ms 禁用态，防连点堆队列。
- `key: "delete"` 是「向后删除一个字符」，不是「清空输入框」。

### 6.6 坐标与字号

- 画布内在尺寸就是解码帧尺寸（`canvas.width/height`），等于设备当前旋转下的像素。
- `x = round((clientX - rect.left) * canvas.width / rect.width)`，`y` 同理，再 clamp 到 `[0, width-1]`、`[0, height-1]`。
- 不使用 `hello.width` 做换算（`--no-layout` 时为 0）；`hello.display` 只用于节点框定位（现状不变）。

## 7. 接管状态机

服务器是唯一仲裁者，状态只有 `readonly` 和 `controlled`：

| 事件 | 结果 |
|---|---|
| take，无人控制且写通道可用 | → controlled，广播；`clientId` = 请求者 |
| take，已有人控制 | 拒绝，回 `reason:"busy"`，不改状态 |
| take，另一个 take 正在打开通道 | 立即拒绝 `busy`，不排队（避免两个页面都以为自己在操作） |
| take，写通道打开失败 | 拒绝，回 `reason:"error"`；退避后允许重试 |
| release | → readonly，立即广播；`cancel()` 同步发起，抬指针在后台落完 |
| 控制者 tab 断开/页面关闭 | 同 release |
| 写通道 RPC 失败 | `cancel()` → readonly → 广播 `reason:"error"`；丢弃这条 lane，下次 take 重开 |
| 10 s 没有新的指针事件而仍有 down | watchdog 强制 `touchUp`，保留控制权（人可能只是松手没发出来） |
| 服务器关闭 | release → 关 lane |

- **租约关系**：`live` 进程的租约不变，接管不碰 `Lease`；其他进程要拿设备仍然按现有规则让 `live` 退出或 `hold`。页面级接管只解决「多个浏览器 tab 同时操作」。
- **读轮询继续**：接管期间布局轮询保留，节点框与详情仍然更新；它在读通道上，不会拖慢输入。
- 页面收到 `controlled` 且 `clientId` 不是自己时：接管按钮禁用，tooltip「另一个页面正在操作」；本页保持只读，节点框仍可点。
- 页面收到自己 controlled 时：`#boxes` 整体 `pointer-events: none`（点击落到画布），顶部出现「接管中」徽标，画布描边变琥珀色。

## 8. 页面交互与视觉

全部内联在 `player.ts`，沿用现有 CSS 变量与系统字体，不引外部资源。

**头部**（现有 header 右侧追加）：

- `#takeover` 主按钮：`接管` / `退出接管`。只读时是琥珀色实底，接管后是描边。禁用时给出原因。
- `#control-state` 小徽标：`只读` / `接管中`（绿点脉冲）/ `他人接管`。
- `#input-ms` 延迟读数：服务器窗口统计的 p50，接管时才显示，如 `输入 12 ms`。

**画布区**：

- 接管时画布 `cursor: crosshair`，`#frame` 加 2 px 琥珀描边与内阴影。
- 本地反馈：按下处出现 24 px 的涟漪（300 ms 淡出）；拖动时一个 8 px 圆点跟随。它只代表「事件已发出」，不代表设备已响应——视频仍是唯一真相。
- 不显示缩放比例：设备读不到当前缩放级别，显示了也是假的。
- 只读时保持现状（节点框可点、行可选中）。

**底部输入条**（接管时滑出，只读时隐藏）：

- 文本输入框（placeholder「输入文字后回车发送」）、`发送`、`返回`、`Home`、`回车`、`删除`。
- 一行提示：「超过 12 字或中文将用粘贴，会覆盖设备剪贴板」；仅当缓冲区进入粘贴模式时高亮。
- 移动端可用：输入条在窄屏换行，按钮等宽；不做专门的移动版式。

**状态与错误**：

- 顶部 toast：接管成功/失败、写通道断开（「输入通道断开，已回到只读」）、坐标被 clamp 不提示（无感）。
- 页面卸载/WS 关闭 → 不等待服务器，本地直接回只读视觉。

## 9. 错误处理

| 失败 | 行为 |
|---|---|
| 写通道打不开 | 让「接管」按钮禁用并显示原因；投屏/读屏不受影响；每 5 s 后台重试 |
| 注入 RPC 超时/连接被丢弃 | `cancel()` 抬指针 → 回只读 → 广播 error → 关这条 lane；不自动降级到读通道 |
| 设备报 `Illegal touch point coordination` | 理论上被 clamp 挡住；若仍发生，按上一条处理 |
| 矩阵注入失败 | 按 lane 失败处理：抬指针 → 回只读 → 广播 error；不在坏通道上重试 |
| 文本粘贴失败 | 同上。粘贴的副作用已经发生，重试无法保证只发生一次 |
| tab 在拖动中关闭 | 服务器 `cancel()`；watchdog 兜底 |
| 浏览器卡顿导致 move 堆积 | 服务端只保留最新 move；down/up/键不丢 |
| 投屏断流但输入通道健康 | 可继续输入（用户可能盲操作），页面显示现有重连状态；不强制退出接管 |
| 输入通道健康但投屏断流超过 30 s | 提示「画面已断开，是否退出接管」，不自动退出 |

## 10. 性能目标

| 指标 | 目标 | 测量点 |
|---|---|---|
| 点击注入 RTT | p50 ≤ 20 ms，p95 ≤ 50 ms | `LiveInput` 内 RPC 前后 `performance.now()`，随 control 广播 |
| 移动发送 | 16 ms 间隔，队列 ≤ 1 个待发 move | 单元测试 + 真机统计 |
| 接管冷启动 | ≤ 1.5 s | take 请求到 controlled 广播 |
| 接管热启动 | ≤ 300 ms | 写通道已预开 |
| 投屏帧率影响 | ≤ 10% | 接管前后各 60 s 的 fps 对比 |
| 稳定性 | 10 min 混合操作 0 卡指针、0 隐式降级 | 验收脚本 |

## 11. 测试与验收

### 11.1 单元测试（vitest，无设备）

新增 `test/unit/live-input-lane.test.ts` 与 `test/unit/live-input.test.ts`，用记录调用的假 `InputLane` 和可控的 `now()`：

1. tap = `touchDown` 后 `touchUp`，同一点。
2. 一个 move 在途时连发 5 个 move → 只补发最后一个。
3. down 在途时 up 排队，不丢、不越序。
4. 屏幕外坐标被 clamp 到边界；`bounds()` 为 null 时原样透传。
5. 按住 10 s 无移动 → watchdog 发 `touchUp`。
6. `cancel()` 清空待发队列、抬起按着的指针并回到 idle；不死等不回答的 lane。
7. 拖动中开始 pinch → 先 `touchUp`；首次只记基线，之后每段 `from` 是上一段的 `to`。
8. `type()`：≤12 个 ASCII 字符 → 逐字模式；13 个或含中文 → 粘贴模式；空串与纯空白不发；换行折成空格；没有焦点输入框时用最后按下的点。
9. 滚轮在途时累计增量，完成后合并成一次。
10. lane 拒绝 → 状态回调 error、回到 idle、不留下按着的指针。
11. `stats()` 返回注入耗时的 p50/p95。
12. `AgentInputLane`：矩阵段 2 指 × 6 点、文本模式参数、系统键码、滚轮方向参数。

扩展 `test/unit/live-server.test.ts`（沿用现有假 `LiveSource` 风格）：

13. 一个 tab take 成功，所有 tab 收到 controlled；hello 带 `clientId` 与 `control` 状态。
14. 第二个 tab take 被拒（busy），状态不变；同一 tick 的两个 take 也只有一个成功。
15. 写通道打不开时 take 被拒（error），不进入 controlled。
16. 非控制者的 input 被忽略（假 lane 调用次数为 0）。
17. 控制者的 down/move/up/key/text/pinch/wheel 按序到 lane。
18. 控制者断开 → 广播 readonly 且抬指针。
19. 假 lane 注入即拒绝 → 广播 error 并回只读；退避后下一次 take 重新 `openInput`。
20. watchdog 到期抬指针，控制权保留。
21. 服务器关闭时先 cancel 再关 lane。

### 11.2 真机验收（`scripts/acceptance-live.ts`）

生成的报告：`docs/acceptance/live/report.md`；证据：`docs/acceptance/live/screenshots/`。前置：屏幕常亮、停在知乎公开页面（热榜或搜索页），通知栏清空。

场景（每个都有前置、操作、设备证据、耗时）：

1. **只读保护**：未接管时直接发 input → 被忽略，节点快照不变。
2. **接管**：take 成功；第二个客户端 take 被拒；广播正确。
3. **点击**：点热榜第一条 → 标题/节点变化；记录 p50/p95。
4. **长按**：长按一条内容 → 菜单/弹层出现；用返回关闭。
5. **滚动**：down/move/up 向上滑 → 内容位移、有效 ref 变化。
6. **键盘**：点搜索框 → 粘贴「鸿蒙」→ 搜索框/结果出现该词；回车进入结果页。
7. **系统键**：返回上一页；Home 回桌面；`aa start` 重新打开知乎。
8. **双指缩放**：打开知乎图片查看器 → 放大一档 → 图片节点矩形/截图比例变化。
9. **稳定性**：先空转 60 s 记基线帧率；接管后跑 10 分钟、每 500 ms 一次混合操作（滚动为主，加搜索框文本与返回；不点任意卡片，避免误触点赞/评论），期间一个 tab 在拖动中断开 → 服务器回只读、重新 take 成功、后续滚动正常；控制期间 fps ≥ 基线的 90%，重新 take 的 ack ≤ 300 ms。
10. **真页面键盘（人工浏览器步骤）**：在真实 `live` 页面里输入英文，确认 300 ms 空闲自动落到设备；用输入法打一个中文词，确认组合期间不上屏、`compositionend` 后整词粘贴；这两项写进报告的「浏览器人工检查」小节并截图。

通过标准：9/9 自动场景；第 10 项人工确认；点击 p50/p95 达标；无卡指针；截图逐张人工检查后才提交。全程不点赞、不评论、不发布。

### 11.3 官网动画

- 在 `site/index.html` 的 `#showcase` 之前新增 `#control` 区块：「在浏览器里接管手机」。
- 素材：验收过程中截的 4–6 张知乎内容页（裁掉状态栏与账号信息），压缩到总计 ≤ 600 KB。
- 呈现：手机边框内切换截图；一枚合成光标按脚本执行「点卡片 → 滚动 → 点搜索框 → 输入 → 双指缩放」；同时高亮页面上的「接管中」徽标与琥珀描边。纯 CSS keyframes + 少量 JS（IntersectionObserver 开始播放），尊重 `prefers-reduced-motion`（静止在当前帧并显示说明）。
- 不新增视频文件，不引外部资源；无 JS 时显示第一帧与文字说明。
- 验证：本地起站，检查首屏无抖动、动画循环、低动态模式；如有无头浏览器则截图对比。

### 11.4 回归

- `npm test` 全绿；现有 16 项能力验收脚本不受影响（跑一遍确认）。
- `npm run typecheck` / `tsc` 无错误（严格模式）。

## 12. 交付物与发布

- 代码：`src/live/input.ts`、`src/live/input-lane.ts`、`src/device.ts` 增量、`src/live/server.ts`、`src/live/cli.ts`、`src/live/player.ts`。
- 测试：新增 `live-input-lane.test.ts`、`live-input.test.ts`；扩展 `device.test.ts`、`live-server.test.ts`、`live-cli.test.ts`；`scripts/acceptance-live.ts`。
- 文档：`docs/acceptance/live/report.md`（生成）、README 的 live 小节补「接管」、`docs/13-stage-log.md` 记一轮、CHANGELOG。
- 官网：`#control` 区块 + 截图素材。
- 版本：0.9.0。**不自动发 npm / 不自动 push**；发布按既有 token 流程单独确认。
- 兼容性：协议只增不改，旧页面照常只读；`--no-layout` 下键盘目标点退化为最后按下的点。

## 13. 非目标

- 不做声音回传、文件推拉、应用管理、剪贴板读取。
- 不做三指及以上手势；不做设备端 IME 逐字模拟（非 ASCII 走粘贴）。
- 不改租约、daemon、casting 的实现；不引入自动传输回退。
- 不做移动端专用版式；页面在手机上能基本操作即可。
- 不把接管做成跨进程排他（那是租约的事）。
