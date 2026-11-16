# uitest 扩展能力逆向 —— 文档索引

本目录汇总 2026-11-14 对三个华为签名 uitest 扩展 `.so` 的逆向结果与真机实测结论。

设备基线：`<your-device-id>`（BRA-AL00，HarmonyOS 7.0.0.111，uitest **7.0.0.1**，arm64）。

| 文档 | 内容 |
|---|---|
| [api.md](api.md) | **SDK API 文档**：Device / AgentClient / 投流录制 / `dev.hypium` 118 个方法 / 错误码（官网版：[api.html](https://growvv.github.io/uitest-sdk/api.html)） |
| [01-extension-abi.md](01-extension-abi.md) | uitest 扩展 ABI、加载器行为、注入的低层函数 |
| [02-agent-so.md](02-agent-so.md) | `agent.so`（1.1.10）—— 完整 hypium API 面 + RPC 协议 |
| [03-libscreen-casting.md](03-libscreen-casting.md) | `libscreen_casting.z.so` —— gRPC H.264 推流 / 录屏 |
| [04-perfmonitor.md](04-perfmonitor.md) | `perfmonitor.so` —— HTTP 录屏服务 |
| [05-capability-matrix.md](05-capability-matrix.md) | 三者能力对照与缺口分析 |
| [06-signing-xpm.md](06-signing-xpm.md) | 为什么自建 .so 不可行（XPM 代码完整性校验） |
| [07-re-toolchain.md](07-re-toolchain.md) | 逆向方法与可复用工具链 |
| [08-missing-capabilities.md](08-missing-capabilities.md) | 未分析的 `.so`、`snapshot_display`、无线调试、无障碍/虚拟屏/AAMS 边界 |
| [09-capability-gaps-roadmap.md](09-capability-gaps-roadmap.md) | **7.0 包来源、自建 agent 的签名真相、能力差异与后续路线图** |
| [10-deveco-testing-analysis.md](10-deveco-testing-analysis.md) | **DevEco Testing 6.1.0.210 vs 26.0.1.100 对比、13 个 SO 清单、7.0 录屏实测** |
| [11-deveco-capability-inventory.md](11-deveco-capability-inventory.md) | **hypium 118 个公开方法的逐项对账与 SDK 支持规划（P0~P3）** |
| [12-findings-classified.md](12-findings-classified.md) | **本轮全部结论的分类汇总（版本/签名/投流/录屏/能力/性能/踩坑）** |
| [13-stage-log.md](13-stage-log.md) | **阶段记录：0.3.0 → 0.4.0 的交付、发布、架构实测与待办** |

## 一句话结论

- **`agent.so`** = 官方 hypium 全套 API 的设备侧执行器（点击/滑动/多指/键值/组件树/JPEG 推屏），TCP `127.0.0.1:8012`，行分隔 JSON。
- **`libscreen_casting.z.so`** = gRPC scrcpy server，Unix abstract socket，H.264 Annex-B 流，实测最高 ~89 fps。
- **`perfmonitor.so`** = cpp-httplib HTTP server on `0.0.0.0:9999`，4 个端点，H.264→MP4 落盘。
- 三者都**不需要自建 .so**；自建 .so 被内核 XPM 拒绝，见 06。**但模拟器上没有 XPM**，自建扩展可以在模拟器上跑（见 09）。
- **7.0 版 casting SO 走 WebSocket（TCP 5000）**，帧率与 6.8 的 gRPC 持平（同条件 28.8~65.3 fps），但握手快 3~7 倍、客户端零依赖、天然支持多实例端口隔离（见 09）。
- **DevEco Testing 不是 7.x**：外壳 `26.0.1.100` / python 框架 `6.1.0.210`，两条线同一套件；26.x 的 SO 最高只到 6.5，且**在 7.0 真机上录屏依然失效**（见 10）。
- **录屏要用 6.8 casting SO**：`-m 1` 在 7.0 真机稳定出 MP4（97 帧 / 19,804 B）；26.x 的 `unix_6.3.1/6.4/6.5` 全部因 Rosen 结构体 ABI 断裂而失败（见 10 §4）。
- **一切能力优先走 `agent.so` 的 TCP 长连接**：单次动作 5.2 ms、UI 树 473 ms、单张截图 178 ms，都比 `hdc shell` 调 CLI 快一个数量级（见 08）。`snapshot_display`（675 ms）只作兜底。

## 实测产物

`.work/verify/` 下保留了验证脚本与抓取数据：

- `stream_save.py` / `stream_only.py` —— 拉 H.264 流并落盘
- `rec_test.py` —— 触发 MP4 录制
- `drive_cast.py` —— 通用 gRPC 驱动
- `agent_frame2.jpg` —— agent.so 推屏抓到的单帧（608×1344）
- `stream_re5.h264` —— 10 s 推流样本（668 帧 / 109,675 B）
- `cast_rec.mp4` —— 159 s 录制样本（10,908 帧 / 1,966,629 B）
- `scrcpy.proto` / `scrcpy_pb2*.py` —— 复原的 proto 与生成的桩

## 实测基线环境

- 设备：`<your-device-id>` / BRA-AL00 / HarmonyOS 7.0.0.111 / arm64
- uitest：`7.0.0.1`（`/system/bin/uitest --version`）
- `agent.so`：`UITEST_AGENT_LIBRARY@v1.1.10`
- `libscreen_casting.z.so`：`6.8-20260801`
- 屏幕：1216×2688，density 520
- hdc：`D:\Application\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`

## 测试后清理

```sh
hdc shell "ps -ef | grep -E 'libscreen|perfmonitor' | grep -v grep"   # 找 pid
hdc shell "kill -9 <pid>"
hdc fport ls
hdc fport rm tcp:<local> localabstract:<name>
```
