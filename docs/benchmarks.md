# 实测对比：uitest-sdk 与 hdc CLI

> 由 `scripts/bench-compare.ts` 生成，请勿手改。生成时间：2026-11-15T07:47:53.512Z
> 设备：BRA-AL00 / 1216×2688。CLI 数字包含 hdc 进程启动、shell 往返、uitest 启动与设备侧工作。

| 操作 | 本 SDK | hdc CLI | CLI / SDK |
|---|---|---|---|
| 点击 | 8–30 ms（中位 9 ms） | 497–561 ms（中位 531 ms） | 59.0× |
| 滑动（300 ms 手势 / 600 速度） | 389–395 ms（中位 391 ms） | 2630–2787 ms（中位 2695 ms） | 6.9× |
| 整屏截图（含回传） | 109–222 ms（中位 184 ms） | 741–890 ms（中位 828 ms） | 4.5× |

- SDK 截图：608×1344 JPEG，约 124 KB。
- `uitest screenCap` + `file recv`：1216×2688 PNG，约 701 KB。
- `snapshot_display` + `file recv`：592–694 ms（中位 651 ms），约 194 KB。

连续取帧没有 CLI 等价物：`screenCap` 轮询约 1.4 fps（每次约 700 ms），
而 H.264 投流实测 15–89 fps（见 `docs/03-libscreen-casting.md`）。

## 原始样本

- click: 30, 15, 8, 8, 9, 8, 8, 9, 11, 8 ms
- swipe: 390, 395, 393, 391, 389 ms
- capture: 109, 141, 184, 222, 193 ms; bytes: 127127, 127127, 127127, 127127, 126576
- cli-click: 530, 561, 536, 531, 497, 522, 528, 549, 499, 533 ms
- cli-swipe: 2787, 2695, 2717, 2687, 2630 ms
- cli-capture: 741, 890, 847, 828, 822 ms; bytes: 717715, 715920, 715920, 715920, 715920
- snapshot: 694, 687, 651, 616, 592 ms; bytes: 198828, 198828, 198828, 198828, 198828
