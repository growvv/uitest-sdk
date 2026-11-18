# uitest-sdk 0.10.0 验收报告

> 本文件由 `scripts/acceptance-core.ts` 生成，请勿手改。生成时间：2026-11-18，提交 `8012195`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 6c585f5b | BRA-AL00 | 1216x2688 |
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 用例 | 结果 | 说明 |
|---|---|---|---|---|
| `viewer-mirror` | 6c585f5b | viewer 镜像（真实浏览器） | ✅ | 1216x2688 · 0 notes |
| `viewer-inspect` | 6c585f5b | viewer 节点表 | ✅ | 22 node rows |
| `viewer-privacy` | 6c585f5b | viewer 隐私开关 | ✅ | switch on->off->on (was true) · 遮罩在读布局时完成，不覆盖在画面上 |
| `connect` | 6c585f5b | connect() 与会话 | ✅ | com.huawei.hmos.calculator · 1216x2688 |
| `click` | 6c585f5b | act.tap 点击 | ✅ | settled · 918 ms |
| `swipe` | 6c585f5b | act.swipe 滑动 | ✅ | settled · 1714 ms |
| `touch` | 6c585f5b | 触摸协议 down/move/up | ✅ | down/move/up ok |
| `triggerKey` | 6c585f5b | act.key 系统按键 | ✅ | settled · power |
| `captureLayout` | 6c585f5b | observe.layout UI 树 | ✅ | 192 nodes |
| `captureScreen` | 6c585f5b | observe.screenshot 截图 | ✅ | 164 ms · 35993 B |
| `cropScreen` | 6c585f5b | 按 bundle 裁剪截图 | ✅ | com.huawei.hmos.calculator · 49106 B |
| `streamScreen` | 6c585f5b | streamScreen MJPEG 取帧 | ✅ | 12.2 fps |
| `createCast` | 6c585f5b | cast.open H.264 投流 | ✅ | h264 · 31 B |
| `createCastRecord` | 6c585f5b | cast.record MP4 录制 | ✅ | 380341 B mp4 |
| `dualCast` | 6c585f5b | 两路并发投流 | ✅ | 31 B / 31 B |
| `dumpLayout` | 6c585f5b | cli.dumpLayout | ✅ | 194 nodes |
| `queue` | 6c585f5b | 并发调用排队 | ✅ | 10 calls · 48 ms |
| `rpcDuringStream` | 6c585f5b | 投流期间调用 RPC | ✅ | 6 ms |
| `streamUiActions` | 6c585f5b | UI 事件流 | ✅ | session opens; synthetic touches are not reported (device behaviour) |
| `security-origin` | 6c585f5b | viewer 来源校验（7 种握手） | ✅ | 7/7 handshakes · origin: 101 |
| `viewer-mirror` | 7544d645 | viewer 镜像（真实浏览器） | ✅ | 1600x2560 · 0 notes |
| `viewer-inspect` | 7544d645 | viewer 节点表 | ✅ | 23 node rows |
| `viewer-privacy` | 7544d645 | viewer 隐私开关 | ✅ | switch on->off->on (was true) · 遮罩在读布局时完成，不覆盖在画面上 |
| `connect` | 7544d645 | connect() 与会话 | ✅ | com.huawei.hmos.calculator · 1600x2560 |
| `click` | 7544d645 | act.tap 点击 | ✅ | settled · 1455 ms |
| `swipe` | 7544d645 | act.swipe 滑动 | ✅ | settled · 2394 ms |
| `touch` | 7544d645 | 触摸协议 down/move/up | ✅ | down/move/up ok |
| `triggerKey` | 7544d645 | act.key 系统按键 | ✅ | settled · power |
| `captureLayout` | 7544d645 | observe.layout UI 树 | ✅ | 227 nodes |
| `captureScreen` | 7544d645 | observe.screenshot 截图 | ✅ | 299 ms · 47299 B |
| `cropScreen` | 7544d645 | 按 bundle 裁剪截图 | ✅ | com.huawei.hmos.calculator · 65543 B |
| `streamScreen` | 7544d645 | streamScreen MJPEG 取帧 | ✅ | 7.1 fps |
| `createCast` | 7544d645 | cast.open H.264 投流 | ✅ | h264 · 31 B |
| `createCastRecord` | 7544d645 | cast.record MP4 录制 | ✅ | 220086 B mp4 |
| `dualCast` | 7544d645 | 两路并发投流 | ✅ | 31 B / 31 B |
| `dumpLayout` | 7544d645 | cli.dumpLayout | ✅ | 227 nodes |
| `queue` | 7544d645 | 并发调用排队 | ✅ | 10 calls · 51 ms |
| `rpcDuringStream` | 7544d645 | 投流期间调用 RPC | ✅ | 7 ms |
| `streamUiActions` | 7544d645 | UI 事件流 | ✅ | session opens; synthetic touches are not reported (device behaviour) |
| `security-origin` | 7544d645 | viewer 来源校验（7 种握手） | ✅ | 7/7 handshakes · origin: 101 |
| `package` | host | npm 包内容 | ✅ | 151 个文件 · 1030 KB · 无 src/test/bin · 3 个设备扩展 |

## 汇总

通过 41，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-core.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
