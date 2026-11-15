#!/usr/bin/env node
/**
 * Acceptance checker for the static site. Every assertion the site must keep
 * living here — later tasks add to this file, they never change how it runs.
 *
 * Usage: node scripts/check-site.mjs
 * Prints `site ok` and exits 0 on success; prints the first failure and
 * exits 1 otherwise.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = join(ROOT, "site");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------- the files
const files = ["index.html", "styles.css", "main.js"];
for (const f of files) {
  const p = join(SITE, f);
  if (!existsSync(p) || !statSync(p).isFile()) fail(`missing site/${f}`);
}
const html = readFileSync(join(SITE, "index.html"), "utf8");
const css = readFileSync(join(SITE, "styles.css"), "utf8");
const js = readFileSync(join(SITE, "main.js"), "utf8");

// ------------------------------------------------------------------- anchors
const sections = ["hero", "terminal", "bench", "features", "arch", "video", "limits"];
for (const id of sections) {
  if (!new RegExp(`\\bid\\s*=\\s*"${id}"`).test(html)) fail(`index.html is missing id="${id}"`);
}

// ------------------------------------------- local references must exist
for (const [, value] of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
  if (!value || value.startsWith("http") || value.startsWith("#") || value.startsWith("mailto:")) continue;
  const clean = value.split("#")[0].split("?")[0];
  if (!clean) continue;
  const target = join(SITE, clean);
  if (!existsSync(target)) fail(`index.html references a missing file: ${value}`);
}

// --------------------------------------------------- zero external requests
const forbidden = [
  [/src\s*=\s*"https?:/i, "an external script or image src"],
  [/<link[^>]*href\s*=\s*"https?:\/\//i, "an external <link>"],
  [/url\(\s*['"]?https?:/i, "an external url() in CSS"],
  [/@import\s+url\(\s*['"]?https?:/i, "an external @import in CSS"],
];
for (const [re, what] of forbidden) {
  for (const [name, text] of [["index.html", html], ["styles.css", css], ["main.js", js]]) {
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

// ------------------------------------------------------- task 6: numbers
const bench = sectionHtml("bench");
for (const needle of ["107–193 ms", "21–50 ms", "386–640 ms", "15–89 fps", "10–16 fps"]) {
  if (!bench.includes(needle)) fail(`#bench 缺少实测数字「${needle}」`);
}

const features = sectionHtml("features");
const cards = (features.match(/<article class="card">/g) ?? []).length;
if (cards !== 8) fail(`#features 有 ${cards} 张 .card，必须恰好 8 张`);

// ------------------------------------------------------------ task 8: video
for (const name of ["demo.mp4", "demo-poster.jpg"]) {
  if (!existsSync(join(SITE, "assets", name))) fail(`missing site/assets/${name}`);
}
const mp4 = readFileSync(join(SITE, "assets", "demo.mp4"));
if (mp4.length < 500 * 1024) {
  fail(`demo.mp4 is only ${Math.round(mp4.length / 1024)} KB, expected over 500 KB`);
}

/** Reads the duration in seconds out of the first parsable mvhd box. */
function mp4Duration(buf) {
  for (let i = buf.indexOf("mvhd"); i >= 0; i = buf.indexOf("mvhd", i + 1)) {
    const version = buf[i + 4];
    if (version !== 0 && version !== 1) continue;
    const timescale = buf.readUInt32BE(i + (version === 0 ? 16 : 24));
    const duration =
      version === 0 ? buf.readUInt32BE(i + 20) : Number(buf.readBigUInt64BE(i + 28));
    if (!timescale || !duration) continue;
    const seconds = duration / timescale;
    if (seconds > 0 && seconds < 3600) return seconds;
  }
  return null;
}

const seconds = mp4Duration(mp4);
if (seconds === null) fail("demo.mp4 has no parsable mvhd box");
if (seconds < 29 || seconds > 31) fail(`demo.mp4 is ${seconds.toFixed(1)}s, expected 29–31s`);
console.log(`video ${seconds.toFixed(1)}s`);

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

console.log("site ok");
