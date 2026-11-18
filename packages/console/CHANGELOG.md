# 更新日志

本文件记录 `uitest-console` 的公开版本。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循语义化版本。

## [0.1.1] — 2026-11-18

- 运行在 `uitest-sdk@0.10.1` 上。
- Deny 输给已有的 Allow 时页面显示冲突原因，而不是静默刷新。
- 设备已被人持有时打开的标签页直接显示 Resume：此前它从 Hold 开始，
  第一下点击又把人持有变成再持有，设备交不回去。页面轮询时也会重新读租约，
  两个标签页共享同一个租约不再各说各话。
- 退出时如果设备仍被人持有，打印设备标签和 `uitest-phone resume`，不再让人以为设备已经空了。

## [0.1.0] — 2026-11-18

第一个版本：`uitest-sdk` 0.9.4 里的 `live` 页面成为独立的人机产品。

- 镜像与节点表复用 core 的 viewer（播放器、inspect、隐私开关、来源校验）。
- 新增**接管**：Hold 写「人持有」租约，agent 命令停在 `lease_held`；Resume 交还。
  只观看不占租约，可与 agent 同时运行。
- 新增**审批收件箱**：列出 core 网关的待审批步骤，Allow（once/task/always）或 Deny。
- 活动视图只读展示最近 trace。
- 浏览器窗口优先用 Edge/Chrome 的 `--app`；没有可用浏览器时打印 URL。
