# 12 · 结论分类汇总（2026-11-15）

本轮调研的全部发现，按**性质**分类归档。每条都标注了出处文档和证据强度。

---

## A. 版本与来源（事实类，已定论）

| # | 结论 | 证据 | 详见 |
|---|---|---|---|
| A1 | DevEco Testing 有**两条版本线**：外壳 `26.0.1.100`（PE ProductVersion）+ python 框架 `6.1.0.210`（dist-info）。两者是同一个安装，不是两个产品 | 安装包 8670 个文件 CRC 与已安装目录 **100% 一致** | [10](10-deveco-testing-analysis.md) §1 |
| A2 | **它不是 uitest 7.x**。uitest 版本是设备侧 `/system/bin/uitest`（真机 7.0.0.1），PC 工具版本号不同源 | 三套版本号互不相等 | [10](10-deveco-testing-analysis.md) §1 |
| A3 | 26.0.1.100 相比 6.1.0.210 的**唯一增量**是 Java 侧 jar 里的 8 个 SO（含 `unix_6.3.1/6.4/6.5`）。python 侧 9 个 SO **逐字节相同** | md5 全等 | [10](10-deveco-testing-analysis.md) §2 |
| A4 | **26.x 也没有 7.0 WebSocket SO**。全仓库最高 6.5 | `entrylist.txt` 无 `unix_7` | [10](10-deveco-testing-analysis.md) §2.3 |
| A5 | 三个公开渠道（HOScrcpy jar / DevEco Testing / pip devicetest）都**没有 7.0** | 逐个解包核查 | [09](09-capability-gaps-roadmap.md) §1.1 |
| A6 | 7.0 WebSocket SO 的**唯一公开来源**是 `OldBeer1/hscrcpy` 仓库 `server/`，commit `a3da359d`（2026-10-22），作者 `pengxiaochuan1@huawei.com`（华为员工），提交说明写「HOScrcpy 2.13-aligned」 | git log + 邮箱核查 | [09](09-capability-gaps-roadmap.md) §1.6 |
| A7 | 7.0 SO **是华为官方签名**：证书链 `DevEcoTesting Release ← Huawei CBG Software Signing Service CA ← Huawei CBG Root CA G2`，与 6.5/6.8 **完全一致**。不是伪造/重打包（签名覆盖全文件） | 证书体比对 | [09](09-capability-gaps-roadmap.md) §1.6 |
| A8 | 6.8/6.9 的来源在 commit `c9b13cd` 里明确写了：「add HOScrcpy 2.12.9 server SO 6.8/6.9-20260801」 | git log | [09](09-capability-gaps-roadmap.md) §1.6 |

---

## B. 签名与自建扩展（事实类，已定论）

| # | 结论 | 证据 | 详见 |
|---|---|---|---|
| B1 | 真机 XPM 校验**拒绝未签名 `.so` 和未签名独立 ELF**（`errno 13` / `exit=126`） | 7 组对照实验 | [06](06-signing-xpm.md) |
| B2 | 签名覆盖**整个文件内容** —— 改 `.text`、`.rodata`、甚至证书区任一字节都失效；移植签名块无效 | 逐字节实验 | [06](06-signing-xpm.md) |
| B3 | 签名块是 32 字节尾部：`"elf sign block  "`(16) + `"1000"`(4) + LE 证书长度(4) + 版本(4) + 保留(4) | 二进制结构分析 | [06](06-signing-xpm.md) |
| B4 | **模拟器没有 XPM 校验** —— 自建 x86_64 `.so` 扩展可正常加载执行 | 实测 `probe_signed.so` | [06](06-signing-xpm.md) §模拟器 |
| B5 | 竞品也没解决签名：HarmonyMirror 的 `deployAndStartAgent()` 静默 `return false`，退化成 hdc uinput；其签名代码只签 HAP | 源码核查 | [09](09-capability-gaps-roadmap.md) §2 |

---

## C. 投流（性能类，已实测）

| # | 结论 | 数据 | 详见 |
|---|---|---|---|
| C1 | 6.8 SO 走 **gRPC over Unix abstract socket `@scrcpy_grpc_socket`**，最高 ~89 fps | 实测 | [03](03-libscreen-casting.md) |
| C2 | 7.0 SO 走 **RFC6455 WebSocket over TCP 5000**（lws 实现，gRPC 字符串 0 次） | 符号统计 | [09](09-capability-gaps-roadmap.md) §1.4 |
| C3 | **帧率瓶颈在编码器，不在传输层**：`-frameRate 30` → 6.8 是 30.1 fps / 7.0 是 28.8；`-frameRate 60` → 65.3 / 64.2 | 同条件对照 | [09](09-capability-gaps-roadmap.md) §1.4 |
| C4 | 7.0 的真实优势是**客户端零依赖**（无需 gRPC/protobuf 运行时）、`-p` 端口隔离天然多实例、握手快 3~7 倍 | 实测 | [09](09-capability-gaps-roadmap.md) §1.4 |
| C5 | 早期记录的「7.0 = 44.3 fps」是**错的** —— 短窗口摊薄首帧导致。已全面更正 | — | [09](09-capability-gaps-roadmap.md) §1.4 |
| C6 | **7.0 与 6.8 能力完全对等**：都能投流、都能 `-m 1` 录制。选型只看客户端实现成本 | 双版本全量实测 | [09](09-capability-gaps-roadmap.md) §1.5 |
| C7 | 7.0 的 `stopped.frameCount` **上报有 bug**（录了 1,318 帧却报 1），不能用它判断录制成败 | 解析 MP4 `stsz.sample_count` | [09](09-capability-gaps-roadmap.md) §1.4 |
| C8 | 这台 7.0.0.1 ROM 上**只有 6.8 和 7.0 可用**；6.9 因 protobuf 符号不匹配加载失败，6.3.1~6.5 因虚拟屏 ABI 断裂不可用 | 12 个版本全量实测 | [09](09-capability-gaps-roadmap.md) §1.5 |

---

## D. 录屏（本轮新增，已实测）

| # | 结论 | 证据 | 详见 |
|---|---|---|---|
| D1 | **26.x 的 unix 录屏 SO 在 7.0 真机上全部失效**（6.3.1 / 6.4 / 6.5 全失败） | 逐个实测 | [10](10-deveco-testing-analysis.md) §4.1 |
| D2 | 失败机理是 **Rosen `VirtualScreenOption` 结构体 ABI 断裂**：`height` 恒为 `1919120140` = `0x72636F6C` = ASCII `"rcol"` | hilog 日志 | [10](10-deveco-testing-analysis.md) §4.2 |
| D3 | **6.8 casting SO 能录**（同一台 7.0 真机）：`-m 1` → `onEnd` 返回 frame_count → MP4 落盘可播放 | 97 帧 / 19,804 B / 含 ftyp+mdat+moov | [10](10-deveco-testing-analysis.md) §4.3 |
| D4 | 差异根因：6.8 用 `Screen::GetWidth/GetHeight` 读尺寸，**不依赖** `librender_service_base.z.so`；6.5 依赖它 | `readelf -d` 对比 | [10](10-deveco-testing-analysis.md) §4.2 |
| D5 | 文件名、端口、`-encodeType` **都不是变量**。A~H 八组隔离实验证明唯一变量是 SO 内容 | 8 组对照 | [10](10-deveco-testing-analysis.md) §4.3 |
| D6 | DevEco Testing 自己的 python 录制路径在 7.0 上坏，因为 `res/recorder/` 里没有带 `unix` 的 SO，而 `use_unix_socket=True` 只挑 unix 变体 | 源码 `record_agent.py:172` | [10](10-deveco-testing-analysis.md) §4.4 |
| D7 | **7.0 的 `-m 1` 录制比 6.8 更完整**：11.64 s 连续出 1,318 帧（muxer 持续写），6.8 是脏区驱动（静止 0 帧） | 解析 MP4 + OpenCV | [09](09-capability-gaps-roadmap.md) §1.4 |

---

## E. 能力面（规划类）

| # | 结论 | 详见 |
|---|---|---|
| E1 | hypium `OHOSDriver` + `CompatibleInterfaceMixIn` 共 **118 个公开方法**（AST 精确统计），这是官方 API 的完整上界 | [11](11-deveco-capability-inventory.md) |
| E2 | 当前 SDK 覆盖 **21 个 ✅ / 7 个 ⏳ / 90 个 ❌** | [11](11-deveco-capability-inventory.md) §1 |
| E3 | **无硬件门槛的约 95 个方法**应全部支持；有硬件门槛的 23 个（鼠标/手写笔/表冠/触控板）API 完整但无硬件时明确报错 | [11](11-deveco-capability-inventory.md) §3 |
| E4 | 所有方法最终都走 **agent.so RPC**，和我们的 SDK 是同一个设备侧执行器 | [02](02-agent-so.md) |
| E5 | 26.x 的 Java 侧 `hosScrcpy` API 只覆盖投流/录制/触摸/鼠标/输入/旋转，**没有** pen / toast / ui_event / pinch / 图像识别 | [10](10-deveco-testing-analysis.md) §5.4 |

---

## F. 性能对比（我们 vs 官方）

| 能力 | DevEco Testing | 我们 | 倍数 |
|---|---|---|---|
| 单张截图 | `snapshot_display` 675 ms | agent MJPEG 起停 **178 ms** | **3.8× 快** |
| UI 树 | `dumpLayout` + pull | `captureLayout` 473 ms | **2× 快** |
| 单次点击 | agent RPC 113 ms | `Gestures` **7.7 ms** | **15× 快** |
| 滑动 | agent `Driver.swipe` | `Gestures` 三段式 **48 ms** | 真机持平；模拟器快 1000× |
| 文本输入 | agent `Driver.inputText` | 同 | 持平（730~1540 ms） |
| 录屏 | ❌ 7.0 上坏 | ✅ 6.8 `-m 1` | **只有我们能跑** |
| 投流 | gRPC 6.5 | gRPC 6.8（~89 fps）/ WebSocket 7.0 | 我们更新 |

---

## G. 踩坑记录（工具类）

| # | 坑 | 教训 |
|---|---|---|
| G1 | `hdc file send <相对路径带目录> /data/local/tmp/x.so` 会在设备上创建**同名目录**，导致 dlopen 静默失败 | 先 `cd` 到源目录，只用裸文件名 |
| G2 | 诊断特征：`md5sum` 返回 `d41d8cd98f00b204e9800998ecf8427e`（空文件/目录） | 每次推送后校验 md5 |
| G3 | 设备上 `/tmp` 只读 | 重定向到 `/data/local/tmp` |
| G4 | 设备无 `awk` / `strings` / `getprop` | 用 `cut` / 本地 python |
| G5 | `pkill -f` 权限不足 | 先 `ps` 找 pid 再 `kill -9` |
| G6 | `hdc file recv` 用绝对 Windows 路径会拼接到 CWD | 先 `cd` 到目标目录用相对路径 |
| G7 | 自解压 PE 的 zip 不能直接 `zipfile` 打开 | 需从 EOCD 反算 base offset（见 `x26.py`） |

---

## H. 待办（未完成）

| # | 事项 | 阻塞原因 |
|---|---|---|
| H1 | 验证 `libscrcpy_server_emulator.z.so`（2,926,240 B，未签名，aarch64）在模拟器上能否跑 | 未测 |
| H2 | 确认 26.x 的 Java 录制路径是否也坏（需要跑 GUI 录制） | 需 GUI 交互 |
| H3 | `aa` / `bm` 命令在 7.0 真机上的可用性（应用管理能力依赖它） | 未测 |
| H4 | 鼠标 / 手写笔 / 表冠 / 触控板能力的设备验证 | 缺硬件 |
| H5 | 7.0 WebSocket SO 是否也支持 `-m 1` 录制 | 已初步验证（见 09 §1.4） |

---

## 文档地图

| 文档 | 定位 |
|---|---|
| [01](01-extension-abi.md) | uitest 扩展 ABI 与加载器行为 |
| [02](02-agent-so.md) | agent.so 的完整 RPC 方法表 |
| [03](03-libscreen-casting.md) | 6.8 gRPC 投流协议 |
| [04](04-perfmonitor.md) | perfmonitor.so HTTP 服务 |
| [05](05-capability-matrix.md) | 三个 SO 的能力对照 |
| [06](06-signing-xpm.md) | XPM 校验与签名机制 |
| [07](07-re-toolchain.md) | 逆向工具链 |
| [08](08-missing-capabilities.md) | 未覆盖的边界能力 |
| [09](09-capability-gaps-roadmap.md) | 7.0 包来源、能力差异、路线图 |
| [10](10-deveco-testing-analysis.md) | **DevEco Testing 两版本对比、SO 清单、录屏实测** |
| [11](11-deveco-capability-inventory.md) | **118 个 hypium 方法与 SDK 支持规划** |
| [12](12-findings-classified.md) | 本文 —— 结论分类汇总 |
