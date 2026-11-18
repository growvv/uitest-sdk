# uitest-sdk 0.11.0 验收报告

> 本文件由 `scripts/acceptance-core.ts` 生成，请勿手改。生成时间：2026-11-18，提交 `ba52b9b`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
| 7544d645 | MLR-AL10 | 1600x2560 |

## 结果

| # | 设备 | 用例 | 结果 | 说明 |
|---|---|---|---|---|
| `viewer-mirror` | 7544d645 | viewer 镜像（真实浏览器） | ✅ | 1600x2560 · 0 notes |
| `viewer-inspect` | 7544d645 | viewer 节点表 | ✅ | 22 node rows |
| `viewer-privacy` | 7544d645 | viewer 隐私开关 | ✅ | switch on->off->on (was true) · 遮罩在读布局时完成，不覆盖在画面上 |
| `connect` | 7544d645 | connect() 与会话 | ✅ | com.huawei.hmos.calculator · 1600x2560 |
| `click` | 7544d645 | act.tap 点击 | ✅ | settled · 1776 ms |
| `swipe` | 7544d645 | act.swipe 滑动 | ✅ | settled · 2385 ms |
| `touch` | 7544d645 | 触摸协议 down/move/up | ✅ | down/move/up ok |
| `triggerKey` | 7544d645 | act.key 系统按键 | ✅ | settled · power |
| `captureLayout` | 7544d645 | observe.layout UI 树 | ✅ | 225 nodes |
| `captureScreen` | 7544d645 | observe.screenshot 截图 | ✅ | 324 ms · 49051 B |
| `cropScreen` | 7544d645 | 按 bundle 裁剪截图 | ✅ | com.huawei.hmos.calculator · 68476 B |
| `streamScreen` | 7544d645 | streamScreen MJPEG 取帧 | ✅ | 9.3 fps |
| `createCast` | 7544d645 | cast.open H.264 投流 | ✅ | h264 · 31 B |
| `createCastRecord` | 7544d645 | cast.record MP4 录制 | ✅ | 187469 B mp4 |
| `dualCast` | 7544d645 | 两路并发投流 | ✅ | 31 B / 31 B |
| `dumpLayout` | 7544d645 | cli.dumpLayout | ✅ | 227 nodes |
| `queue` | 7544d645 | 并发调用排队 | ✅ | 10 calls · 102 ms |
| `rpcDuringStream` | 7544d645 | 投流期间调用 RPC | ✅ | 12 ms |
| `streamUiActions` | 7544d645 | UI 事件流 | ✅ | session opens; synthetic touches are not reported (device behaviour) |
| `security-origin` | 7544d645 | viewer 来源校验（7 种握手） | ✅ | 7/7 handshakes · origin: 101 |
| `package` | host | npm 包内容 | ✅ | 157 个文件 · 1040 KB · 无 src/test/bin · 3 个设备扩展 |

## 汇总

通过 21，失败 0，跳过 0。

## 复现

`unset HDC_SERVER_PORT`
`npx tsx scripts/acceptance-core.ts --targets <id>[,<id>]`
`node scripts/gen-acceptance-pages.mjs`
