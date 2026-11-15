# uitest-sdk 发布与宣传设计（GitHub Pages 官网 + Remotion 视频）

## 1. 目标

把已完成的 `uitest-sdk` 作为公开 GitHub 项目发布，并配一套宣传物料：

- **GitHub 仓库**：`growvv/uitest-sdk`，公开，MIT。
- **官网**：GitHub Pages 静态站，版式与交互复刻 [bun.sh](https://bun.sh) 的结构与气质（不复制其文案、Logo、图片）。
- **视频**：Remotion 制作的 30 秒无声动画，嵌在官网首屏。

**受众**：需要用 Node 对鸿蒙设备做 UI 自动化、截图与 H.264 投流的开发者。

**成功标准**：Pages 可公开访问；首屏在 3 秒内呈现价值主张；官网零外部网络依赖；视频可播放；仓库历史不含调研期的大体积机器产物；SDK 自身测试不受影响。

## 2. 已确认的决策

| 决策 | 结论 |
|---|---|
| 仓库可见性 | 公开 |
| `assets/**/*.so`（三个华为签名二进制） | **保留并公开**。这是用户明确选择；再分发风险由用户承担 |
| `.work/**`、`.spike/**` | 从全部历史移除（含 37 MB / 18 MB 的 DevEco JAR） |
| 许可证 | MIT |
| 仓库名 | `growvv/uitest-sdk` |
| 站点语言 | 中文为主，首屏附一句英文 tagline |
| 站点技术 | 纯 HTML/CSS/JS，无框架、无构建步骤 |
| 视频 | Remotion，1920×1080 / 30fps / 30 秒，无配音，中文字幕 |
| 执行顺序 | 历史重写与清洗 → 官网 → 视频 → 发布 |

## 3. 仓库清洗

用 `git filter-repo` 一次性移除 `.work/` 与 `.spike/`。`assets/` 全部保留（含三个 `.so` 与 `manifest.json`）。

**序列号清洗**：真机序列号出现在 9 个已跟踪文件（README、docs/06、08、09、10、docs/README、验收报告、设计文档、实施计划），统一替换为 `<your-device-id>`。

**代价**：所有提交 hash 改变。仓库尚无 remote，因此这一操作没有外部影响；`filter-repo` 需要 `--force` 才会在非全新克隆上执行。

**校验**：`git log --all --name-only` 不含 `.work/`、`.spike/`；`git grep` 无序列号；仓库体积显著下降；三个 `.so` 仍在 HEAD 中。

## 4. 官网

### 4.1 技术与约束

- 文件放在 `site/`：`index.html`、`styles.css`、`main.js`、`assets/`。
- 不引用任何 CDN、外部字体或第三方脚本；字体使用系统字体栈（含中文回退 `"PingFang SC"`, `"Microsoft YaHei"`），等宽字体使用 `ui-monospace` 一族。
- 动效只用 CSS 与原生 JS：滚动入场（`IntersectionObserver`）、终端逐字打字、复制按钮；尊重 `prefers-reduced-motion`。
- 响应式：≥1024px 双栏，以下单栏；首屏不依赖 JS 也能读到核心信息。
- 无追踪、无 cookie。

### 4.2 版式（复刻 Bun 的页面结构）

1. **吸顶导航**：项目名 / 能力 / 实测 / 视频 / 文档 / GitHub。
2. **首屏**：H1 + 一句英文 tagline + `npm install uitest-sdk` 代码块（可复制）+ 两个 CTA（快速开始、GitHub）+ 右侧真机截图。
3. **终端演示**：逐字打出「连接 → 点击 → 截图」的一段真实调用。
4. **实测性能表**：取自 `docs/acceptance/report.md` 的真机数字（截图 107–193 ms、点击 21–50 ms、滑动 386–640 ms、投流 15–89 fps）。
5. **能力网格**：8 张卡片，对应 SDK 的主要能力。
6. **双通道架构**：agent 长连接 + gRPC 投流的示意，用内联 SVG/CSS 绘制。
7. **视频区**：`<video controls poster>` 嵌入 `assets/demo.mp4`。
8. **已知限制**：诚实地列出（窗口级截图不存在、`scale` 无效、静止画面只出 1 帧、x86_64 无 casting），与 README 一致。
9. **页脚**：MIT、GitHub、文档链接。

### 4.3 素材

- 验收截图全部拍到了同一个系统弹窗，不能用作宣传图。改为用 SDK 自己现场拍摄：先用 `uitest uiInput keyEvent Back` 回到桌面，再 `captureScreen()` 得到 608×1344 JPEG（桌面一张、上滑后一张）。
- 所有数字来自验收报告，不编造；页面语言中文。

## 5. 视频

- 独立工程 `video/`，自带 `package.json`（Remotion），不进入 SDK 的依赖。
- 分镜：
  - 0–4s：项目名 + 价值主张
  - 4–10s：终端 `npm install`、连接、点击（打字动画）
  - 10–18s：代码片段 + 真机截图滑入
  - 18–26s：投流帧率数字滚动 + 画面示意
  - 26–30s：能力快闪 + GitHub 地址
- 输出 `site/assets/demo.mp4`（H.264，无音轨）；同时输出一张封面图作为 `<video poster>`。
- 渲染使用 Remotion CLI；如果本地无法下载 Chrome Headless Shell，则改用系统 Chrome 渲染，并在文档中记录。

## 6. 发布

1. `gh repo create growvv/uitest-sdk --public --source . --push`（或先建空仓库再推 `master`）。
2. 增加 `.github/workflows/pages.yml`：`actions/configure-pages` → `upload-pages-artifact`（`site/`）→ `deploy-pages`。
3. 通过 `gh api` 把 Pages 的 `build_type` 设为 `workflow`。
4. 访问 `https://growvv.github.io/uitest-sdk/` 验证 200 与首屏内容。
5. README 顶部加官网与视频链接。

## 7. 验收标准

- [ ] 历史中无 `.work/`、`.spike/`；无真机序列号；三个 `.so` 仍在 HEAD。
- [ ] 官网本地打开零外部请求；桌面与移动布局正常；视频可播放。
- [ ] `demo.mp4` 时长 30s±1s，分辨率 1920×1080。
- [ ] Pages 返回 200，首屏、性能表、视频均可见。
- [ ] `npm test`（84/84）与 `npm run test:device`（18 passed / 1 skipped）仍然全绿。
- [ ] README 包含官网链接。

## 8. 风险

- **`.so` 再分发**：公开仓库会再分发华为签名二进制，存在许可风险；用户已知情并选择承担。
- **历史重写不可逆**：hash 全变；仓库无 remote，因此无外部影响。
- **Remotion 渲染依赖**：首次渲染需下载 Headless Shell（约 100 MB）；网络受限时回退到系统 Chrome。
- **GitHub Pages 在中国大陆的访问稳定性**：不在本次范围。

## 9. 明确不做

- 不做英文站点（仅一句英文 tagline）。
- 不做视频配音。
- 不发布 npm 包。
- 不修改 SDK 源码行为（唯一例外是 README/文档的清洗）。
