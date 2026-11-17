# live 页接管输入验收报告

- 设备：dev-6c585f5b（BRA-AL00，BRA-AL00 7.0.0.111(SP10C00E111R4P3)）
- 屏幕：1216×2688
- 应用：知乎 com.zhihu.hmos/PhoneAbility
- 代码：68134b4
- 开始：2026-11-17T02:25:11.055Z
- 结果：**10/10 PASS**
- 本次注入延迟：p50 291.8 ms · p95 1443.3 ms · n=200

| 场景 | 结果 | 耗时 (ms) | 说明 | 证据 |
|---|---|---|---|---|
| readonly guard | ✅ PASS | 3840 | 未接管时注入被忽略：仍在信息流，未获得控制权 | docs/acceptance/live/screenshots/01-readonly.jpg |
| takeover | ✅ PASS | 68 | 冷接管 37 ms；第二个页面被拒（busy by c1） | — |
| tap | ✅ PASS | 7879 | 点击「知识」后画面变化；p50 3.4 ms · p95 16.3 ms · n=2 | docs/acceptance/live/demo/1-feed.jpg<br>docs/acceptance/live/screenshots/02-tap.jpg |
| long press | ✅ PASS | 9241 | 长按搜索框弹出系统输入助手（自动填充 / 拍摄输入 / 小艺帮写） | docs/acceptance/live/screenshots/03-long-press.jpg |
| scroll | ✅ PASS | 4269 | 在 608,1467 → 608,606 竖划后可见内容变化 | docs/acceptance/live/screenshots/04-scroll.jpg |
| keyboard | ✅ PASS | 18875 | 输入「鸿蒙」并回车后结果页出现该词；键盘走写通道 | docs/acceptance/live/screenshots/06-keyboard.jpg<br>docs/acceptance/live/demo/3-search.jpg |
| browser keyboard | ✅ PASS | 14969 | 真实页面：英文 300 ms 空闲落设备（输入框里的文字在空闲后到达设备，设备画面随之变化）；真实页面：拼音组合不上屏（组合期间设备无变化，compositionend 后整词到达） | — |
| system keys | ✅ PASS | 12068 | 返回键退出搜索页；Home 键切到桌面（com.ohos.sceneboard），再冷启动回知乎 | docs/acceptance/live/screenshots/07-home.jpg |
| pinch | ✅ PASS | 50894 | 图片查看器内 80→120→160 双指放大；画面差异 78.2（阈值 8） | docs/acceptance/live/screenshots/08-pinch-before.jpg<br>docs/acceptance/live/screenshots/09-pinch-after.jpg<br>docs/acceptance/live/demo/4-image.jpg<br>docs/acceptance/live/demo/5-zoomed.jpg<br>docs/acceptance/live/demo/2-article.jpg |
| stability | ✅ PASS | 661129 | 基线 17.88 fps（60 s 同样输入）· 长跑 17.01 fps（600 s，1182 次）· 换手 ack 31 ms · p50 291.8 ms · p95 1443.3 ms | — |

## 真实页面键盘检查

`browser keyboard` 场景用无头 Chrome 打开同一个 live 页面、同一台设备，键盘事件走页面的真实监听器（不是模拟服务器）：

- [x] 真实页面：英文 300 ms 空闲落设备 — 输入框里的文字在空闲后到达设备，设备画面随之变化
- [x] 真实页面：拼音组合不上屏 — 组合期间设备无变化，compositionend 后整词到达

> 本报告由 `npx tsx scripts/acceptance-live.ts --target <id>` 生成；设备只以 8 位标签出现。
> 证据截图底部裁去 200 px（登录账号的头像与未读角标）；长按证据只保留输入助手条及其下 24 px（其下是搜索历史，位置随搜索词变化，所以按节点几何裁）。其余保持原始分辨率。
> `docs/acceptance/live/demo/` 是官网动画用的整屏原图，同样裁去底部 200 px。
