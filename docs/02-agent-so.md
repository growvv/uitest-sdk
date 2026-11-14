# 02 · `agent.so` —— 官方 hypium 设备侧执行器

| 项 | 值 |
|---|---|
| 文件 | `/data/local/tmp/agent.so`（600,246 B） |
| 版本标记 | `UITEST_AGENT_LIBRARY@v1.1.10` |
| 入口 | `UiTestExtension_OnInit` @ `0x1daac`（408 B）、`UiTestExtension_OnRun` @ `0x1dc44`（336 B） |
| 传输 | TCP **`127.0.0.1:8012`**（`/proc/net/tcp` 可见 `0100007F:1F4C`） |
| 协议 | **换行分隔的 JSON**（`\n` 结尾），非长度前缀 |
| 打包 | 静态链接 libjpeg-turbo 2.1.4 + cJSON |

启动：`uitest start-daemon singleness`（不带 `--extension-name` 时默认加载 `agent.so`）。

## `OnInit` / `OnRun` 分工

`OnInit` 只做三件事：`Modules::SetUiTestFunctions(port, lowLevel)` 保存注入接口、打印 `Welcome to devicetest agent so!` 与版本、返回 0。

`OnRun` 才是主体：`RpcServer::GetInstance()` → `StartService(callback, deathCb)` → 阻塞 → 返回时 `CloseServer` / `WaitAllThreadFinish`。日志 `RpcServer service running!`。

## 请求格式

```json
{"module": "com.ohos.devicetest.hypiumApiHelper",
 "method": "callHypiumApi",
 "params": {"api": "Driver.create", "this": null, "args": [], "message_type": "hypium"},
 "request_id": "20240815161352267072"}
```

响应：`{"result": <value>, "pts": <int64 单调时钟毫秒>}` 或 `{"result": null, "exception": {...}}`。

`module` **必须是** `com.ohos.devicetest.hypiumApiHelper`（实测其他值一律 `Invalid request module`）。`method` 有四种：

| method | params | 说明 |
|---|---|---|
| `callHypiumApi` | `{api, this, args, message_type:"hypium"}` | 主入口，`api` 是 `Driver.xxx` 形式 |
| `callDeviceTestApi` | 同上 | 老的 devicetest API（本版本已无 handler） |
| `Captures` | `{api, args}` | 采集通道，`api` 是裸方法名 |
| `CtrlCmd` | `{api, args}` | 设备控制通道 |
| `Gestures` | `{api, args}` | 原始触摸通道 |

## 能力一：hypium API（`callHypiumApi`）

对象引用是字符串：`Driver#0` / `Component#0` / `On#0` / `PointerMatrix#0`。`On.*` 系列的 `this` 必须传 `"On#seed"`。

### Driver —— 动作

| API | 签名 | 实测 |
|---|---|---|
| `Driver.create` | `():Driver` | ✅ 返回 `Driver#0` |
| `Driver.click` / `clickAt` | `(int,int)` / `(Point)` | ✅ |
| `Driver.longClick` / `longClickAt` | `(int,int)` / `(Point,int?)` | ✅（`longClickAt` 的 hold time 有合法区间，500/1000 被拒） |
| `Driver.doubleClick` / `doubleClickAt` | `(int,int)` / `(Point)` | ✅ |
| `Driver.swipe` / `swipeBetween` | `(int,int,int,int,int?)` / `(Point,Point,int?)` | ✅ |
| `Driver.drag` / `dragBetween` | 同上 | ✅ |
| `Driver.fling` | `(Point,Point,int,int)` 或 `(int,int,int?)` | ✅（参数个数校验严格） |
| `Driver.injectMultiPointerAction` | `(PointerMatrix,int?)` | ✅ 见下 |
| `Driver.triggerKey` | `(int,int?)` | ✅ |
| `Driver.triggerCombineKeys` | `(int,int,int?,int?)` | ✅ |
| `Driver.pressBack` / `pressHome` | `(int?)` | ✅ |
| `Driver.inputText` | `(Point,string,InputTextMode?)` | ✅ |
| `Driver.touchPadMultiFingerSwipe` | `(int,int,TouchPadSwipeOptions?)` | ✅（手指数受限） |
| `Driver.penClick` / `penDoubleClick` / `penSwipe` | `(Point,...)` | ✅ |
| `Driver.penLongClick` | `(Point,float 0~1)` | ✅ 第二参是**压力**不是时长 |
| `Driver.injectPenPointerAction` | `(PointerMatrix,int?,float?)` | 需 PointerMatrix |
| `Driver.crownRotate` | `(signedInt,int?)` | ❌ `Capability not support`（本机无表冠） |

### Driver —— 鼠标

`mouseClick` / `mouseDoubleClick` / `mouseLongClick` / `mouseMoveTo` / `mouseMoveWithTrack` / `mouseDrag` / `mouseScroll` —— **全部实测可用**。

### Driver —— 显示与窗口

| API | 实测结果 |
|---|---|
| `getDisplaySize` | `{displayId:0, x:1216, y:2688}` |
| `getDisplayDensity` | `{displayId:0, x:3952, y:8736}`（DDPI = 密度×160） |
| `getDisplayRotation` | `0` |
| `setDisplayRotation` / `setDisplayRotationEnabled` | ✅ |
| `wakeUpDisplay` | ✅ |
| `waitForIdle` | `(int,int):bool` ✅ 返回 `True` |
| `findWindow` | `(WindowFilter):UiWindow` ✅；空 filter 报 `WindowFilter cannot be empty` |
| `screenCap` / `screenCapture` | 见下文「截图」 |
| `createUIEventObserver` | ✅ 返回 `Driver#0` |

### UiWindow（`findWindow` 之后）

`getBundleName` / `getBounds` / `getTitle` / `getWindowMode` / `getDisplayId` / `isFocused` / `isActive` / `focus` / `moveTo` / `resize` / `split` / `maximize` / `resume` / `minimize` / `close`

实测（focused 窗口）：`com.ohos.sceneboard`、`{0,0,1216,2688}`、mode 0、focused/active 均 true。

### On —— 选择器构造

`this` 必须为 `"On#seed"`：

`On.text` / `On.id` / `On.type` / `On.description` / `On.hint` / `On.accessibilityId` / `On.originalText` / `On.enabled` / `On.focused` / `On.selected` / `On.clickable` / `On.longClickable` / `On.scrollable` / `On.checkable` / `On.checked` / `On.isBefore` / `On.isAfter` / `On.within` / `On.inWindow` / `On.inDisplay` / `On.belongingDisplay`

字符串匹配模式 `MatchPattern`：`EQUALS 0` / `CONTAINS 1` / `STARTS_WITH 2` / `ENDS_WITH 3` / `REG_EXP 4` / `REG_EXP_ICASE 5`。

### Driver —— 查找

`findComponent(On)` → `Component#N`、`findComponents(On)` → 数组、`waitForComponent(On,int)`、`assertComponentExist(On)`。

实测：`On.text("设置")` → `Driver.findComponent` → `Component#0`。

### Component —— 属性与动作

| 类 | API |
|---|---|
| 取属性 | `getText` `getId` `getType` `getDescription` `getHint` `getAccessibilityId` `getDisplayId` `getBounds` `getBoundsCenter` `getOriginalText` `getAllProperties` |
| 布尔判定 | `isEnabled` `isFocused` `isSelected` `isClickable` `isLongClickable` `isScrollable` `isCheckable` `isChecked` |
| 动作 | `click` `longClick` `doubleClick` `inputText` `clearText` `scrollToTop` `scrollToBottom` `scrollSearch` `dragTo` `pinchIn` `pinchOut` |

实测（`On.text("设置")` 找到的节点）：`getText` 返回文本、`getType` = `Text`、`getBounds` = `{left:412,top:1710,right:517,bottom:1756}`、`getBoundsCenter` = `{x:464,y:1733}`、`getId` 返回 UUID、`isClickable` = false。

### PointerMatrix —— 多指手势

```json
PointerMatrix.create(fingers, points)  →  "PointerMatrix#N"
PointerMatrix.setPoint(finger, pointIndex, Point)
Driver.injectMultiPointerAction(matrixRef)
```

实测：`create(2,2)` + 四次 `setPoint` + `inject` → 返回 `True`（双指 pinch 成功）。
注意 `create(1,3)` 后 `setPoint(1,0)` 报 `Number of illegal fingers` —— 第一个参数是**手指数**，`setPoint` 第一参不得超过它。

## 能力二：`Captures` 通道

| api | args | 实测 |
|---|---|---|
| `captureLayout` | `[{bundleName/windowId/mergeWindow/displayId}]` | ✅ 返回完整 UI 树 |
| `startCaptureScreen` | `{"options":{"scale":0.5}}` | ✅ 返回 `true`，随后 socket 上持续推 **JPEG** |
| `stopCaptureScreen` | `[]` | ✅ |

`captureLayout` 返回结构：`{attributes: {26 个属性}, children: [...]}`，实测整树 JSON 约 **185 KB**、32 个带文本节点。

`startCaptureScreen` 的 JPEG 流是**裸 JPEG 字节直接拼在同一个 socket 上**（`\xff\xd8`…`\xff\xd9`），前面先有一行 `{"result":true,...}\n`。实测：`scale:0.5` → 608×1344，连续滑动下 **约 14.9 fps / 6.7 MB per 7 s**。

## 能力三：`CtrlCmd` 通道

实测只有两个可用：

- `getDisplaySize` → `{width:1216, height:2688}`
- `getDisplayRotation` → `0`

其他名字一律 `Illegal api name:<name>`。

## 能力四：`Gestures` 通道

实测可用：`touchDown` / `touchMove` / `touchUp`，参数 `{"x":..,"y":..}`。这是**单点原子触摸**，可自己拼任意轨迹。

`axisDown` / `mouseDown` 等不存在。

## 截图的两个路径（重要）

`Driver.screenCap(fd)` / `Driver.screenCapture(fd, Rect?)` 的第一个参数是**文件描述符**，通过 IPC `MessageParcel::WriteFileDescriptor` 传递（见 `ipc_transactor.cpp`），不是路径、也不是普通整数。裸 TCP JSON 通道没有 SCM_RIGHTS，所以实测传本地 fd 只得到 `size: 0`。

**结论：agent.so 的「窗口级静态截图」在裸 socket 客户端上不可用。** 需要静态截图时走：

1. `uitest screenCap -p <path>`（CLI，落盘到设备）
2. `Captures.captureLayout`（要的是组件树不是图）
3. 从 `startCaptureScreen` 的 JPEG 流里取一帧

## 稳定性注意

实测中 daemon 崩过两次（`ConnectionResetError` / `ConnectionAbortedError`），触发点分别是 `callDeviceTestApi` 和连续调用组件动作。生产客户端需要实现**重连 + 重启 daemon**。

重启方式：`hdc shell kill -9 <pid>; hdc shell /system/bin/uitest start-daemon singleness`。
