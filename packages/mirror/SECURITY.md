# 安全说明

## 报告漏洞

请通过 GitHub Security Advisories 私下报告：

https://github.com/growvv/uitest-sdk/security/advisories/new

## 信任边界

`uitest-console` 起一个本地 HTTP/WebSocket 服务，默认只监听 `127.0.0.1`。
**任何能访问这个端口的人都能看屏幕并驱动手机**——`--host 0.0.0.0` 等于把设备
交给整个局域网，只在明确需要时使用。

- **来源校验在 core。** WebSocket 握手只接受与页面同源的 `Origin`；拒绝路径
  和状态码由 `uitest-sdk/viewer` 提供，所有产品共用一份实现。
- **审批由人决定。** 收件箱写入的是 core 网关的决策文件，与
  `uitest-phone approvals` 完全等价；agent 持有 id 也不能自己批准。
- **接管是显式的。** Hold 写「人持有」租约；关闭页面不会留下租约（只看不占）。
  没有基于进程存活或设备侧触摸的隐式接管。
- **页面不执行设备数据。** 审批行、应用名、规则和 trace 文本都经过转义后插入；
  设备上的标签不会变成脚本。
- **序列号不落盘。** 页面、日志和租约只使用设备序列号的 8 字符哈希。
