# 11 · DevEco Testing 全能力清单与 SDK 支持规划

本文是「**支持 DevEco Testing 全部功能**」这个目标的对账表。

能力来源：`hypium 6.1.0.210` 的 `OHOSDriver` + `CompatibleInterfaceMixIn`，**118 个公开方法**（AST 精确统计，非人工摘录）。这是官方 UI 自动化 API 的完整上界 —— 所有方法最终都通过 agent.so 的 RPC 下发到设备。

> 为什么以 `hypium` 为准而不是 DevEco Testing 的 GUI：GUI 是这套 API 的消费者，能力不会超出它。而且 GUI 里的「用例录制器」只是把这些调用编排成脚本。

> **状态（2026-11-16）**：本文的规划已全部落地，`dev.hypium` 是 118 个方法的门面。真机逐条实测结果：
> 106 `verified` / 4 `device` / 3 `hardware` / 5 `unsupported`（Toast 与 UI 事件，设备侧不回包）。
> 权威表格是 `src/hypium/catalog.ts` 的 `HYPIIUM_CATALOG`，下面是当初的规划，保留作决策记录。
> 逐条说明见 [api.md](api.md) 第 8 节和官网 [api.html](https://growvv.github.io/uitest-sdk/api.html)。

---

## 一、总体进度

| 分类 | 方法数 | ✅ 已覆盖 | ⏳ 部分覆盖 | ❌ 未覆盖 |
|---|---|---|---|---|
| 1. 显示 / 电源 / 锁屏 | 8 | 3 | 1 | 4 |
| 2. 点击 / 长按 | 3 | 3 | 0 | 0 |
| 3. 滑动 / 拖拽 | 6 | 2 | 1 | 3 |
| 4. 多指手势 | 5 | 0 | 1 | 4 |
| 5. 鼠标 | 7 | 0 | 0 | 7 |
| 6. 手写笔 | 7 | 0 | 0 | 7 |
| 7. 键盘 / 文本 | 6 | 2 | 0 | 4 |
| 8. 系统键 | 7 | 3 | 0 | 4 |
| 9. 组件查找 / 属性 | 9 | 3 | 2 | 4 |
| 10. 窗口 | 7 | 0 | 0 | 7 |
| 11. 屏幕 / 截图 | 5 | 2 | 1 | 2 |
| 12. 图像识别 | 4 | 0 | 0 | 4 |
| 13. Toast / UI 事件 | 5 | 0 | 1 | 4 |
| 14. 应用管理 | 6 | 0 | 0 | 6 |
| 15. 文件 | 3 | 0 | 0 | 3 |
| 16. 等待 / 同步 | 4 | 1 | 0 | 3 |
| 17. 输入法 / 光标 | 2 | 1 | 0 | 1 |
| 18. 特殊硬件 | 3 | 0 | 0 | 3 |
| 19. 设备信息 / 钩子 | 10 | 1 | 0 | 9 |
| **合计** | **118** | **21** | **7** | **90** |

---

## 二、逐项对账

图例：✅ 已实现（有实测） / ⏳ agent 有能力但未封装 / ❌ 未做

### 1. 显示 / 电源 / 锁屏（8）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `is_display_on()` | ⏳ | agent `Driver.isScreenOn` |
| `wake_up_display()` | ✅ | `Driver.triggerKey(26)`，已实测 |
| `is_display_locked()` | ❌ | `Driver.isLocked`，未测 |
| `unlock()` | ❌ | 需滑动 + PIN，未测 |
| `set_sleep_time(t)` / `restore_sleep_time()` | ❌ | `hdc shell power-shell setmode` |
| `close_display()` | ❌ | 需电源键 |
| `set_display_rotation_enabled(enabled)` | ❌ | `DisplayManager` 锁旋转 |

### 2. 点击 / 长按（3）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `click(target, offset)` | ✅ | `Gestures` down+up，7.7 ms（比 `Driver.click` 快 15 倍） |
| `double_click(target, offset)` | ✅ | 两次 down+up，间隔 <100 ms |
| `long_click(target, press_time, offset)` | ✅ | down + 等待 + up |

### 3. 滑动 / 拖拽（6）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `swipe(direction, distance, area, side, ...)` | ✅ | `Gestures` down + N×move + up，48 ms（**不能用 `Driver.swipe`**，模拟器 6.2~12.6 s） |
| `drag(start, end, area, press_time, drag_time, speed)` | ⏳ | 同上但带长按起始 |
| `slide(start, end, area, slide_time)` | ⏳ | 同上但线性插值 |
| `fling(direction, distance, area, speed)` | ❌ | 带初速度的滑动，需 `PointerMatrix` |
| `swipe_to_home(times)` | ❌ | 上滑手势 |
| `swipe_to_back(side, times, height)` | ❌ | 边缘侧滑 |
| `swipe_to_recent_task()` | ❌ | 上滑停住 |

### 4. 多指手势（5）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `pinch_in(area, scale, direction)` | ❌ | `PointerMatrix` 双指收 |
| `pinch_out(area, scale, direction)` | ❌ | `PointerMatrix` 双指放 |
| `two_finger_swipe(...)` | ❌ | 双指同向滑 |
| `multi_finger_touch(points, duration, area)` | ⏳ | agent `Gestures` 支持多指，未封装 |
| `inject_multi_finger_gesture(gestures, speed)` | ⏳ | agent `Gestures.injectMultiFingerGesture` |
| `inject_gesture(gesture, speed)` | ⏳ | agent `Gestures.injectGesture` |

### 5. 鼠标（7）—— 全部未做

| 方法 | 说明 |
|---|---|
| `mouse_click(pos, button_id, key1, key2)` | 支持左/中/右键 + 修饰键 |
| `mouse_double_click(pos, button_id)` | |
| `mouse_long_click(pos, button_id, press_time)` | |
| `mouse_scroll(pos, scroll_direction, scroll_steps, key1, key2)` | |
| `mouse_move_to(pos)` | |
| `mouse_move(start, end, speed)` | |
| `mouse_drag(start, end, speed)` | |

> agent.so 有 `Mouse` 相关 RPC（见 [02](02-agent-so.md)），但**从未实测**。鸿蒙真机接鼠标后这套才生效。

### 6. 手写笔（7）—— 全部未做

| 方法 | 说明 |
|---|---|
| `pen_click(target, offset)` | |
| `pen_double_click(target, offset)` | |
| `pen_long_click(target, offset, pressure)` | 带压感 |
| `pen_swipe(direction, distance, start_point, area, pressure, duration, speed)` | |
| `pen_slide(start, end, area, pressure, duration, speed)` | |
| `pen_drag(start, end, area, pressure, press_time, duration, speed)` | |
| `pen_inject_gesture(gesture, pressure, speed)` | |

> 需要 M-Pencil 硬件。**没有笔的设备上无法验证**，这是硬约束。

### 7. 键盘 / 文本（6）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `input_text(component, text, mode)` | ✅ | `Driver.inputText`，中英文均支持，730~1540 ms |
| `press_key(key_code, key_code2, mode)` | ✅ | `Driver.triggerKey` |
| `press_combination_key(key1, key2, key3)` | ❌ | 组合键，需同时 down 两个 keycode |
| `clear_text(component)` | ❌ | 全选 + 删除 |
| `move_cursor(direction, times)` | ❌ | 方向键序列 |
| `input_text_on_current_cursor(text)` | ❌ | 无需定位控件直接输入 |

### 8. 系统键（7）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `press_home()` / `go_home()` | ✅ | `triggerKey(1)` |
| `press_back()` / `go_back()` | ✅ | `triggerKey(2)` |
| `press_power()` | ✅ | `triggerKey(26)` |
| `hdc(cmd, timeout)` | ✅ | `HdcRunner.shell` |
| `shell(cmd, timeout)` | ✅ | `HdcRunner.shell` |

### 9. 组件查找 / 属性（9）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `find_component(target, scroll_target)` | ✅ | `captureLayout` + 本地匹配（473 ms） |
| `find_all_components(target, index)` | ✅ | 同上 |
| `get_component_property(component, property_name)` | ✅ | 布局节点字段 |
| `get_component_bound(component)` | ⏳ | 同上 |
| `get_component_pos(comp)` | ⏳ | 同上 |
| `wait_for_component(by, timeout)` | ❌ | 轮询 find_component |
| `wait_for_component_disappear(by, timeout)` | ❌ | 轮询 |
| `switch_component_status(component, checked)` | ❌ | 开关组件 |
| `check_component(component, expect_equal, wait_time)` | ❌ | 断言 |

### 10. 窗口（7）—— 全部未做

| 方法 | 说明 |
|---|---|
| `find_window(filter)` | 按 bundle/title 找窗口 |
| `get_current_window()` | |
| `get_window_size()` | |
| `check_window(window, title, bundle_name)` | 断言 |
| `check_current_window(title, bundle_name)` | |
| `check_window_exist(window, expect_exist)` | |

> agent.so 有 `UiWindow`（focus/move/resize/split/close），**能力存在但未封装**。

### 11. 屏幕 / 截图（5）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `get_display_size()` | ✅ | agent `Driver.getDisplaySize` |
| `capture_screen(save_path, in_pc, area)` | ✅ | agent MJPEG 起停，178 ms（**比官方 `snapshot_display` 快 3.8 倍**） |
| `get_display_rotation()` | ⏳ | agent 有 |
| `set_display_rotation(rotation)` | ❌ | |
| `take_screenshot(mode="key")` | ❌ | 模拟音量下+电源键 |

### 12. 图像识别（4）—— 全部未做

| 方法 | 说明 |
|---|---|
| `find_image(image_path_pc, mode="sift")` | SIFT / 模板匹配 |
| `touch_image(image_path_pc, mode, similarity, wait_time)` | 找到并点击 |
| `check_image_exist(image_path_pc, expect_exist, similarity, timeout, mode)` | 断言 |
| `check_image_exist` 的 pHash 模式 | 感知哈希 |

> **这是纯 PC 侧能力**：截图（已有）+ OpenCV 匹配。`devicetest/utils/img_util.py` 和 `controllers/cv/_cv.py` 是参考实现。我们不需要设备侧支持，只需要引入一个图像匹配库。

### 13. Toast / UI 事件（5）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `start_listen_toast()` | ❌ | agent `Driver.createUIEventObserver`（类型 toast） |
| `get_latest_toast(timeout)` | ❌ | 订阅流 |
| `check_toast(expect_text, fuzzy, timeout)` | ❌ | 断言 |
| `start_listen_ui_event(event_type)` | ⏳ | agent 有 `UIEventObserver`，未封装 |
| `get_latest_ui_event(timeout)` | ⏳ | 同上 |

### 14. 应用管理（6）—— 全部未做

| 方法 | 实现路径 |
|---|---|
| `start_app(package_name, page_name, params, wait_time)` | `aa start -b <bundle> -a <ability>` |
| `stop_app(package_name, wait_time)` | `aa force-stop` |
| `has_app(package_name)` | `bm dump -n` |
| `current_app()` | `aa dump -l` 或 `dumpLayout` 顶层 bundle |
| `install_app(package_path, options)` | `bm install -p` |
| `uninstall_app(package_name)` | `bm uninstall -n` |
| `clear_app_data(package_name)` | `bm clean -n` |

> 全部走 `hdc shell`。但注意：`aa` / `bm` 在 7.0 上的可用性需要实测。

### 15. 文件（3）—— 全部未做

| 方法 | 实现路径 |
|---|---|
| `pull_file(device_path, local_path, timeout)` | `hdc file recv` |
| `push_file(local_path, device_path, timeout)` | `hdc file send` |
| `has_file(file_path)` | `hdc shell ls` |

> `HdcRunner` 已有 `push`/`pull`，只需暴露。

### 16. 等待 / 同步（4）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `wait_for_idle(idle_time, timeout)` | ❌ | 轮询 `captureLayout` 的 hash 是否稳定 |
| `wait(wait_time)` | ✅ | `setTimeout` |
| `set_implicit_wait_time(t)` / `get_implicit_wait_time()` | ❌ | 全局隐式等待配置 |

### 17. 输入法 / 光标（2）

| 方法 | 状态 |
|---|---|
| `input_text_on_current_cursor(text)` | ❌ |
| `move_cursor(direction, times)` | ❌ |

### 18. 特殊硬件（3）—— 全部未做

| 方法 | 说明 |
|---|---|
| `rotate_crown(steps, speed)` | 手表表冠旋转 |
| `touchpad_swipe(direction, fingers, speed)` | 触控板滑动 |
| `touchpad_swipe_and_hold(direction, fingers, speed)` | 触控板滑动+按住 |

> 需要手表 / 笔记本硬件。

### 19. 设备信息 / 钩子（10）

| 方法 | 状态 | 实现路径 |
|---|---|---|
| `sn()` / `device_type()` / `os_type()` | ✅ | `hdc list targets` / `uitest --version` |
| `get_device_type()` / `get_os_type()` | ⏳ | 同上 |
| `add_hook(hook_type, hook_id, callback)` | ❌ | 事件钩子 |
| `remove_hook(hook_type, hook_id)` | ❌ | |
| `remove_all_hooks(hook_type)` | ❌ | |
| `log()` | ❌ | |
| `close()` | ❌ | 资源清理（我们有 `dispose()`） |
| `set_sleep_time` / `restore_sleep_time` | ❌ | 见分类 1 |

---

## 三、实施优先级

按「价值 × 可行性」排：

### P0 —— 立刻做（无硬件依赖、纯封装、价值高）

| 能力 | 工作量 | 理由 |
|---|---|---|
| **应用管理 6 个方法** | 小 | 走 `hdc shell`，验收测试必需 |
| **文件 3 个方法** | 极小 | `HdcRunner` 已实现，只是暴露 |
| **窗口 6 个方法** | 中 | agent `UiWindow` 能力已有 |
| **`wait_for_component` / `disappear`** | 小 | 轮询 `captureLayout` |
| **Toast 监听 3 个方法** | 中 | agent `UIEventObserver` 已实测可用 |
| **`press_combination_key`** | 小 | 双 keycode down |

### P1 —— 值得做（需要设备支持或额外验证）

| 能力 | 工作量 | 说明 |
|---|---|---|
| **多指手势 5 个** | 中 | `PointerMatrix`，需实测 |
| **`fling` / `swipe_to_home` / `back` / `recent`** | 小 | 滑动变体 |
| **`set_display_rotation` / `take_screenshot`** | 小 | |
| **`wait_for_idle`** | 小 | 布局 hash 稳定检测 |

### P2 —— 有硬件门槛（做出来也只能在特定设备验证）

| 能力 | 门槛 |
|---|---|
| **鼠标 7 个** | 需接鼠标 |
| **手写笔 7 个** | 需 M-Pencil |
| **`rotate_crown` / `touchpad_*`** | 需手表 / 笔记本 |

> 建议：**实现但不承诺验收**。API 存在、参数正确、能在有硬件的设备上跑；没有硬件的设备上调用会明确报错（而不是静默失败）。

### P3 —— 纯 PC 侧，可选

| 能力 | 说明 |
|---|---|
| **图像识别 4 个** | 引入 OpenCV 绑定（`opencv4nodejs` / `sharp` + 模板匹配）。SIFT 需要完整 OpenCV |
| **`check_*` 断言族** | 这些是测试框架语义，不是设备能力。SDK 提供原语，断言交给调用方或单独包 |

---

## 四、不在范围内的

| 能力 | 为什么不做 |
|---|---|
| **测试报告生成**（HTML + 截图/视频） | 调用方职责；我们只提供原语 |
| **用例录制→回放**（`RecordAction`） | 属于 IDE 功能，不是设备能力 |
| **弹窗自动处理规则引擎** | 业务逻辑，应由调用方实现 |
| **`CKit` 的 20 个 Kit** | 是 xdevice 的测试编排抽象，不是设备 API |
| **`SmartPerfKit` 性能采集** | 有独立实现路径（`perfmonitor.so` HTTP 9999），不混进 UI SDK |

---

## 五、验收标准

「支持 DevEco Testing 全部功能」的判定：

1. **118 个方法中，所有无硬件门槛的（约 95 个）在真机上跑通并记录耗时**
2. **有硬件门槛的（23 个）API 完整、参数正确、无硬件时明确报错**
3. **每个方法都有对应的 SDK 顶层 API**（不需要调用方写 `hypium('api', ...)` 原始调用）
4. **能力差异表**（本文）更新到 ✅ 全覆盖或明确标注不做

---

## 六、参考

| 文件 | 内容 |
|---|---|
| `D:\Application\DevEco Testing\python\Lib\site-packages\hypium\uidriver\ohos\uidriver.py` | 118 个方法的完整定义（112 KB） |
| `.../hypium/uidriver/ohos/app_manager.py` | 应用管理实现 |
| `.../hypium/uidriver/ohos/system_info.py` | 系统信息 |
| `.../devicetest/utils/img_util.py` | 图像比对参考实现 |
| `.../devicetest/controllers/cv/_cv.py` | OpenCV 封装 |
| `docs/02-agent-so.md` | agent.so 的 RPC 方法全表 |
| `docs/05-capability-matrix.md` | 三个 SO 的能力对照 |

提取方法（可复现）：

```sh
cd "/d/Application/DevEco Testing/python/Lib/site-packages/hypium/uidriver/ohos"
python -I -c "
import ast
t=ast.parse(open('uidriver.py',encoding='utf-8').read())
for c in t.body:
    if isinstance(c,ast.ClassDef):
        ms=[m.name for m in c.body if isinstance(m,ast.FunctionDef) and not m.name.startswith('_')]
        print(c.name, len(ms)); print('\n'.join('  '+m for m in ms))
"
```
