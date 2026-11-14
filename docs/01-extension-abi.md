# 01 · uitest 扩展 ABI

来源：`E:\CodeE\FuckHdc\testfwk_arkxtest\uitest\addon\`（官方 OpenHarmony 源码）。

## 加载流程

```
uitest start-daemon singleness [--extension-name <file>] [<ext args...>]
        │
        ├─ server_main.cpp:StartDaemon()
        │    ├─ daemon(0,0)                      ← 进程脱离终端
        │    ├─ UiDriver::RegisterController(SysUiController)
        │    └─ token == "singleness" → ExecuteExtension(VERSION, argc, argv)
        │
        └─ extension_executor.cpp:ExecuteExtension()
             ├─ name = argv[1] if argv[0]=="--extension-name" else "agent.so"
             ├─ path = "/data/local/tmp/" + name
             ├─ OHOS::FileExists(path)            ← 不存在直接 false
             ├─ dlopen(path, RTLD_LAZY)           ← XPM 校验在这一步
             ├─ dlsym("UiTestExtension_OnInit")
             ├─ dlsym("UiTestExtension_OnRun")
             ├─ initFunction(port, argc-used, argv+used)
             ├─ ret = runFunction()
             └─ dlclose(handle)                   ← 注意：返回后立刻 dlclose
```

**关键点**：`OnRun` 返回后 `dlclose` 会卸载 .so。所以长期运行的扩展（三个都是）必须把主循环放在 **`OnInit` 里阻塞**，`OnRun` 留空。这正是 `libscreen_casting.z.so` 的做法（`OnRun` 只有 `mov w0, wzr; ret`，8 字节）。

`agent.so` 是反例：`OnRun` 里 `RpcServer::StartService(...)` 阻塞，因此 `dlclose` 实际上永远执行不到。

## 注入的接口

`UiTestPort`（每次初始化都注入）：

| 函数 | 作用 |
|---|---|
| `getUiTestVersion(ReceiveBuffer)` | 取 uitest 版本字符串 |
| `printLog(level, tag, fmt, va_list)` | 写 HiLog |
| `getAndClearLastError(int32_t*, ReceiveBuffer)` | 取上次错误 |
| `initLowLevelFunctions(LowLevelFunctions*)` | 取下面 6 个低层函数 |

`LowLevelFunctions`（`initLowLevelFunctions` 填充）：

| 函数 | 签名 | 作用 |
|---|---|---|
| `callThroughMessage` | `(Text in, ReceiveBuffer out, bool* fatal)` | **转发 JSON 到 FrontendApiServer::Call** —— 即官方 hypium 全套 API 在扩展里可直接用 |
| `setCallbackMessageHandler` | `(DataCallback)` | 接收设备侧主动回调 |
| `atomicTouch` | `(int32 stage, int32 px, int32 py)` | 单点原子触摸（DOWN/MOVE/UP） |
| `startCapture` | `(Text name, DataCallback, Text optJson)` | 启动采集，`name` ∈ `dumpLayout` / `copyScreen` / `recordUiAction` |
| `stopCapture` | `(Text name)` | 停止采集 |
| `atomicMouseAction` | `(stage, px, py, btn)` | 鼠标原子动作 |

`callThroughMessage` 的请求格式（`extension_executor.cpp:CallThroughMessage`）：

```json
{"api": "Driver.create", "this": null, "args": [], "message_type": "hypium"}
```

响应：`{"result": <value>}` 或 `{"exception": {"code": <int>, "message": "<str>"}}`。
`fatalError` 仅在 `INTERNAL_ERROR` / `ERR_INTERNAL` 时置位。

`startCapture` 的三个内建采集器：

- `dumpLayout` —— 同步一次性，`optJson` 支持 `bundleName` / `windowId` / `mergeWindow` / `displayId`
- `copyScreen` —— 异步流，`optJson` 支持 `scale`(float) / `displayId`；回调给的是 **JPEG 字节**
- `recordUiAction` —— 异步流，回调给 UI 事件 JSON

## 错误码

`frontend_api_defines.h`：

| 码 | 含义 |
|---|---|
| 0 | NO_ERROR |
| 1 | INTERNAL_ERROR |
| 2 | WIDGET_LOST |
| 3 | WINDOW_LOST |
| 4 | ASSERTION_FAILURE |
| 5 | USAGE_ERROR |
| 401 | ERR_INVALID_INPUT |
| 801 | ERR_NO_SYSTEM_CAPABILITY |
| 17000001 | ERR_INITIALIZE_FAILED |
| 17000002 | ERR_API_USAGE（并发调用） |
| 17000003 | ERR_ASSERTION_FAILED |
| 17000004 | ERR_COMPONENT_LOST |
| 17000005 | ERR_OPERATION_UNSUPPORTED |
| 17000006 | ERR_INTERNAL |
| 17000007 | ERR_INVALID_PARAM |
