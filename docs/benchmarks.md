# 实测对比：uitest-sdk 与 hdc CLI

> 由 `scripts/bench-compare.ts` 生成，请勿手改。生成时间：2026-11-15T08:42:14.949Z
> 设备：BRA-AL00 / 1216×2688。CLI 数字包含 hdc 进程启动、shell 往返、uitest 启动与设备侧工作。
> 绝对值随设备负载浮动：多轮之间 CLI 点击中位 390–561 ms、截图 632–890 ms；
> 本文件是其中一轮，官网取另一轮的代表值。

| 操作 | 本 SDK | hdc CLI | CLI / SDK |
|---|---|---|---|
| 点击 | 7–36 ms（中位 9 ms） | 390–515 ms（中位 404 ms） | 44.9× |
| 滑动（300 ms 手势 / 600 速度） | 423–499 ms（中位 458 ms） | 2702–2808 ms（中位 2792 ms） | 6.1× |
| 整屏截图（含回传） | 191–294 ms（中位 212 ms） | 799–988 ms（中位 813 ms） | 3.8× |

- SDK 截图：608×1344 JPEG，约 28 KB。
- `uitest screenCap` + `file recv`：1216×2688 PNG，约 644 KB。
- `snapshot_display` + `file recv`：632–697 ms（中位 684 ms），约 158 KB。

### 官方路径对比

| 能力 | 本 SDK | 官方路径 | 倍率 |
|---|---|---|---|
| 整屏截图 | agent MJPEG 中位 212 ms | `snapshot_display` + pull 中位 684 ms | 3.2× |
| UI 树 | `captureLayout` 中位 451 ms | `dumpLayout` + pull 中位 1163 ms | 2.6× |

单次动作两边走同一个 agent RPC，时延持平；截图与 UI 树的差别来自官方路径的
「起进程 / 写文件 / 回传」，不是 RPC 本身。

连续取帧没有 CLI 等价物：`screenCap` 轮询约 1.4 fps（每次约 700 ms），
而 H.264 投流实测 15–89 fps（见 `docs/03-libscreen-casting.md`）。

## 原始样本

- click: 36, 14, 12, 8, 9, 7, 10, 7, 9, 7 ms
- swipe: 423, 466, 458, 458, 499 ms
- layout: 239, 451, 433, 460, 468 ms
- dump: 1163, 1167, 1189, 1105, 1147 ms
- capture: 294, 220, 212, 207, 191 ms; bytes: 28265, 28265, 28265, 28265, 28265
- cli-click: 515, 438, 404, 403, 390, 405, 420, 399, 404, 390 ms
- cli-swipe: 2702, 2792, 2808, 2783, 2805 ms
- cli-capture: 988, 832, 813, 799, 800 ms; bytes: 659017, 659017, 659017, 659017, 659017
- snapshot: 632, 686, 684, 679, 697 ms; bytes: 161812, 161812, 161812, 161812, 161812
