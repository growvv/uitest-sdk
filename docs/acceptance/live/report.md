# live 页接管输入验收报告

- 设备：dev-6c585f5b（BRA-AL00，BRA-AL00 7.0.0.111(SP10C00E111R4P3)）
- 屏幕：1216×2688
- 应用：知乎 com.zhihu.hmos/PhoneAbility
- 代码：b3201e5+dirty
- 开始：2026-11-17T07:58:26.691Z
- 结果：**2/2 PASS**（另有 8 项未运行：`--only` 过滤，本次不是完整验收）

| 场景 | 结果 | 耗时 (ms) | 说明 | 证据 |
|---|---|---|---|---|
| readonly guard | ✅ PASS | 5526 | 未接管时注入被忽略：点搜索框后仍在信息流，未获得控制权 | docs/acceptance/live/screenshots/01-readonly.jpg |
| takeover | ✅ PASS | 61 | 冷接管 29 ms；第二个页面被拒（busy by c1） | — |
| tap | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| long press | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| scroll | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| keyboard | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| browser keyboard | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| system keys | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| pinch | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |
| stability | ⏭ SKIP | 0 | 未运行（--only 过滤） | — |

## 真实页面键盘检查

`browser keyboard` 场景用无头 Chrome 打开同一个 live 页面、同一台设备，键盘事件走页面的真实监听器（不是模拟服务器）：

- [ ] 未运行：`browser keyboard` 场景被 `--only` 过滤掉了

> 本报告由 `npx tsx scripts/acceptance-live.ts --target <id>` 生成；设备只以 8 位标签出现。
> 证据截图底部裁去 200 px（登录账号的头像与未读角标）；长按证据只保留输入助手条及其下 24 px（其下是搜索历史，位置随搜索词变化，所以按节点几何裁）。其余保持原始分辨率。
> `docs/acceptance/live/demo/` 是官网动画用的整屏原图，同样裁去底部 200 px。
