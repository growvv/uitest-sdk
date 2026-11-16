# live 页接管输入验收报告

- 设备：dev-6c585f5b（BRA-AL00，BRA-AL00 7.0.0.111(SP10C00E111R4P3)）
- 屏幕：1216×2688
- 应用：知乎 com.zhihu.hmos/PhoneAbility
- 代码：9989b10
- 开始：2026-11-16T22:10:23.715Z
- 结果：**10/10 PASS**
- 本次注入延迟：p50 290.3 ms · p95 1445.4 ms · n=200

| 场景 | 结果 | 耗时 (ms) | 说明 | 证据 |
|---|---|---|---|---|
| readonly guard | ✅ PASS | 4209 | 未接管时注入被忽略：仍在信息流，未获得控制权 | docs/acceptance/live/screenshots/01-readonly.jpg |
| takeover | ✅ PASS | 70 | 冷接管 38 ms；第二个页面被拒（busy by c1） | — |
| tap | ✅ PASS | 9512 | 点击「知识」后画面变化；p50 3.2 ms · p95 24.1 ms · n=2 | docs/acceptance/live/demo/1-feed.jpg<br>docs/acceptance/live/screenshots/02-tap.jpg |
| long press | ✅ PASS | 9898 | 长按搜索框弹出系统输入助手（自动填充 / 拍摄输入 / 小艺帮写） | docs/acceptance/live/screenshots/03-long-press.jpg |
| scroll | ✅ PASS | 4417 | 在 608,1467 → 608,606 竖划后可见内容变化 | docs/acceptance/live/screenshots/04-scroll.jpg |
| keyboard | ✅ PASS | 17465 | 输入「鸿蒙」并回车后结果页出现该词；键盘走写通道 | docs/acceptance/live/screenshots/06-keyboard.jpg<br>docs/acceptance/live/demo/3-search.jpg |
| browser keyboard | ✅ PASS | 14218 | 真实页面：英文 300 ms 空闲落设备（输入框里的文字在空闲后到达设备，设备画面随之变化）；真实页面：拼音组合不上屏（组合期间设备无变化，compositionend 后整词到达） | — |
| system keys | ✅ PASS | 12979 | 返回键退出搜索页；Home 键切到桌面（com.ohos.sceneboard），再冷启动回知乎 | docs/acceptance/live/screenshots/07-home.jpg |
| pinch | ✅ PASS | 34706 | 图片查看器内 80→120→160 双指放大；画面差异 39.3（阈值 8） | docs/acceptance/live/screenshots/08-pinch-before.jpg<br>docs/acceptance/live/screenshots/09-pinch-after.jpg<br>docs/acceptance/live/demo/4-image.jpg<br>docs/acceptance/live/demo/2-article.jpg |
| stability | ✅ PASS | 660945 | 基线 18.12 fps（60 s 同样输入）· 长跑 18.20 fps（600 s，1182 次）· 换手 ack 31 ms · p50 290.3 ms · p95 1445.4 ms | — |

## 浏览器人工检查

在真实页面里执行（`--browser` 用无头 Chrome 加载同一个页面、同一台设备，键盘事件走页面的真实监听器；不是模拟服务器）：

- [x] 真实页面：英文 300 ms 空闲落设备 — 输入框里的文字在空闲后到达设备，设备画面随之变化
- [x] 真实页面：拼音组合不上屏 — 组合期间设备无变化，compositionend 后整词到达

> 本报告由 `npx tsx scripts/acceptance-live.ts --target <id>` 生成；设备只以 8 位标签出现。
> 证据截图底部裁去 200 px（登录账号的头像与未读角标）；长按证据只保留顶部 280 px（其下是搜索历史）。其余保持原始分辨率。
> `docs/acceptance/live/demo/` 是官网动画用的整屏原图，同样裁去底部 200 px。
