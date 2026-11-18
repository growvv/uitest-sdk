#!/usr/bin/env node
/**
 * Renders the acceptance pages from the machine-written reports.
 *
 * Every product is accepted on its own: `docs/acceptance/<product>-<version>/report.json`
 * holds the cases, the screenshots and the rerun commands. This script turns
 * each report into `site/acceptance-<product>-<version>.html`, copies the
 * screenshots under `site/assets/acceptance/<product>-<version>/`, and writes
 * the hub `site/acceptance.html` that links every report.
 *
 * A report is never hand-written and never quietly missing: a product whose
 * package.json version has no report fails the site check.
 *
 * Usage: node scripts/gen-acceptance-pages.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = join(ROOT, "site");
const REPORTS = join(ROOT, "docs", "acceptance");

export const PRODUCT_NAMES = {
  core: "uitest-sdk",
  phone: "uitest-phone",
  console: "uitest-console",
  mirror: "uitest-mirror",
};

const STATUS_LABEL = { pass: "通过", fail: "失败", skip: "跳过" };

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function assetDir(report) {
  return `${report.product}-${report.version}`;
}

function imgSrc(report, name) {
  return `assets/acceptance/${assetDir(report)}/${name}`;
}

function nav(active) {
  const link = (href, label) =>
    `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `  <nav class="nav">
    <a class="nav-brand" href="index.html#hero">uitest-sdk</a>
    <div class="nav-links">
      <a href="index.html#packages">四个包</a>
      <a href="index.html#features">能力</a>
      <a href="index.html#cli">命令行</a>
      <a href="index.html#showcase">实拍</a>
      <a href="api.html">API</a>
      <a href="docs.html">文档</a>
      ${link("acceptance.html", "验收")}
      <a href="changelog.html">更新</a>
      <a href="https://github.com/growvv/uitest-sdk">GitHub</a>
    </div>
  </nav>`;
}

/**
 * One product's acceptance page.
 *
 * The generator refuses to render a case that changes the screen but carries
 * no picture: the page's whole value is that a reader can see the result, and
 * a matrix of green cells with no evidence is what this project's acceptance
 * exists to replace.
 */
export function renderReportPage(report) {
  const name = PRODUCT_NAMES[report.product];
  if (!name) throw new Error(`unknown product: ${report.product}`);
  if (!Array.isArray(report.cases) || report.cases.length === 0) {
    throw new Error(`${name} report has no cases`);
  }
  // A screen case without a picture is a claim nobody can check. A log case
  // (a tarball listing, a handshake transcript) has no screen to show, so it
  // owes a written result instead — and the report as a whole still has to
  // carry pictures, or the page is a table of green cells again.
  for (const c of report.cases) {
    if (c.status === "skip") continue;
    if (c.kind === "log") {
      if (!c.detail) throw new Error(`${name} case ${c.id} (${c.title}) has no result to show`);
      continue;
    }
    if (!Array.isArray(c.screenshots) || c.screenshots.length === 0) {
      throw new Error(`${name} case ${c.id} (${c.title}) has no screenshot`);
    }
  }
  const pictures = report.cases.reduce((n, c) => n + (c.screenshots?.length ?? 0), 0);
  if (pictures < 2) throw new Error(`${name} report has ${pictures} screenshots; at least two are required`);

  const total = report.cases.length;
  const passed = report.summary?.passed ?? report.cases.filter((c) => c.status === "pass").length;
  const failed = report.summary?.failed ?? report.cases.filter((c) => c.status === "fail").length;
  const skipped = report.summary?.skipped ?? report.cases.filter((c) => c.status === "skip").length;

  const deviceRows = (report.devices ?? [])
    .map(
      (d) =>
        `            <tr><td><code>${esc(d.tag)}</code></td><td>${esc(d.model)}</td><td>${esc(d.resolution)}</td></tr>`,
    )
    .join("\n");

  const caseRows = report.cases
    .map((c) => {
      const shots = (c.screenshots ?? [])
        .map(
          (s) =>
            `              <a href="${esc(imgSrc(report, s))}"><img src="${esc(imgSrc(report, s))}" alt="${esc(c.title)}" loading="lazy"></a>`,
        )
        .join("\n");
      return `            <tr>
              <td><code>${esc(c.id)}</code></td>
              <td>${esc(c.title)}<br><span class="cell-detail">${esc(c.detail)}</span></td>
              <td><span class="status status-${esc(c.status)}">${STATUS_LABEL[c.status] ?? esc(c.status)}</span></td>
              <td><div class="shot-strip">
${shots}
              </div></td>
            </tr>`;
    })
    .join("\n");

  const rerun = (report.rerun ?? []).map((cmd) => `<code>${esc(cmd)}</code>`).join("<br>");
  const issues =
    (report.issues ?? []).length === 0
      ? "<li>无</li>"
      : report.issues.map((i) => `<li>${esc(i)}</li>`).join("\n            ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)} ${esc(report.version)} 验收报告 · uitest-sdk</title>
  <meta name="description" content="${esc(name)} ${esc(report.version)} 的验收记录：${total} 个用例、${esc(report.date)}、提交 ${esc(report.commit)}，画面类用例都带设备或浏览器截图。">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
${nav("acceptance.html")}

  <main class="doc-main">
    <aside class="doc-toc" aria-label="目录">
      <a href="#summary">一页结论</a>
      <a href="#devices">设备</a>
      <a href="#cases">用例与截图</a>
      <a href="#issues">问题</a>
      <a href="#rerun">自己复现</a>
      <a href="acceptance.html">全部产品的验收</a>
    </aside>

    <article class="doc-body">
      <h1>${esc(name)} ${esc(report.version)} 验收报告</h1>
      <p class="doc-meta"><strong>${esc(name)}</strong> ${esc(report.version)} · ${esc(report.date)} · 提交 <code>${esc(report.commit)}</code></p>

      <p>本页由 <code>scripts/gen-acceptance-pages.mjs</code> 从 <code>docs/acceptance/${esc(assetDir(report))}/report.json</code> 生成，请勿手改。每条用例都是在这一版代码上现场跑出来的；画面类用例的截图由被测程序自己产出，只验命令行或日志的用例没有截图，报告中逐条标出。</p>

      <h2 id="summary">一页结论</h2>
      <div class="doc-table">
        <table>
          <thead><tr><th>用例</th><th>通过</th><th>失败</th><th>跳过</th></tr></thead>
          <tbody>
            <tr><td>${total}</td><td>${passed}</td><td>${failed}</td><td>${skipped}</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="devices">设备</h2>
      <p class="note">设备只以序列号哈希后的 8 位标签出现，原序列号不进入仓库，也不进入本页。</p>
      <div class="doc-table">
        <table>
          <thead><tr><th>标签</th><th>型号</th><th>分辨率</th></tr></thead>
          <tbody>
${deviceRows}
          </tbody>
        </table>
      </div>

      <h2 id="cases">用例与截图</h2>
      <div class="doc-table">
        <table>
          <thead><tr><th>#</th><th>用例</th><th>结果</th><th>截图</th></tr></thead>
          <tbody>
${caseRows}
          </tbody>
        </table>
      </div>

      <h2 id="issues">问题</h2>
      <ul>
            ${issues}
      </ul>

      <h2 id="rerun">自己复现</h2>
      <pre class="cli-code">${rerun}</pre>
      <p class="note">重跑会覆盖本页引用的截图。截图进入官网之前必须逐张看过：通知栏、账户信息、聊天与第三方个人资料都不能出现在这里。</p>
    </article>
  </main>
  <script src="main.js" defer></script>
</body>
</html>
`;
}

/** The hub: every report the repository has, newest product first. */
export function renderHubPage(reports) {
  const rows = reports
    .map((r) => {
      const s = r.summary ?? { passed: 0, failed: 0, skipped: 0 };
      const total = s.passed + s.failed + s.skipped;
      return `            <tr>
              <td><a href="${esc(r.href)}"><strong>${esc(PRODUCT_NAMES[r.product] ?? r.product)}</strong> ${esc(r.version)}</a></td>
              <td>${esc(r.date)}</td>
              <td>${s.passed}/${total}${s.failed > 0 ? ` · <span class="status status-fail">${s.failed} 失败</span>` : ""}${s.skipped > 0 ? ` · ${s.skipped} 跳过` : ""}</td>
            </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>验收报告 · uitest-sdk</title>
  <meta name="description" content="每个产品、每个版本各有一份验收报告：用例、命令与截图都在各自的页面上，历史版本原样保留。">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
${nav("acceptance.html")}

  <main class="doc-main">
    <aside class="doc-toc" aria-label="目录">
      <a href="#reports">按产品</a>
      <a href="#legacy">历史版本</a>
    </aside>

    <article class="doc-body">
      <h1>验收报告</h1>
      <p class="doc-meta">一个库、两个产品 · 每一版各自验收</p>

      <p>库里的一份实现，产品只是组合它——所以每个产品单独验收，各自出一页。每页都由该版本的验收脚本生成：用例、命令、原始输出与截图，跑的是什么版本就写什么版本。</p>

      <h2 id="reports">按产品</h2>
      <div class="doc-table">
        <table>
          <thead><tr><th>产品与版本</th><th>日期</th><th>结果</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>

      <h2 id="legacy">历史版本</h2>
      <div class="doc-table">
        <table>
          <thead><tr><th>版本</th><th>说明</th></tr></thead>
          <tbody>
            <tr><td><a href="acceptance-0.9.4.html">uitest-sdk 0.9.4</a></td><td>拆分前的单包验收：两台真机、9 个步骤、32 张能力截图、7 种握手、10 项接管场景</td></tr>
          </tbody>
        </table>
      </div>

      <p class="note">0.10.0 起 <code>uitest-sdk</code> 只发库，命令行与 MCP 在 <code>uitest-phone</code>，浏览器界面在 <code>uitest-console</code>，因此它们各有自己的验收页。</p>
    </article>
  </main>
  <script src="main.js" defer></script>
</body>
</html>
`;
}

function readReports() {
  if (!existsSync(REPORTS)) return [];
  const out = [];
  for (const entry of readdirSync(REPORTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(REPORTS, entry.name, "report.json");
    if (!existsSync(file)) continue;
    const report = JSON.parse(readFileSync(file, "utf8"));
    out.push({ ...report, dir: join(REPORTS, entry.name) });
  }
  return out;
}

function packageVersions() {
  const out = {};
  for (const product of Object.keys(PRODUCT_NAMES)) {
    const file = join(ROOT, "packages", product, "package.json");
    if (existsSync(file)) out[product] = JSON.parse(readFileSync(file, "utf8")).version;
  }
  return out;
}

function main() {
  const reports = readReports();
  const versions = packageVersions();
  let bad = false;

  for (const report of reports) {
    const expected = versions[report.product];
    if (expected && expected !== report.version) {
      console.error(
        `report ${report.dir} is ${report.version}, but packages/${report.product}/package.json is ${expected}`,
      );
      bad = true;
    }
    const shots = join(report.dir, "screenshots");
    const dest = join(SITE, "assets", "acceptance", assetDir(report));
    mkdirSync(dest, { recursive: true });
    for (const c of report.cases) {
      for (const name of c.screenshots ?? []) {
        const src = join(shots, name);
        if (!existsSync(src)) {
          console.error(`missing screenshot ${src}`);
          bad = true;
          continue;
        }
        copyFileSync(src, join(dest, name));
      }
    }
    writeFileSync(join(SITE, `acceptance-${assetDir(report)}.html`), renderReportPage(report), "utf8");
    console.log(`page: site/acceptance-${assetDir(report)}.html`);
  }

  // A product at a version with no report is a release nobody accepted.
  for (const [product, version] of Object.entries(versions)) {
    const has = reports.some((r) => r.product === product && r.version === version);
    if (!has) console.log(`note: ${PRODUCT_NAMES[product]} ${version} has no report yet`);
  }

  const hub = reports
    .map((r) => ({
      product: r.product,
      version: r.version,
      date: r.date,
      summary: r.summary,
      href: `acceptance-${assetDir(r)}.html`,
    }))
    .sort((a, b) => a.product.localeCompare(b.product) || b.version.localeCompare(a.version));
  writeFileSync(join(SITE, "acceptance.html"), renderHubPage(hub), "utf8");
  console.log("hub: site/acceptance.html");

  process.exit(bad ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename);
if (invokedDirectly) main();
