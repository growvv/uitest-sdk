#!/usr/bin/env node
/**
 * Acceptance checker for the static site. Every assertion the site must keep
 * living here — later tasks add to this file, they never change how it runs.
 *
 * Usage: node scripts/check-site.mjs
 * Prints `site ok` and exits 0 on success; prints the first failure and
 * exits 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
/** SITE_DIR exists so the checker itself can be run against broken copies. */
const SITE = resolve(process.env.SITE_DIR ?? join(ROOT, "site"));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------- the files
const files = ["index.html", "docs.html", "changelog.html", "styles.css", "main.js"];
for (const f of files) {
  const p = join(SITE, f);
  if (!existsSync(p) || !statSync(p).isFile()) fail(`missing site/${f}`);
}
const html = readFileSync(join(SITE, "index.html"), "utf8");
const docsHtml = readFileSync(join(SITE, "docs.html"), "utf8");
const logHtml = readFileSync(join(SITE, "changelog.html"), "utf8");
const css = readFileSync(join(SITE, "styles.css"), "utf8");
const js = readFileSync(join(SITE, "main.js"), "utf8");
const pages = [
  ["index.html", html],
  ["docs.html", docsHtml],
  ["changelog.html", logHtml],
];

// ------------------------------------------------------------------- anchors
const sections = ["hero", "terminal", "cli", "bench", "compare", "features", "arch", "video", "limits"];
for (const id of sections) {
  if (!new RegExp(`\\bid\\s*=\\s*"${id}"`).test(html)) fail(`index.html is missing id="${id}"`);
}

// ------------------------------------------- local references must exist
for (const [name, text] of pages) {
  for (const [, value] of text.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
    if (value.startsWith("//")) fail(`${name} has a protocol-relative reference: ${value}`);
    // A leading slash resolves against the server root, so it 404s on file://.
    if (value.startsWith("/")) fail(`${name} has an absolute local reference: ${value}`);
    if (!value || value.startsWith("http") || value.startsWith("#") || value.startsWith("mailto:")) continue;
    const clean = value.split("#")[0].split("?")[0];
    if (!clean) continue;
    const target = join(SITE, clean);
    if (!existsSync(target)) fail(`${name} references a missing file: ${value}`);
  }
}

// --------------------------------------------------- zero external requests
const forbidden = [
  [/src\s*=\s*"https?:/i, "an external script or image src"],
  [/src\s*=\s*"\/\//i, "a protocol-relative src"],
  [/srcset\s*=\s*"[^"]*(?:https?:|\/\/)/i, "an external srcset entry"],
  [/<link[^>]*href\s*=\s*"(?:https?:)?\/\//i, "an external <link>"],
  [/url\(\s*['"]?(?:https?:)?\/\//i, "an external url() in CSS"],
  [/@import\s+(?:url\(\s*)?['"]?(?:https?:)?\/\//i, "an external @import in CSS"],
  [/fetch\(\s*['"]https?:/i, "an external fetch() in JS"],
  [/\bnew\s+WebSocket\(\s*['"]wss?:/i, "an external WebSocket in JS"],
];
for (const [re, what] of forbidden) {
  for (const [name, text] of [...pages, ["styles.css", css], ["main.js", js]]) {
    if (re.test(text)) fail(`${name} contains ${what}`);
  }
}

// ------------------------------------------------------------ section text
function sectionHtml(id) {
  const m = html.match(new RegExp(`<section[^>]*\\bid\\s*=\\s*"${id}"[^>]*>([\\s\\S]*?)</section>`));
  return m ? m[1] : "";
}

// -------------------------------------------------------- task 5: hero + demo
const hero = sectionHtml("hero");
for (const needle of [
  "用一条长连接",
  "npm install uitest-sdk",
  "assets/screen-home.jpg",
  "https://github.com/growvv/uitest-sdk",
  'id="copy-install"',
]) {
  if (!hero.includes(needle)) fail(`#hero 缺少「${needle}」`);
}

const terminal = sectionHtml("terminal");
const termLines = (terminal.match(/class="term-line"/g) ?? []).length;
if (termLines < 5) fail(`#terminal 只有 ${termLines} 行 .term-line，至少需要 5 行`);

// -------------------------------------------- 0.2.0: the CLI and the agent
// The release that made the package usable without writing code. The page
// must name the commands, the status model, and both agent entry points; a
// visitor who reads only this section should be able to drive a phone.
const cli = sectionHtml("cli");
for (const needle of [
  "uitest-phone",
  "npx uitest-sdk",
  "observe",
  "tap",
  "read-list",
  "scroll-until",
  "pinch",
  "window",
  "apps --current",
  "report",
  "settled",
  "not_found",
  "approval_pending",
  "lease_held",
  "uitest-sdk mcp",
  "uitest-sdk install-skill",
  "refs-&lt;hash&gt;.json",
  // The two agent setups and the takeover, which 0.2.0 did not have.
  "uitest-sdk connect",
  "~/.agents/skills",
  "uitest-phone hold",
  "resume",
  "正在运行的 MCP 会话",
  "lease_held</code></td><td>2",
]) {
  if (!cli.includes(needle)) fail(`#cli 缺少「${needle}」`);
}
// Every one of the 19 commands must be reachable from the page, either in the
// section's table or in its example.
for (const name of [
  "observe", "tap", "type", "swipe", "double-click", "drag", "fling", "pinch",
  "key", "wait-for", "read-list", "scroll-until", "launch", "apps", "window",
  "doctor", "screenshot", "report", "status",
]) {
  if (!cli.includes(name)) fail(`#cli 没有列出命令 ${name}`);
}
// The CLI numbers are wall-clock time per command on a real phone, measured
// on 2026-11-16. They include device open, one step, settle and release.
for (const needle of ["1.2 s", "1.7 s", "2.3 s"]) {
  if (!cli.includes(needle)) fail(`#cli 缺少实测耗时「${needle}」`);
}

// ------------------------------------------------------- task 6: numbers
const bench = sectionHtml("bench");
for (const needle of ["107–193 ms", "21–50 ms", "386–640 ms", "15–89 fps", "10–16 fps"]) {
  if (!bench.includes(needle)) fail(`#bench 缺少实测数字「${needle}」`);
}
// The comparison with the hdc CLI and with the other capture methods is the
// section's whole point: the SDK's speed only means something next to what a
// caller would otherwise pay. The ratios come from scripts/bench-compare.ts.
for (const needle of ["hdc CLI", "CLI / SDK", "59.0×", "6.9×", "4.5×", "snapshot_display", "1.4 fps"]) {
  if (!bench.includes(needle)) fail(`#bench 缺少对比项「${needle}」`);
}

// The head-to-head section is the one the README and the video both promise:
// official capture path 675 ms vs agent MJPEG 178 ms, dumpLayout vs
// captureLayout, the equal-RPC row, and recording on 6.8 where 7.0 broke.
const compare = sectionHtml("compare");
for (const needle of [
  "snapshot_display",
  "675 ms",
  "178 ms",
  "3.8×",
  "dumpLayout",
  "captureLayout",
  "快 2 倍以上",
  "持平",
  "6.8 casting",
  "7.0.0.1",
  "完整功能矩阵",
  "UitestError",
]) {
  if (!compare.includes(needle)) fail(`#compare 缺少「${needle}」`);
}

const features = sectionHtml("features");
const cards = (features.match(/<article class="card">/g) ?? []).length;
if (cards !== 11) fail(`#features 有 ${cards} 张 .card，必须恰好 11 张`);
// The last two cards are the agent setup and the takeover; the page must not
// claim an agent can be wired up without saying how a person takes the phone.
for (const needle of ["人随时接管", "lease_held", "resume"]) {
  if (!features.includes(needle)) fail(`#features 缺少「${needle}」`);
}

// ------------------------------------------------------------ task 8: video
for (const name of ["demo.mp4", "demo-poster.jpg"]) {
  if (!existsSync(join(SITE, "assets", name))) fail(`missing site/assets/${name}`);
}
const mp4 = readFileSync(join(SITE, "assets", "demo.mp4"));
if (mp4.length < 500 * 1024) {
  fail(`demo.mp4 is only ${Math.round(mp4.length / 1024)} KB, expected over 500 KB`);
}

/** Walks the MP4 boxes in [start, end); yields { type, start, end } bodies. */
function* boxes(buf, start, end) {
  for (let i = start; i + 8 <= end; ) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) return;
    yield { type, start: i + header, end: i + size };
    i += size;
  }
}

function findBox(buf, from, to, type) {
  for (const box of boxes(buf, from, to)) if (box.type === type) return box;
  return null;
}

const moov = [...boxes(mp4, 0, mp4.length)].find((box) => box.type === "moov");
if (!moov) fail("demo.mp4 has no moov box");

const mvhd = findBox(mp4, moov.start, moov.end, "mvhd");
if (!mvhd) fail("demo.mp4 has no mvhd box");
const mvhdVersion = mp4[mvhd.start];
const timescale = mp4.readUInt32BE(mvhd.start + (mvhdVersion === 0 ? 12 : 20));
const duration =
  mvhdVersion === 0
    ? mp4.readUInt32BE(mvhd.start + 16)
    : Number(mp4.readBigUInt64BE(mvhd.start + 24));
const seconds = timescale ? duration / timescale : NaN;
if (!(seconds > 0 && seconds < 3600)) fail("demo.mp4 has an unparsable mvhd duration");
if (seconds < 29 || seconds > 31) fail(`demo.mp4 is ${seconds.toFixed(1)}s, expected 29–31s`);
console.log(`video ${seconds.toFixed(1)}s`);

// The spec wants 1920×1080 plus exactly one audio track carrying the BGM.
// No track means the generated soundtrack was dropped; two means something
// got mixed in twice. Either way the browser plays something other than the
// video that was reviewed.
let hasVideo = false;
let audioTracks = 0;
for (const trak of [...boxes(mp4, moov.start, moov.end)].filter((b) => b.type === "trak")) {
  const mdia = findBox(mp4, trak.start, trak.end, "mdia");
  const hdlr = mdia && findBox(mp4, mdia.start, mdia.end, "hdlr");
  const handler = hdlr ? mp4.toString("latin1", hdlr.start + 8, hdlr.start + 12) : "????";
  if (handler === "soun") {
    audioTracks++;
    continue;
  }
  if (handler !== "vide") continue;
  const tkhd = findBox(mp4, trak.start, trak.end, "tkhd");
  if (!tkhd) fail("demo.mp4 video track has no tkhd box");
  const w = mp4.readUInt32BE(tkhd.end - 8) / 65536;
  const h = mp4.readUInt32BE(tkhd.end - 4) / 65536;
  if (w !== 1920 || h !== 1080) fail(`demo.mp4 is ${w}x${h}, expected 1920x1080`);
  hasVideo = true;
}
if (!hasVideo) fail("demo.mp4 has no video track");
if (audioTracks !== 1) {
  fail(`demo.mp4 has ${audioTracks} audio tracks, expected exactly 1 (the BGM)`);
}

// ------------------------------------- task 7: architecture, limits, video
const arch = sectionHtml("arch");
for (const needle of ["<svg", "agent.so", "libscreen_casting.z.so"]) {
  if (!arch.includes(needle)) fail(`#arch 缺少「${needle}」`);
}

const limits = sectionHtml("limits");
const limitItems = (limits.match(/<li>/g) ?? []).length;
if (limitItems < 5) fail(`#limits 只有 ${limitItems} 条 <li>，至少需要 5 条`);

const videoTag = html.match(/<video\b[^>]*>/)?.[0] ?? "";
if (!videoTag) fail("页面缺少 <video>");
for (const attr of ["controls", "playsinline", 'poster="assets/demo-poster.jpg"', 'src="assets/demo.mp4"']) {
  if (!videoTag.includes(attr)) fail(`<video> 缺少 ${attr}`);
}
if (/autoplay/i.test(videoTag)) fail("<video> 不能自动播放");

const footer = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/)?.[1] ?? "";
if (!footer.includes("MIT") || !footer.includes("https://github.com/growvv/uitest-sdk")) {
  fail("<footer> 缺少 MIT 或 GitHub 链接");
}

// ------------------------------------------------- docs and release pages
// The usage documentation must be a real page on this site, not a link to a
// markdown file in the repository (the site has to work on its own).
for (const needle of [
  "Device.connect",
  "AgentClient",
  "createCast",
  "captureScreen",
  "UitestError",
  "0.2.0",
  // The CLI half of the package is documented here, not only on the home page.
  "Session.open",
  "TraceRecorder",
  "uitest-phone",
  "mcp",
  // Both agent setups and the takeover must be described, not just the flags.
  "install-skill",
  "~/.agents/skills",
  "connect --agent codex",
  "hold",
  "resume",
  "held by a person",
  "抢走正在运行的任务",
]) {
  if (!docsHtml.includes(needle)) fail(`docs.html 缺少「${needle}」`);
}
if (docsHtml.length < 8000) fail(`docs.html is only ${docsHtml.length} bytes; expected the full usage guide`);

for (const needle of [
  "0.2.0",
  "0.1.0",
  "2026-11-15",
  "2026-11-16",
  "0.0.0-stage",
  "计划中",
  "59.0×",
  "3.8×",
  // 0.2.0 must name both agent entry points and its four fixes.
  "install-skill",
  "mcp",
  "--read-only",
  "同一毫秒",
  // Unreleased: the default approval set, the takeover, and one-step connect.
  "未发布",
  "删除与发送默认要审批",
  "held by a person",
  "uitest-phone connect",
  "~/.agents/skills",
  "A person is using the phone",
  "抢走正在运行的任务",
]) {
  if (!logHtml.includes(needle)) fail(`changelog.html 缺少「${needle}」`);
}
for (const href of ['href="docs.html"', 'href="changelog.html"']) {
  if (!html.includes(href)) fail(`index.html 没有链接到 ${href}`);
}

// ----------------------------------------------- task 10: the script runs
// main.js is loaded as a classic script. A top-level `export` is a syntax
// error there and kills every behaviour on the page; ES modules would fix
// that but Chrome blocks them on file://, which the spec requires to work.
if (/^\s*export\s/m.test(js)) {
  fail("main.js has a top-level export; it is loaded as a classic script and cannot use module syntax");
}

const chromePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));

if (!chromePath) {
  console.log("runtime skipped (no Chrome found)");
} else {
  for (const [name] of pages) {
    const dom = execFileSync(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--virtual-time-budget=2000",
        "--dump-dom",
        pathToFileURL(join(SITE, name)).href,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (!/<html[^>]*class="[^"]*\bjs-ready\b/.test(dom)) {
      fail(`main.js did not run in the browser on ${name} (no js-ready class on <html>)`);
    }
  }
  console.log("runtime ok");
}

console.log("site ok");
