# uitest-sdk 发布实现计划（官网 + 视频）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清洗仓库历史后，交付一个复刻 Bun 风格的静态官网与一段 30 秒 Remotion 视频，并以 `growvv/uitest-sdk` 的名义发布到 GitHub Pages。

**Architecture:** 官网是 `site/` 下的纯静态文件，零构建、零外部依赖，由一条 Pages Actions 工作流原样上传；视频是 `video/` 下独立的 Remotion 工程，渲染产物写入 `site/assets/`。一个 Node 脚本 `scripts/check-site.mjs` 充当两者的验收测试。

**Tech Stack:** HTML/CSS/原生 JS；Node 26 内置模块（检查脚本、截图脚本）；Remotion 4 + React 18；GitHub Actions Pages。

**Spec:** `docs/superpowers/specs/2026-11-15-uitest-sdk-launch-design.md`

## Global Constraints

- 官网零外部网络请求：不得出现 CDN、外部字体、第三方脚本或追踪。
- 站点中文为主，首屏附一句英文 tagline。
- 纯 HTML/CSS/JS，无框架、无构建步骤。
- 视频 1920×1080、30fps、30 秒 ±1 秒、无音轨、中文字幕。
- 三个 `assets/**/*.so` **保留并公开**（用户决策，风险自担）。
- `.work/**`、`.spike/**` 从全部 git 历史移除。
- 真机序列号在所有历史提交中替换为 `<your-device-id>`。
- 许可证 MIT；仓库 `growvv/uitest-sdk`。

> `<DEVICE_ID>` 指测试机的真实序列号，由执行者从环境取得；它只能出现在命令里，**永远不要写进任何被跟踪的文件**。

## Review Focus

1. **序列号残留在历史而不是 HEAD**：只看工作区会漏掉旧提交里的设备号。
2. **`file://` 直接打开**：所有资源必须用相对路径，绝对路径 `/assets/...` 会让本地预览 404。
3. **手机端视频**：iOS/Android 不允许自动播放带声音的视频，必须 `controls playsinline` + `poster`，且不自动播放。
4. **375px 宽度**：首屏双语大标题与性能表最容易横向溢出。
5. **filter-repo 的副作用**：它会改写所有 ref、删掉 remote 与 hooks；执行后必须确认 `feat/launch` 仍可继续提交。

---

### Task 1: 清洗 git 历史

**Files:** 无跟踪文件改动（只重写历史）。

**Interfaces:**
- Produces: 一个不含 `.work/`、`.spike/`、不含真机序列号的历史；`assets/` 原样保留。

- [ ] **Step 1: 安装 git-filter-repo**

Run: `python -m pip install --user git-filter-repo && git filter-repo --version`
Expected: 输出 `2.47.0`（或更高）。

- [ ] **Step 2: 确认工作区干净、当前在 `feat/launch`**

Run: `git status --porcelain && git rev-parse --abbrev-ref HEAD`
Expected: 无输出；`feat/launch`。

- [ ] **Step 3: 写替换规则（放在 gitignored 的 `.work/` 内，用完即删）**

Run:
```bash
mkdir -p .work
printf 'literal:%s==><your-device-id>\n' '<DEVICE_ID>' > .work/filter-replace.txt
```

- [ ] **Step 4: 全历史替换序列号**

Run: `git filter-repo --replace-text .work/filter-replace.txt --force`
Expected: `Parsed 20 commits` 之后 `New history written in ...; now repacking/cleaning...`。

- [ ] **Step 5: 从全历史移除 `.work/` 与 `.spike/`**

Run: `git filter-repo --path .work --path .spike --invert-paths --force`
Expected: 同样输出 `New history written`。

- [ ] **Step 6: 删除替换规则文件并验证**

Run:
```bash
rm -f .work/filter-replace.txt
git log --all -S"<DEVICE_ID>" --oneline
git log --all --name-only --pretty=format: | sort -u | grep -E '^(\.work|\.spike)/'
git ls-files assets
du -sh .git
```
Expected: 第 2 条无输出；第 3 条无输出；第 4 条列出 4 个文件（含三个 `.so`）；第 5 条显著小于 60 MB。

- [ ] **Step 7: 确认分支仍可用**

Run: `git status --porcelain && git log --oneline -1`
Expected: 工作区干净，HEAD 为 `docs: add launch design...` 的重写版本。

---

### Task 2: 许可证、README 与元数据

**Files:**
- Create: `LICENSE`
- Modify: `README.md`（顶部）
- Modify: `package.json`（元数据）
- Modify: `assets/manifest.json`（去掉对已删除 `.spike/` 的引用）

**Interfaces:**
- Produces: `LICENSE`（MIT），`package.json` 含 `license`/`repository`/`homepage`/`description`。

- [ ] **Step 1: 写 `LICENSE`**

MIT 正文，版权行 `Copyright (c) 2026 uitest-sdk contributors`。

- [ ] **Step 2: 更新 `package.json`**

在顶层加入：
```json
"description": "HarmonyOS uitest extension SDK for Node.js: UI automation, screenshots, H.264 casting and MP4 recording",
"license": "MIT",
"repository": { "type": "git", "url": "git+https://github.com/growvv/uitest-sdk.git" },
"homepage": "https://growvv.github.io/uitest-sdk/",
"keywords": ["harmonyos", "openharmony", "uitest", "automation", "scrcpy", "h264"]
```

- [ ] **Step 3: 修 `assets/manifest.json` 的悬空引用**

把 `libscreen_casting.z.so` 的 `source` 值改为 `"hscrcpy server (HOScrcpy 2.12.9 build)"` —— 原来的 `.spike/hscrcpy-server/PROVENANCE.md` 已随历史移除。

- [ ] **Step 4: README 顶部加发布信息**

在标题下一行加入：

```markdown
[官网](https://growvv.github.io/uitest-sdk/) · [宣传视频](https://growvv.github.io/uitest-sdk/#video) · [GitHub](https://github.com/growvv/uitest-sdk) · MIT
```

- [ ] **Step 5: 验证**

Run:
```bash
node -e "const p=require('./package.json');const a=require('./assets/manifest.json');if(p.license!=='MIT'||!p.repository||!p.homepage)process.exit(1);if(String(a.arm64['libscreen_casting.z.so'].source).includes('.spike'))process.exit(1);console.log('meta ok')"
npm test 2>&1 | tail -3
```
Expected: `meta ok`；单测 84 passed。

- [ ] **Step 6: 提交**

```bash
git add LICENSE README.md package.json assets/manifest.json
git commit -m "docs: add MIT license and publication metadata"
```

---

### Task 3: 拍摄官网截图

**Files:**
- Create: `scripts/media.ts`
- Create: `site/assets/screen-home.jpg`
- Create: `site/assets/screen-apps.jpg`

**Interfaces:**
- Produces: 两张 608×1344 JPEG，路径固定为 `site/assets/screen-home.jpg` 与 `site/assets/screen-apps.jpg`。

背景：验收截图全部拍到同一个系统弹窗，不可用；设备当前已回到桌面。

- [ ] **Step 1: 写 `scripts/media.ts`**

行为：读取 `--target` 或 `UITEST_TARGET`；用 `HdcRunner` 执行 `uitest uiInput keyEvent Back` 回到桌面；`Device.connect()` 后 `captureScreen()` 写 `site/assets/screen-home.jpg`；`agent.swipe(w/2, h*0.75, w/2, h*0.35, { durationMs: 150 })` 后再次 `captureScreen()` 写 `site/assets/screen-apps.jpg`；`dispose()`。

- [ ] **Step 2: 运行**

Run: `npx tsx scripts/media.ts --target <DEVICE_ID>`
Expected: 打印两张图的字节数，退出码 0。

- [ ] **Step 3: 验证**

Run: `file site/assets/screen-home.jpg site/assets/screen-apps.jpg`
Expected: 均为 `JPEG image data ... 608x1344`，且两张 md5 不同。

- [ ] **Step 4: 提交**

```bash
git add scripts/media.ts site/assets/screen-home.jpg site/assets/screen-apps.jpg
git commit -m "feat: capture marketing screenshots from the device"
```

---

### Task 4: 站点骨架与验收脚本

**Files:**
- Create: `scripts/check-site.mjs`
- Create: `site/index.html`
- Create: `site/styles.css`
- Create: `site/main.js`

**Interfaces:**
- Produces: `node scripts/check-site.mjs` —— 成功时打印 `site ok` 退出 0，失败时打印第一条失败原因退出 1。后续任务只往这个脚本里加断言，不改变用法。
- Produces: 页面锚点 `#hero` `#terminal` `#bench` `#features` `#arch` `#video` `#limits`。

- [ ] **Step 1: 写 `scripts/check-site.mjs` 的骨架与首批断言（RED）**

断言：三个站点文件存在；`index.html` 含全部七个 id；所有 `src="..."` / `href="..."`（排除 `http`、`#`、`mailto:`）指向的文件存在；不允许出现 `src="http`、`<link` 指向外域、`url(http`、`<script src="http`。用 `node:fs` 与正则实现，不引依赖。

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/check-site.mjs`
Expected: 退出码 1，`missing site/index.html`。

- [ ] **Step 3: 写站点骨架 `site/index.html`**

`<nav>`（项目名 + 锚点链接）、七个空 section（含主题 id）、`<footer>`；`<link rel="stylesheet" href="styles.css">`、`<script src="main.js" defer></script>`。语言 `zh-CN`，`<title>uitest-sdk · 用一条长连接控制鸿蒙设备</title>`。

- [ ] **Step 4: 写 `site/styles.css` 设计系统**

CSS 变量：`--bg:#0b0c0e`、`--fg:#f4f5f7`、`--muted:#9aa0aa`、`--accent:#ffd23f`、`--card:#14161a`、`--border:#24272e`；字体栈 `-apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`；等宽 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`；容器最大宽度 1120px；`prefers-reduced-motion` 下关闭动画。

- [ ] **Step 5: 写 `site/main.js` 空壳**

导出 `initCopyButton()` 与 `initTyping()` 两个函数并在 `DOMContentLoaded` 调用；此时函数体为空。

- [ ] **Step 6: 运行验收**

Run: `node scripts/check-site.mjs`
Expected: `site ok`。

- [ ] **Step 7: 提交**

```bash
git add scripts/check-site.mjs site
git commit -m "feat: scaffold the site and its acceptance checker"
```

---

### Task 5: 首屏、终端演示与复制按钮

**Files:**
- Modify: `site/index.html`（`#hero`、`#terminal`）
- Modify: `site/styles.css`
- Modify: `site/main.js`
- Modify: `scripts/check-site.mjs`（新增断言）

- [ ] **Step 1: 先加断言（RED）**

检查 `#hero` 含：`用一条长连接`、`npm install uitest-sdk`、`assets/screen-home.jpg`、`https://github.com/growvv/uitest-sdk`、`id="copy-install"`；`#terminal` 含 `class="term-line"` 至少 5 个。

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/check-site.mjs`
Expected: 退出码 1，提示 hero 缺少文案。

- [ ] **Step 3: 实现首屏**

H1 `用一条长连接，控制鸿蒙设备`；英文 tagline `UI automation, screenshots and H.264 casting for HarmonyOS — from Node.js.`；副标题一句话概述；代码块 `npm install uitest-sdk` + `<button id="copy-install">复制</button>`；CTA：`开始使用`（`#quickstart`）与 `GitHub`；右侧 `<img src="assets/screen-home.jpg" alt="真机截图">`。

- [ ] **Step 4: 实现终端演示**

`#terminal` 内 5 行 `.term-line`，逐行：
```
$ npm install uitest-sdk
$ node quickstart.mjs
✓ connected  BRA-AL00 · 1216×2688
✓ click(608, 1344)                 32 ms
✓ captureScreen() → 608×1344 JPEG  118 ms
```

- [ ] **Step 5: 实现 `main.js` 行为**

`initTyping()`：用 `IntersectionObserver` 在终端进入视口后逐字显示，每字 18ms。`initCopyButton()`：写入剪贴板并把按钮文字改为 `已复制` 2 秒。`prefers-reduced-motion` 时直接全部显示。

- [ ] **Step 6: 运行验收 + 截图目检**

Run:
```bash
node scripts/check-site.mjs
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --screenshot=.work/site-hero.png --window-size=1440,1100 "file:///E:/CodeE/vibe51/uitest_agent/site/index.html"
```
Expected: `site ok`；打开 `.work/site-hero.png` 目检：首屏为深色、标题与截图并排、无横向滚动。

- [ ] **Step 7: 提交**

```bash
git add site scripts/check-site.mjs
git commit -m "feat: add hero and terminal demo"
```

---

### Task 6: 实测性能表与能力网格

**Files:**
- Modify: `site/index.html`（`#bench`、`#features`）
- Modify: `site/styles.css`
- Modify: `scripts/check-site.mjs`

- [ ] **Step 1: 先加断言（RED）**

`#bench` 含 `107–193 ms`、`21–50 ms`、`386–640 ms`、`15–89 fps`、`10–16 fps`；`#features` 中 `<article class="card">` 恰好 8 个。

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/check-site.mjs` → 退出码 1。

- [ ] **Step 3: 实现性能表**

表格 5 行：整屏截图 `captureScreen()` 107–193 ms；点击 `click(x, y)` 21–50 ms；滑动 `swipe()` 386–640 ms；MJPEG 流 `streamScreen()` 10–16 fps；H.264 投流 `createCast()` 15–89 fps。表头「能力 / API / 实测」；在表格下方注明「真机 BRA-AL00，1216×2688，uitest 7.0.0.1」。

- [ ] **Step 4: 实现 8 张能力卡**

一条长连接（串行队列 + 指数退避）／毫秒级点击（Gestures 三段式）／整屏截图（起停驱动）／窗口截图（整屏 + bounds 裁剪）／H.264 投流（gRPC）／MP4 录制／多实例安全（复用 daemon，绝不盲杀）／失败即报错（`UitestError`，不静默兜底）。每卡含标题与一句话。

- [ ] **Step 5: 运行验收**

Run: `node scripts/check-site.mjs` → `site ok`。

- [ ] **Step 6: 提交**

```bash
git add site scripts/check-site.mjs
git commit -m "feat: add measured performance table and capability grid"
```

---

### Task 7: 架构图、已知限制、视频区、页脚与响应式

**Files:**
- Modify: `site/index.html`（`#arch`、`#video`、`#limits`、footer）
- Modify: `site/styles.css`
- Modify: `scripts/check-site.mjs`

- [ ] **Step 1: 先加断言（RED）**

`#arch` 含 `<svg` 与 `agent.so`、`libscreen_casting.z.so`；`#limits` 含至少 5 个 `<li>`；页面含 `<video` 且带 `controls`、`playsinline`、`poster="assets/demo-poster.jpg"`、`src="assets/demo.mp4"`，且**不含 `autoplay`**；`<footer>` 含 `MIT` 与 GitHub 链接。（`demo.mp4` 的存在性检查在 Task 8 加入。）

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/check-site.mjs` → 退出码 1。

- [ ] **Step 3: 实现架构区**

内联 SVG 两条通道：`Node 进程 → hdc fport → agent.so:8012（JSON + JPEG，长连接）` 与 `Node 进程 → hdc fport → libscreen_casting.z.so（gRPC，H.264）`；配一句「一条长连接做 UI 自动化，一条 gRPC 通道做投流与录制」。

- [ ] **Step 4: 实现限制与视频区、页脚**

`#limits` 列出 5 条与 README 一致的已知限制；`#video` 放 `<video src="assets/demo.mp4" poster="assets/demo-poster.jpg" controls playsinline preload="metadata">`；页脚 `MIT · GitHub · 文档 · © 2026 uitest-sdk`。

- [ ] **Step 5: 响应式与动效**

`max-width: 1024px` 以下首屏单列；表格外层 `overflow-x:auto`；卡片网格 `repeat(auto-fit, minmax(260px, 1fr))`；所有入场动画包在 `@media (prefers-reduced-motion: no-preference)` 内。

- [ ] **Step 6: 运行验收 + 两种宽度目检**

Run:
```bash
node scripts/check-site.mjs
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --screenshot=.work/site-1440.png --window-size=1440,3600 "file:///E:/CodeE/vibe51/uitest_agent/site/index.html"
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --screenshot=.work/site-375.png --window-size=375,2400 "file:///E:/CodeE/vibe51/uitest_agent/site/index.html"
```
Expected: `site ok`；两张截图中都无横向溢出，375px 下首屏标题完整可见。

- [ ] **Step 7: 提交**

```bash
git add site scripts/check-site.mjs
git commit -m "feat: add architecture, limitations, video and footer"
```

---

### Task 8: Remotion 视频

**Files:**
- Create: `video/package.json`、`video/tsconfig.json`、`video/remotion.config.ts`
- Create: `video/src/index.ts`、`video/src/Root.tsx`、`video/src/theme.ts`
- Create: `video/src/scenes/{Title,Terminal,CodeShot,Cast,Outro}.tsx`
- Create: `video/public/screen-home.jpg`（从 `site/assets/` 复制）
- Create: `site/assets/demo.mp4`、`site/assets/demo-poster.jpg`
- Modify: `scripts/check-site.mjs`（mp4 断言）
- Modify: `.gitignore`（`video/node_modules/`、`video/out/`）

**Interfaces:**
- Produces: composition id `UiTestSdkDemo`，1920×1080、30fps、900 帧。

- [ ] **Step 1: 搭工程**

`video/package.json` 依赖 `remotion@^4`、`@remotion/cli@^4`、`react@^18`、`react-dom@^18`、`typescript`、`@types/react`；脚本 `"render": "remotion render src/index.ts UiTestSdkDemo out/demo.mp4 --codec=h264"`、`"still": "remotion still src/index.ts UiTestSdkDemo out/poster.jpg --frame=60"`。

- [ ] **Step 2: 安装并确认识别**

Run: `cd video && npm install && npx remotion compositions src/index.ts`
Expected: 列出 `UiTestSdkDemo  1920x1080  30fps  900 frames`。

- [ ] **Step 3: 实现五个场景（先失败再通过）**

先写 `Root.tsx` 注册 900 帧的 composition，五个 `Sequence` 占位为纯色；`npx remotion compositions` 通过后再逐个实现：

- `Title`（0–120）：`uitest-sdk` + `用一条长连接，控制鸿蒙设备` + `Node.js · TypeScript · HarmonyOS`，spring 入场。
- `Terminal`（120–300）：终端窗口，五行命令按帧逐个字符显示。
- `CodeShot`（300–540）：左侧 6 行 TS 代码，右侧手机框内的 `screen-home.jpg` 上滑入场。
- `Cast`（540–780）：数字从 15 滚到 89，标签 `fps · H.264 投流`、`MP4 录制`。
- `Outro`（780–900）：六个能力 chip 快闪 + `github.com/growvv/uitest-sdk`。

中文字体使用 `"Microsoft YaHei", "PingFang SC", sans-serif`。

- [ ] **Step 4: 渲染**

Run: `cd video && npm run render && npm run still`
Expected: 输出 `Rendered 900/900`，`video/out/demo.mp4` 与 `video/out/poster.jpg` 生成。

- [ ] **Step 5: 拷贝产物并加断言**

```bash
cp video/out/demo.mp4 site/assets/demo.mp4
cp video/out/poster.jpg site/assets/demo-poster.jpg
```
在 `check-site.mjs` 中新增：两个文件存在；`demo.mp4` 大于 500 KB；解析 MP4 的 `mvhd` box，时长在 29–31 秒之间。

- [ ] **Step 6: 运行验收**

Run: `node scripts/check-site.mjs`
Expected: `site ok`，并打印视频时长（如 `video 30.0s`）。

- [ ] **Step 7: 提交**

```bash
git add .gitignore video site/assets/demo.mp4 site/assets/demo-poster.jpg scripts/check-site.mjs
git commit -m "feat: add 30s Remotion promo video"
```

---

### Task 9: GitHub 发布与 Pages

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `README.md`（如 URL 有出入）

**Interfaces:**
- Consumes: `site/` 目录（Task 4–8 的产物）。
- Produces: `https://growvv.github.io/uitest-sdk/` 可访问。

- [ ] **Step 1: 写工作流**

```yaml
name: pages
on:
  push:
    branches: [master]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: 合并到 master 并再次全量验证**

Run:
```bash
npm test 2>&1 | tail -3
npm run test:device 2>&1 | tail -3
git checkout master && git merge feat/launch --no-edit
```
Expected: 单测 84 passed；设备 18 passed / 1 skipped；合并成功。

- [ ] **Step 3: 建仓库并推送**

Run:
```bash
gh repo create growvv/uitest-sdk --public --source . --remote origin --push \
  --description "HarmonyOS uitest extension SDK for Node.js: UI automation, screenshots, H.264 casting and MP4 recording"
```
Expected: 推送成功，`origin/master` 建立。

- [ ] **Step 4: 开启 Pages（工作流模式）**

Run: `gh api -X POST repos/growvv/uitest-sdk/pages -f build_type=workflow 2>/dev/null || gh api -X PUT repos/growvv/uitest-sdk/pages -f build_type=workflow`
Expected: 返回 JSON 含 `"build_type": "workflow"`。

- [ ] **Step 5: 等待部署并验证**

Run:
```bash
gh run list --workflow=pages --limit 1
gh run watch $(gh run list --workflow=pages --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
curl -sL -o /dev/null -w "%{http_code}\n" https://growvv.github.io/uitest-sdk/
curl -sL https://growvv.github.io/uitest-sdk/ | grep -c "用一条长连接"
```
Expected: 工作流成功；HTTP 200；标题出现至少 1 次。

- [ ] **Step 6: 仓库元数据与收尾**

Run:
```bash
gh repo edit --add-topic harmonyos,openharmony,uitest,automation,scrcpy,nodejs,typescript
git push origin master
```
Expected: topics 写入；工作区干净。

- [ ] **Step 7: 最终验收**

- [ ] 官网 URL 200，首屏、性能表、视频均可见
- [ ] `git log --all -S"<DEVICE_ID>"` 无输出
- [ ] `git ls-files assets` 含三个 `.so`
- [ ] `npm test` 84 passed、`npm run test:device` 18 passed / 1 skipped
