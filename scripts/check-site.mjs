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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
/**
 * The version the site must document, from the built package.
 *
 * Resolved here rather than written into the needle list: a hardcoded copy is
 * exactly how a release ships with the site still claiming the previous
 * version — the checker agreed with the stale page. It comes from `dist/` so a
 * forgotten `npm run build` fails here too.
 */
const { VERSION } = await import(pathToFileURL(join(ROOT, "packages", "core", "dist", "version.js")).href).catch(
  () => fail("dist/version.js is missing; run npm run build first"),
);
/** SITE_DIR exists so the checker itself can be run against broken copies. */
const SITE = resolve(process.env.SITE_DIR ?? join(ROOT, "site"));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------- the files
const files = [
  "index.html",
  "docs.html",
  "changelog.html",
  "api.html",
  "acceptance.html",
  "acceptance-0.9.4.html",
  "styles.css",
  "main.js",
];
for (const f of files) {
  const p = join(SITE, f);
  if (!existsSync(p) || !statSync(p).isFile()) fail(`missing site/${f}`);
}
const html = readFileSync(join(SITE, "index.html"), "utf8");
const docsHtml = readFileSync(join(SITE, "docs.html"), "utf8");
const logHtml = readFileSync(join(SITE, "changelog.html"), "utf8");
const apiHtml = readFileSync(join(SITE, "api.html"), "utf8");
// 0.10.0: acceptance.html became the hub; the single-package record it used to
// hold is kept verbatim as the historical 0.9.4 page.
const acceptHtml = readFileSync(join(SITE, "acceptance-0.9.4.html"), "utf8");
const hubHtml = readFileSync(join(SITE, "acceptance.html"), "utf8");
const css = readFileSync(join(SITE, "styles.css"), "utf8");
const js = readFileSync(join(SITE, "main.js"), "utf8");
const pages = [
  ["index.html", html],
  ["docs.html", docsHtml],
  ["changelog.html", logHtml],
  ["api.html", apiHtml],
  ["acceptance.html", hubHtml],
  ["acceptance-0.9.4.html", acceptHtml],
];

// ------------------------------------------------------------------- anchors
const sections = ["hero", "packages", "terminal", "cli", "control", "showcase", "bench", "compare", "codec", "features", "arch", "video", "limits"];
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
function sectionHtml(id, text = html) {
  const m = text.match(new RegExp(`<section[^>]*\\bid\\s*=\\s*"${id}"[^>]*>([\\s\\S]*?)</section>`));
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
  "npx uitest-phone",
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
  "uitest-phone mcp",
  "uitest-phone install-skill",
  "refs-&lt;hash&gt;.json",
  // The two agent setups and the takeover, which 0.2.0 did not have.
  "uitest-phone connect",
  "~/.agents/skills",
  "uitest-phone hold",
  "resume",
  "handoff --reason",
  "正在运行的 MCP 会话",
  "凭据不外泄",
  "宿主侧不常驻",
  // 0.7.0: the live page is a person's tool, so the home page must say what it
  // shows, that masking is on by default, and what the state machine does.
  // 0.10.0: that page is now the uitest-console product.
  "uitest-console",
  "WebCodecs",
  "18.5 fps",
  "隐私开关默认打开",
  "decodeQueueSize",
  "lease_held</code></td><td>2",
]) {
  if (!cli.includes(needle)) fail(`#cli 缺少「${needle}」`);
}
// Every one of the 19 commands must be reachable from the page, either in the
// section's table or in its example.
for (const name of [
  "observe", "tap", "type", "swipe", "double-click", "drag", "fling", "pinch",
  "key", "wait-for", "read-list", "scroll-until", "launch", "apps", "window",
  "doctor", "screenshot", "inspect", "report", "status", "handoff",
]) {
  if (!cli.includes(name)) fail(`#cli 没有列出命令 ${name}`);
}
// The CLI numbers are wall-clock time per command on a real phone, measured
// on 2026-11-16. They include device open, one step, settle and release.
for (const needle of ["1.2 s", "1.7 s", "2.3 s"]) {
  if (!cli.includes(needle)) fail(`#cli 缺少实测耗时「${needle}」`);
}

// ------------------------------------------------- 0.9.0: the control demo
// Takeover is the release's headline feature, and prose cannot show what it
// feels like. The section plays four frames captured on a real phone, so the
// page must carry all four, name the gestures, and degrade to a still frame.
const control = sectionHtml("control");
for (const needle of [
  "接管",
  "assets/control/1-feed.jpg",
  "assets/control/2-article.jpg",
  "assets/control/3-search.jpg",
  "assets/control/4-image.jpg",
  "assets/control/5-zoomed.jpg",
  "data-control-demo",
  "知乎",
]) {
  if (!control.includes(needle)) fail(`#control 缺少「${needle}」`);
}
// The frames are the evidence: a placeholder would be tiny next to the real
// 608×1144 captures, and a missing file would 404 on the deployed site.
for (const name of ["1-feed.jpg", "2-article.jpg", "3-search.jpg", "4-image.jpg", "5-zoomed.jpg"]) {
  const p = join(SITE, "assets", "control", name);
  if (!existsSync(p)) fail(`missing site/assets/control/${name}`);
  const size = statSync(p).size;
  if (size < 40 * 1024) fail(`assets/control/${name} is only ${Math.round(size / 1024)} KB`);
}
// Five frames — four screens and the zoomed viewer — and the first one lit
// in the markup: with no JS (or reduced motion) the visitor still sees the
// feed, not an empty phone.
const frames = control.match(/class="control-frame[^"]*"/g) ?? [];
if (frames.length !== 5) fail(`#control 有 ${frames.length} 帧，应为 5 帧`);
if (!frames.some((c) => /\bis-on\b/.test(c))) fail("#control 没有默认点亮第一帧");
if (!/<ol class="control-steps">/.test(control)) fail("#control 缺少步骤列表");
const controlList = control.match(/<ol class="control-steps">([\s\S]*?)<\/ol>/)?.[1] ?? "";
const controlSteps = (controlList.match(/<li\b/g) ?? []).length;
if (controlSteps !== 4) fail(`#control 的步骤有 ${controlSteps} 条，应为 4 条（一个手势一条）`);
// The gesture vocabulary is the claim; naming it keeps the section honest
// about what a takeover actually supports.
for (const gesture of ["点击", "长按", "滚动", "双指缩放", "键盘"]) {
  if (!control.includes(gesture)) fail(`#control 没有提到手势「${gesture}」`);
}

// ------------------------------------------------------- task 6: numbers
const bench = sectionHtml("bench");
for (const needle of ["109–222 ms", "21–50 ms", "386–640 ms", "15–89 fps", "10–16 fps"]) {
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

// The transport/codec section answers the one question a person choosing a
// mirroring tool actually asks: is the pipeline faster than what else exists?
// It must name the competitors it read, carry our measured numbers, and be
// honest that the frame-rate ceiling is the device encoder.
const codec = sectionHtml("codec");
for (const needle of [
  // the competitors, by name
  "hscrcpy",
  "HOScrcpy",
  "HarmonyMirror",
  // their decode path, stated as the finding rather than a vague comparison
  "FFmpeg 软解",
  "VideoToolbox",
  // our path and the measured per-stage numbers
  "WebCodecs",
  "WebSocket",
  "12 µs",
  "1.57 ms",
  "2.46 ms",
  "777 fps",
  // the honest framing: the encoder is the ceiling, not the transport
  "瓶颈在编码器",
  // A mirror that hard-requires hardware decode is black on GPU-less boxes;
  // the page must say the browser chooses and falls back to software.
  "可退软解",
  "0/30 帧",
]) {
  if (!codec.includes(needle)) fail(`#codec 缺少「${needle}」`);
}
// The section is only trustworthy if it says where "未公开" comes from and
// what machine produced our numbers.
for (const needle of ["未公开", "Chrome 157"]) {
  if (!codec.includes(needle)) fail(`#codec 缺少出处说明「${needle}」`);
}
// The diagram is the deliverable, not decoration: three lanes, and the
// competitors' lanes must not be drawn in the accent colour.
if (!/<svg[^>]*class="arch-svg"/.test(codec)) fail("#codec 缺少链路图 SVG");
for (const lane of ["设备编码器", "WebCodecs", "VideoToolbox", "Python 桥接"]) {
  if (!codec.includes(lane)) fail(`#codec 的图缺少「${lane}」`);
}
const accentNodes = (codec.match(/class="node node-accent"/g) ?? []).length;
if (accentNodes !== 2) fail(`#codec 的图有 ${accentNodes} 个高亮节点，应为 2 个（WebSocket 与 WebCodecs）`);

// The showcase section sells the two features that are hard to describe in
// prose: live mirroring and the layout inspector. The screenshots must be the
// real pages, each overlay must pair a table row with a box on the picture,
// and the pairs must line up (equal counts) or the animation desynchronises.
const showcase = sectionHtml("showcase");
for (const needle of [
  "uitest-console",
  "inspect --html",
  "assets/showcase/live.jpg",
  "assets/showcase/inspect-panel.jpg",
  "tap --ref",
  "VideoDecoder",
  "mask credentials",
]) {
  if (!showcase.includes(needle)) fail(`#showcase 缺少「${needle}」`);
}
const shots = showcase.match(/<figure class="shot"[^>]*>/g) ?? [];
if (shots.length !== 2) fail(`#showcase 有 ${shots.length} 张 .shot，应为 2 张（投屏、布局面板）`);
for (const name of ["live.jpg", "inspect-panel.jpg"]) {
  const p = join(SITE, "assets", "showcase", name);
  if (!existsSync(p)) fail(`missing site/assets/showcase/${name}`);
  // A still that got replaced by a placeholder would be tiny; the real pages
  // are 1020 and 1280 px wide UI.
  if (statSync(p).size < 30 * 1024) fail(`assets/showcase/${name} is only ${Math.round(statSync(p).size / 1024)} KB`);
}
// The overlay rectangles are measured percentages of the screenshot. Replace
// the image and they silently point at the wrong pixels, so the declared
// width/height must match the file's real dimensions.
function jpegSize(path) {
  const b = readFileSync(path);
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
for (const [, src, w, h] of showcase.matchAll(/<img src="(assets\/showcase\/[^"]+)"[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/g)) {
  const size = jpegSize(join(SITE, src));
  if (!size) fail(`cannot read the dimensions of ${src}`);
  if (size.width !== Number(w) || size.height !== Number(h)) {
    fail(`${src} is ${size.width}x${size.height} but the markup says ${w}x${h}; the highlight percentages would be off`);
  }
}
const hlRows = (showcase.match(/class="hl hl-row/g) ?? []).length;
const hlBoxes = (showcase.match(/class="hl hl-box/g) ?? []).length;
if (hlRows < 3 || hlRows !== hlBoxes) {
  fail(`#showcase 的高亮不成对：${hlRows} 个行、${hlBoxes} 个框；每步需要一个行和一个框`);
}
// Every overlay rectangle is a measured percentage; a px value would not
// survive the responsive width change.
for (const [, style] of showcase.matchAll(/class="hl hl-(?:row|box)[^"]*" style="([^"]*)"/g)) {
  if (!/%/.test(style)) fail(`#showcase 的高亮用了非百分比坐标：${style}`);
}
// The caption steps and the highlight pairs must be the same length, or the
// last step shows a label with nothing lit.
for (const [, caption] of showcase.matchAll(/<p class="shot-step">([\s\S]*?)<\/p>/g)) {
  const steps = (caption.match(/<span/g) ?? []).length;
  if (steps < 3) fail(`#showcase 的说明只有 ${steps} 步，至少 3 步`);
}
const stepTotal = (showcase.match(/<p class="shot-step">[\s\S]*?<\/p>/g) ?? []).reduce(
  (n, block) => n + (block.match(/<span/g) ?? []).length,
  0,
);
if (stepTotal !== hlRows) fail(`#showcase 的说明共 ${stepTotal} 步，但高亮有 ${hlRows} 组`);

const features = sectionHtml("features");
const cards = (features.match(/<article class="card">/g) ?? []).length;
if (cards !== 12) fail(`#features 有 ${cards} 张 .card，必须恰好 12 张`);
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
  // 0.10.0: the page now documents the split, and the CLI history it used to
  // carry here lives in the changelog and in uitest-phone's own README.
  "0.10.0",
  "0.4.0",
  // The docs page states the version it documents; a release that forgets to
  // bump it leaves the page claiming an older package than npm has.
  "0.6.0",
  "0.7.0",
  VERSION,
  // Live mirroring is the release's headline: the docs must name the command,
  // the privacy switch and the fact that masking happens when the screen is
  // read rather than being painted over the video.
  "session.view.open",
  "WebCodecs",
  // The switch is an option on the call now, not a flag string.
  "privacy: false",
  "遮罩在读的时候完成",
  "12 µs/帧",
  "index.html#codec",
  "startViewerServer",
  "decodeQueueSize",
  // The 7.0 WebSocket transport is a user-visible option, not an internal
  // detail: the docs must name the flag and the one-daemon-per-client rule.
  'transport: "ws"',
  "wsExtension",
  "一个客户端独占一个 daemon",
  // Layout inspection is a user-visible capability of its own: the docs must
  // name the command, the ref numbering and the panel.
  "inspect",
  "layout.html",
  "编号就是 ref",
  // The thin wrappers are exported API, not internals.
  "dev.files",
  "CastConfig",
  "FpsMeter",
  // The CLI half is now a product, and the docs must say so rather than
  // presenting it as the library's own.
  "uitest-phone",
  "uitest-console",
  "npm i -g uitest-phone",
  "mcp",
  // Both agent setups and the takeover must be described, not just the flags.
  "install-skill",
  "~/.agents/skills",
  "connect --agent codex",
  "connect --agent gemini",
  "~/.copilot/mcp-config.json",
  "hold",
  "resume",
  "held by a person",
  "抢走正在运行的任务",
  "uitest_handoff",
  "handoff --reason",
  "凭据脱敏",
  "••••••",
  "device_locked",
  "device_needs_setup",
  "device_offline",
  "--approval-scope",
  "升级不需要重跑",
  // 0.9.0: the page can drive the phone, through a second lane.
  "接管",
  "openInput",
  "busy by",
  "3.9 ms",
]) {
  if (!docsHtml.includes(needle)) fail(`docs.html 缺少「${needle}」`);
}
if (docsHtml.length < 8000) fail(`docs.html is only ${docsHtml.length} bytes; expected the full usage guide`);
// The version needle above is satisfied by any mention, and the page mentions
// several releases. The header is the one that claims "this documents X", and
// it sat at 0.9.2 through a 0.9.3 release because the looser check passed on a
// feature tag further down the page.
if (!docsHtml.includes(`uitest-sdk <strong>${VERSION}</strong>`)) {
  fail(`docs.html does not claim to document ${VERSION} in its header`);
}

for (const needle of [
  // 0.11.0: the fourth product. The changelog has to name it, its install
  // line, and the two core capabilities it needed, because a reader on 0.10.1
  // cannot tell from "new features" whether their code changes.
  "0.11.0",
  "uitest-mirror",
  "uitest-console</code> 0.1.2",
  "uitest-phone</code> 0.10.2",
  "keepAwake",
  "maxSize",
  // 0.10.1: every product in the split has its own patch release, and the
  // changelog is the only page that says what changed in them. The fixes are
  // ones a person notices (a deny that did nothing, a screenshot path with no
  // file behind it), so the page has to name them rather than say "bug fixes".
  "0.10.1",
  "三个产品各自的修正",
  "uitest-console</code> 0.1.1",
  "重放会继续",
  // 0.10.0: the split. The changelog is where a reader upgrading from 0.9.4
  // looks, so the migration table has to be on the page.
  "0.10.0",
  "库与产品拆分",
  "uitest-phone mcp",
  "uitest-console",
  "Device.createCast(opts)",
  "openInputLane",
  "0.3.0",
  "0.4.0",
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
  // The roadmap must stay visibly labelled as not-a-promise.
  "未发布",
  "删除与发送默认要审批",
  "held by a person",
  "uitest-phone connect",
  "~/.agents/skills",
  "A person is using the phone",
  "抢走正在运行的任务",
  "Agent 可以请人接手",
  "uitest_handoff",
  "凭据在屏幕上也会被遮住",
  "更多 Agent 一步接好",
  "~/.copilot/mcp-config.json",
  "设备状态也有名字",
  "hdc list targets -v",
  "同一条审批可以记住",
  "--approval-scope task",
  "升级后 Skill 自己跟上",
  ".uitest-skill.json",
  // Screenshots and recording from the live page, and the fixes that came
  // with running two pages on one device. The version itself is VERSION.
  "截图与录屏、多实例",
  "durationMs",
  // 0.7.1: the decoder fixes, which are the reason this patch exists.
  "0.7.1",
  "投屏解码修复",
  "prefer-hardware",
  // 0.7.0: live mirroring, and the three defects the real device exposed.
  "0.7.0",
  "uitest-sdk live",
  "WebCodecs",
  "隐私开关",
  "redact: false",
  "marked as type key but wasn't a key frame",
  // The decoder-choice defect: hard-requiring hardware decode is a black
  // screen on GPU-less machines, and the changelog must record the fix.
  "解码器由浏览器挑",
  "重开解码器",
  // 0.9.3: the Origin check on the live WebSocket. This is the one release
  // whose subject is a security hole, so the page has to say what the hole was
  // and what the rule is — a reader who skips it keeps believing that opening
  // a random tab is safe.
  "0.9.3",
  "投屏页只接受自己的来源",
  "DNS rebinding",
  "Origin: null",
  "SECURITY.md",
  // 0.9.2: the package-quality pass. The changelog must record it, because
  // this is the release where the published numbers moved to match the report.
  "0.9.2",
  "对外文档与二进制声明",
  "NOTICE",
  // 0.9.1: the fixes the branch review and the release run turned up. The
  // changelog must record them, because two of them changed what a person
  // sees: their text no longer disappears on release.
  "0.9.1",
  "退出接管不再吞掉刚输入的字",
  "report-only.md",
  // 0.9.0: takeover, the second input lane, and the acceptance numbers.
  "0.9.0",
  "接管",
  "第二条通道",
  "换手",
  // 0.5.0: the complete hypium surface.
  "0.5.0",
  "完整 hypium API：118 个方法",
  "HYPIIUM_CATALOG",
  "UnsupportedError",
]) {
  if (!logHtml.includes(needle)) fail(`changelog.html 缺少「${needle}」`);
}

// The roadmap is the one section whose content expires on its own. 0.9.0
// shipped the takeover and this list kept advertising it for a whole release,
// because every check above only asks that things be present. This one asks
// that a shipped feature be gone.
const roadmap = sectionHtml("roadmap", logHtml);
if (!roadmap) fail("changelog.html has no #roadmap section");
for (const gone of ["点击交互", "画布上点一下"]) {
  if (roadmap.includes(gone)) {
    fail(`#roadmap still lists 「${gone}」 as planned; it shipped in 0.9.0`);
  }
}
for (const href of ['href="docs.html"', 'href="changelog.html"', 'href="api.html"']) {
  if (!html.includes(href)) fail(`index.html 没有链接到 ${href}`);
}

// ------------------------------------------- the complete hypium API page
// Every one of the 118 methods must be on the page under its TypeScript name,
// with the Python name it came from and an honest status. The table is
// generated from src/hypium/catalog.ts, so this check is really "did you
// regenerate after changing the facade".
const { HYPIIUM_CATALOG } = await import(
  pathToFileURL(join(ROOT, "packages", "core", "dist", "driver", "hypium", "catalog.js")).href
).catch(() => fail("dist/hypium/catalog.js is missing; run npm run build first"));
if (HYPIIUM_CATALOG.length !== 118) {
  fail(`catalog has ${HYPIIUM_CATALOG.length} entries, expected 118`);
}
for (const entry of HYPIIUM_CATALOG) {
  if (!apiHtml.includes(`<code>${entry.ts}</code>`)) {
    fail(`api.html is missing the method ${entry.ts}; regenerate with scripts/gen-api-page.mjs`);
  }
  if (!apiHtml.includes(`<code class="api-py">${entry.python}</code>`)) {
    fail(`api.html is missing the hypium name ${entry.python} for ${entry.ts}`);
  }
}
for (const status of ["verified", "device", "hardware", "unsupported"]) {
  if (!apiHtml.includes(`api-status-${status}`)) fail(`api.html never shows the ${status} status`);
}
// The four things the page promises beyond the table: the call path, the
// coordinate forms, the injection channels, and the differences from hypium.
for (const needle of [
  "<svg",
  "dev.hypium",
  "PointerMatrix",
  "Component.click",
  "Target",
  "UnsupportedError",
  "setDisplayRotation",
  "SIFT",
  "118",
]) {
  if (!apiHtml.includes(needle)) fail(`api.html 缺少「${needle}」`);
}
if (apiHtml.length < 12000) fail(`api.html is only ${apiHtml.length} bytes; expected the full API reference`);
// The page states which package version it documents. A release that bumps
// package.json but forgets the generator leaves the page advertising the
// previous version — the same drift src/version.ts exists to prevent.
if (!apiHtml.includes(`<strong>${VERSION}</strong>`)) {
  fail(`api.html does not show the package version ${VERSION}; regenerate with scripts/gen-api-page.mjs`);
}

// ------------------------------------------------ the acceptance report page
// This page is the evidence the project is actually tested on hardware, so it
// is checked harder than the rest: every number a reader could act on must be
// present, the screenshot set must be complete, and the device serials must
// not be — the repository is public.
const acceptSections = [
  "summary", "devices", "step0", "step1", "step2", "step3",
  "step4", "step5", "step6", "step7", "step8", "step9", "found", "rerun",
];
for (const id of acceptSections) {
  if (!new RegExp(`\\bid\\s*=\\s*"${id}"`).test(acceptHtml)) {
    fail(`acceptance-0.9.4.html is missing id="${id}"`);
  }
}
// The page is one article rather than <section>s, so a section runs from its
// <h2> to the next one. Checking inside the block is what keeps a needle from
// being satisfied by text that belongs to a different step.
function acceptBlock(id) {
  const start = acceptHtml.indexOf(`<h2 id="${id}">`);
  if (start < 0) fail(`acceptance-0.9.4.html has no #${id} block`);
  const rest = acceptHtml.slice(start + 1);
  const next = rest.indexOf("<h2 id=");
  return next < 0 ? rest : rest.slice(0, next);
}
for (const [id, rows] of [
  ["summary", 10], // steps 0-9
  ["devices", 6],
  ["step4", 16], // the capability matrix
  ["step5", 10], // the live scenarios
  ["step6", 7], // the handshakes
  ["found", 7], // problems found and fixed
  ["rerun", 10], // the timings
]) {
  const block = acceptBlock(id);
  const n = (block.match(/<tr>/g) ?? []).length - (block.match(/<thead>/g) ?? []).length;
  if (n !== rows) fail(`acceptance-0.9.4.html #${id} has ${n} rows, expected ${rows}`);
}

for (const needle of [
  "验收报告",
  // The two devices, named only by tag.
  "7544d645",
  "6c585f5b",
  // The totals, one per step that has a pass/fail count.
  "32/32",
  "10/10",
  "14/14",
  "16 项全过",
  // Step 0-2: the environment, the device-free checks, and the installed
  // package being ESM-only.
  "unset HDC_SERVER_PORT",
  "npm run typecheck:tests",
  "node scripts/check-site.mjs",
  "npm pack --dry-run",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "126",
  // Step 3-4: the commands a reader retypes.
  "node dist/bin.js doctor",
  "node dist/bin.js inspect",
  "npx tsx scripts/acceptance.ts",
  "npm run test:device",
  // Step 5-6: the live page and the wire-level Origin test.
  "npx tsx scripts/acceptance-live.ts",
  "npx tsx scripts/acceptance-security.ts",
  "Origin: null",
  "DNS rebinding",
  // Step 7-8: the agent surface and the governance transcripts.
  "node dist/bin.js connect",
  "install-skill",
  "uitest_observe",
  "npm run acceptance:handoff",
  "blocked_by_policy · rule: read-only",
  "blocked_by_policy · rule: scope",
  "approval_pending · approval_id",
  "lease_held",
  // Step 9 and the lessons.
  "cfdba0e4",
  "6554253b",
  "UITEST_ACCEPTANCE_DIR",
  "0.2 fps",
  // The report measures the working tree, not the tarball that was on npm at
  // the time: the acceptance found and fixed real defects, and those fixes are
  // 0.9.4. A reader who takes the matrix as "what 0.9.3 does" would be reading
  // a claim the published 0.9.3 cannot back, so the page has to say where the
  // line is. The version itself comes from dist/, so a release that forgets to
  // update the page fails here.
  "加上这些修复的代码",
  // This page is the historical 0.9.4 acceptance record, not the current
  // release's page: its version must stay the one it measured.
  "0.9.4",
]) {
  if (!acceptHtml.includes(needle)) fail(`acceptance-0.9.4.html 缺少「${needle}」`);
}
// The 16 capability names the matrix claims, and the 10 live scenarios: a
// matrix that quietly lost a row would still read as "everything passed".
for (const name of [
  "connect", "click", "swipe", "touch", "triggerKey", "captureLayout",
  "captureScreen", "cropToWindow", "streamScreen", "createCast", "createCastRecord",
  "dualCast", "dumpLayout", "queue", "rpcDuringStream", "streamUiActions",
]) {
  if (!acceptBlock("step4").includes(`<code>${name}</code>`)) {
    fail(`acceptance-0.9.4.html 的能力矩阵缺少 ${name}`);
  }
}
for (const scenario of [
  "readonly guard", "takeover", "long press", "scroll", "keyboard",
  "browser keyboard", "system keys", "pinch", "stability",
]) {
  if (!acceptBlock("step5").includes(scenario)) {
    fail(`acceptance-0.9.4.html 的接管场景缺少 ${scenario}`);
  }
}
// Every screenshot the page shows must be a real JPEG of a real capture. A
// placeholder or a truncated copy would still render, so check the magic
// bytes and the size rather than only the path.
for (const [, src] of acceptHtml.matchAll(/<img src="(assets\/acceptance\/[^"]+)"/g)) {
  const p = join(SITE, src);
  if (!existsSync(p)) fail(`acceptance-0.9.4.html references a missing image: ${src}`);
  const b = readFileSync(p);
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
    fail(`${src} is not a complete JPEG`);
  }
  if (b.length < 20 * 1024) fail(`${src} is only ${Math.round(b.length / 1024)} KB`);
}
// The matrix shots are named <capability>-<tag>.jpg so a reader can tell which
// device produced which column; a missing half would silently show one device.
const matrixNames = [
  "connect", "click", "swipe", "touch", "triggerKey", "captureLayout",
  "captureScreen", "cropToWindow", "streamScreen", "createCast", "createCastRecord",
  "dualCast", "dumpLayout", "queue", "rpcDuringStream", "streamUiActions",
];
for (const tag of ["7544d645", "6c585f5b"]) {
  for (const name of matrixNames) {
    const p = join(SITE, "assets", "acceptance", `${name}-${tag}.jpg`);
    if (!existsSync(p)) fail(`missing site/assets/acceptance/${name}-${tag}.jpg`);
  }
  for (const name of ["inspect"]) {
    if (!existsSync(join(SITE, "assets", "acceptance", `${name}-${tag}.jpg`))) {
      fail(`missing site/assets/acceptance/${name}-${tag}.jpg`);
    }
  }
}
// The one rule the page must never break: no device serials. They are
// uppercase-and-digits runs of ten or more characters; the tags the page uses
// instead are eight lowercase hex digits. Words like ERR_PACKAGE_PATH_NOT_EXPORTED
// contain underscores and code identifiers are lowercase, so neither matches.
const serialish = acceptHtml.match(/\b(?=[A-Z0-9]{10,}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{10,}\b/g);
if (serialish) fail(`acceptance-0.9.4.html looks like it contains a device serial: ${serialish[0]}`);
// Every other page must link to it, or the report exists and nobody finds it.
for (const [name, text] of pages) {
  if (name === "acceptance.html" || name === "acceptance-0.9.4.html") continue;
  if (!text.includes('href="acceptance.html"')) fail(`${name} does not link to acceptance.html`);
}

// ------------------------------------- 0.10.0: one report per product per version
// Every product is accepted on its own, and the page for it is generated from
// the machine-written report. The check derives the expected set from
// `packages/*/package.json`, so a version bump with no acceptance fails here
// rather than shipping a release nobody ran.
const REPORTS_DIR = join(ROOT, "docs", "acceptance");
const reportDirs = existsSync(REPORTS_DIR)
  ? readdirSync(REPORTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
const reports = [];
for (const dir of reportDirs) {
  const file = join(REPORTS_DIR, dir, "report.json");
  if (!existsSync(file)) continue;
  const r = JSON.parse(readFileSync(file, "utf8"));
  reports.push({ ...r, dir });
}
if (reports.length === 0) fail("docs/acceptance has no report.json: every product must be accepted");

const PRODUCT_LABEL = { core: "uitest-sdk", phone: "uitest-phone", console: "uitest-console", mirror: "uitest-mirror" };
for (const [product, label] of Object.entries(PRODUCT_LABEL)) {
  const pkgFile = join(ROOT, "packages", product, "package.json");
  if (!existsSync(pkgFile)) continue;
  const { version } = JSON.parse(readFileSync(pkgFile, "utf8"));
  const has = reports.some((r) => r.product === product && r.version === version);
  if (!has) fail(`packages/${product} is ${version} but docs/acceptance has no ${product}-${version}/report.json`);
}

for (const r of reports) {
  const label = PRODUCT_LABEL[r.product];
  if (!label) fail(`report ${r.dir} names an unknown product: ${r.product}`);
  const pageName = `acceptance-${r.product}-${r.version}.html`;
  const pageFile = join(SITE, pageName);
  if (!existsSync(pageFile)) fail(`missing site/${pageName}; run node scripts/gen-acceptance-pages.mjs`);
  const page = readFileSync(pageFile, "utf8");
  for (const needle of [label, r.version, r.commit, r.date, 'href="acceptance.html"']) {
    if (!page.includes(needle)) fail(`${pageName} 缺少「${needle}」`);
  }
  const total = r.cases.length;
  const passed = r.summary?.passed ?? 0;
  if (!page.includes(`>${passed}<`) || !page.includes(`>${total}<`)) {
    fail(`${pageName} does not show its ${passed}/${total} summary`);
  }
  if (total < 5) fail(`${pageName} has only ${total} cases`);
  // A log case (a tarball listing, a handshake transcript) has no screen to
  // show, so it owes a written result instead. This is the generator's own
  // rule; a check that demanded a picture here would fail reports the
  // generator renders happily.
  for (const c of r.cases) {
    if (c.status === "skip") continue;
    if (c.kind === "log") {
      if (!String(c.detail ?? "").trim()) fail(`${pageName} case ${c.id} has no result to show`);
      continue;
    }
    if (!c.screenshots || c.screenshots.length === 0) fail(`${pageName} case ${c.id} has no screenshot`);
  }
  for (const [, src] of page.matchAll(/<img src="(assets\/acceptance\/[^"]+)"/g)) {
    const p = join(SITE, src);
    if (!existsSync(p)) fail(`${pageName} references a missing image: ${src}`);
    const b = readFileSync(p);
    if (b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
      fail(`${src} is not a complete JPEG`);
    }
    if (b.length < 20 * 1024) fail(`${src} is only ${Math.round(b.length / 1024)} KB`);
  }
  const serial = page.match(/\b(?=[A-Z0-9]{10,}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{10,}\b/g);
  if (serial) fail(`${pageName} looks like it contains a device serial: ${serial[0]}`);
}

// The hub has to be the way in: every report page and the historical record.
for (const r of reports) {
  const href = `acceptance-${r.product}-${r.version}.html`;
  if (!hubHtml.includes(`href="${href}"`)) fail(`acceptance.html does not link ${href}`);
}
if (!hubHtml.includes('href="acceptance-0.9.4.html"')) fail("acceptance.html does not link the 0.9.4 record");
if (!hubHtml.includes("验收报告")) fail("acceptance.html is not the acceptance hub");

// ----------------------------------------------- task 10: the script runs
// main.js is loaded as a classic script. A top-level `export` is a syntax
// error there and kills every behaviour on the page; ES modules would fix
// that but Chrome blocks them on file://, which the spec requires to work.
if (/^\s*export\s/m.test(js)) {
  fail("main.js has a top-level export; it is loaded as a classic script and cannot use module syntax");
}
// The showcase animation is the only moving part added without a build step.
// Assert it exists and degrades: the first step is lit in the markup, so a
// visitor with no JS sees a correct static pair rather than nothing.
if (!/function initShowcase/.test(js)) fail("main.js has no initShowcase; the showcase would never animate");
if (!/prefers-reduced-motion/.test(js)) fail("main.js does not honour prefers-reduced-motion in the showcase");
// The control demo is the second moving part. It must have a driver, start on
// scroll, and stay still under reduced motion — the same contract as the
// showcase, checked the same way.
if (!/function initControl/.test(js)) fail("main.js has no initControl; the takeover demo would never play");
if (!/\[data-control-demo\]/.test(js)) fail("initControl does not look for [data-control-demo]");
// The checkout is CRLF on Windows, so the block's terminator is `\r\n}\r\n`.
const controlBlock = js.match(/function initControl[\s\S]*?\r?\n}\r?\n/)?.[0] ?? "";
if (!/prefers-reduced-motion/.test(controlBlock)) fail("initControl does not honour prefers-reduced-motion");
if (!/IntersectionObserver/.test(controlBlock)) fail("initControl does not wait for the section to be visible");
// Each figure must have its first step lit in the markup: without JS (or with
// reduced motion) a visitor sees one correct row+box+label, not an empty
// overlay. Asserting it globally is not enough — one lit figure would hide an
// unlit one.
for (const [figure] of showcase.matchAll(/<figure class="shot"[\s\S]*?<\/figure>/g)) {
  for (const part of ['class="hl hl-row is-on"', 'class="hl hl-box is-on"', '<span class="is-on">']) {
    if (!figure.includes(part)) fail(`#showcase 有一张图没有默认点亮首步（缺少 ${part}）`);
  }
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
