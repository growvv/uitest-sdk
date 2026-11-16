# live 页接管输入验收报告

- 设备：dev-6c585f5b（BRA-AL00，BRA-AL00 7.0.0.111(SP10C00E111R4P3)）
- 屏幕：1216×2688
- 应用：知乎 com.zhihu.hmos/PhoneAbility
- 代码：369a996
- 开始：2026-11-16T19:41:21.019Z
- 结果：**5/5 PASS**
- 本次注入延迟：p50 5.3 ms · p95 133.7 ms · n=18

| 场景 | 结果 | 耗时 (ms) | 说明 | 证据 |
|---|---|---|---|---|
| readonly guard | ✅ PASS | 4894 | 未接管时注入被忽略，节点表不变 | docs/acceptance/live/screenshots/01-readonly.jpg |
| takeover | ✅ PASS | 65 | 冷接管 34 ms；第二个页面被拒（busy by c1） | — |
| tap | ✅ PASS | 5337 | 点击「知识」后画面变化；p50 3.2 ms · p95 15.6 ms · n=2 | docs/acceptance/live/screenshots/02-tap.jpg |
| long press | ✅ PASS | 10106 | 长按搜索框弹出系统输入助手（自动填充 / 拍摄输入 / 小艺帮写） | docs/acceptance/live/screenshots/03-long-press.jpg |
| scroll | ✅ PASS | 5710 | 在 608,2390 → 608,606 竖划后可见内容变化 | docs/acceptance/live/screenshots/04-scroll.jpg |

> 本报告由 `npx tsx scripts/acceptance-live.ts --target <id>` 生成；设备只以 8 位标签出现。
> 证据截图底部裁去 200 px（登录账号的头像与未读角标）；长按证据只保留顶部 280 px（其下是搜索历史）。其余保持原始分辨率。
