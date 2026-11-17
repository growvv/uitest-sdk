# uitest-sdk

鸿蒙（HarmonyOS / OpenHarmony）`uitest` 设备侧扩展的 TypeScript 工具链。一个库，
两个产品，同一个仓库、同一个官网、各自发版。

[官网](https://growvv.github.io/uitest-sdk/) · [文档](https://growvv.github.io/uitest-sdk/docs.html) ·
[完整 API](https://growvv.github.io/uitest-sdk/api.html) · [验收报告](https://growvv.github.io/uitest-sdk/acceptance.html) ·
[更新日志](https://growvv.github.io/uitest-sdk/changelog.html)

## 包

| 包 | npm | 是什么 | 装法 |
|---|---|---|---|
| [`packages/core`](packages/core) | [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk) | 库：连接、观察、动作、投屏、viewer、治理。没有可执行文件 | `npm install uitest-sdk` |
| [`packages/phone`](packages/phone) | [`uitest-phone`](https://www.npmjs.com/package/uitest-phone) | 无界面的设备 Agent：21 条命令的 CLI、stdio MCP、Agent Skill | `npm i -g uitest-phone` |
| [`packages/console`](packages/console) | [`uitest-console`](https://www.npmjs.com/package/uitest-console) | 人的界面：浏览器镜像、接管、审批收件箱 | `npm i -g uitest-console` |

依赖只有一个方向：`phone` 与 `console` → `core`，产品之间互不依赖，`core` 不认识任何产品。
`scripts/check-layers.mjs` 在 CI 里强制这条边——core 里出现产品代码、产品深路径 import、
或者产品依赖另一个产品，都会失败。

```bash
npx uitest-phone doctor              # 探测设备与能力
npx uitest-phone observe --task "check WLAN"
npx uitest-phone approvals list      # 人回答被策略拦下的步骤
uitest-console                       # 浏览器里看手机、接管、批准
```

```ts
import { connect } from "uitest-sdk";

const session = await connect();
await session.observe.layout();
await session.act.tap({ text: "设置" });
await session.cast.open();           // H.264 / MJPEG
await session.close();
```

## 开发

```bash
npm install
npm run build                        # 三个包依次编译
npm test                             # 单元测试，不碰设备
node scripts/check-layers.mjs        # 包依赖方向
node scripts/check-site.mjs          # 官网内容与静态资源
node scripts/check-skill.mjs         # SKILL.md / REFERENCE.md 覆盖全部命令
npm run test:device                  # 集成测试，需连接设备（先 unset HDC_SERVER_PORT）
npm run typecheck:tests
```

设备相关的命令都要先 `unset HDC_SERVER_PORT`（DevEco 会把这个变量指到它自己的端口，
hdc 于是看不到设备）。设备序列号不进任何受跟踪的文件：页面、日志、报告只用 `tagOf()` 的
8 位哈希。

## 目录

```
packages/core      uitest-sdk：src/{transport,driver,operations,governance,cast,input,viewer}
packages/phone     uitest-phone：src/{bin,cli-main,mcp,connect,install-skill,approvals}
packages/console   uitest-console：src/{cli,server,page,window}
site/              官网（静态，无构建步骤）
scripts/           构建检查、验收脚本、站点生成
docs/              API、benchmarks、验收报告、调研与设计
```

## 发版顺序

每个包独立发版，`core` 先发，产品紧随其后：

```bash
npm run build
npm test && node scripts/check-layers.mjs && node scripts/check-site.mjs && node scripts/check-skill.mjs
npm publish -w uitest-sdk            # 先 core
npm publish -w uitest-phone          # 再产品（依赖 core 的版本区间）
npm publish -w uitest-console
```

每个产品每一版都在真机上单独验收，报告与截图发布在官网的[验收页](https://growvv.github.io/uitest-sdk/acceptance.html)。

## 许可

MIT。`packages/core/assets/` 里的 `agent.so` 与 `libscreen_casting.z.so` 是华为 DevEco
生成并签名的设备侧扩展，不是本仓库的源码，MIT 不覆盖它们；版本、大小、md5 与来源见
[`packages/core/NOTICE`](packages/core/NOTICE)。安全说明见 [`packages/core/SECURITY.md`](packages/core/SECURITY.md)。
