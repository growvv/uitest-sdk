/**
 * Device acceptance for the live page's takeover input.
 *
 * Drives the page's own WebSocket protocol — not a private test hook — so what
 * passes here is what a browser tab can do. Scenarios 1-5 cover the read-only
 * guard, takeover arbitration, tap, long press and scroll; 6-9 cover the
 * keyboard, system keys, pinch and a ten-minute stability run with a tab
 * handover in the middle.
 *
 * Writes `docs/acceptance/live/report.md` and screenshots under
 * `docs/acceptance/live/screenshots/`. The report names the device by its
 * 8-character tag, never by serial.
 *
 * Usage:
 *   npx tsx scripts/acceptance-live.ts --target <device id>
 */
import { createConnection, type Socket } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import jpeg from "jpeg-js";
import { decodeJpeg as decodeJpegBuffer, type Raster } from "../src/hypium/image.js";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Device } from "../src/device.js";
import { HdcRunner } from "../src/hdc.js";
import { startLive, liveOptions } from "../src/live/cli.js";
import { buildHandshake, decodeFrames, encodeTextFrame } from "../src/cast/ws.js";
import { deviceTag } from "../src/trace.js";
import { assertCapturable } from "./acceptance.js";
import {
  RestartBudget,
  assistantCropHeight,
  clientPointFor,
  isSearchEntryNode,
  parseOnly,
  readonlyGuardVerdict,
  shouldRun,
} from "./live-walk.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/acceptance/live");
const SHOT_DIR = join(OUT_DIR, "screenshots");
const DEMO_DIR = join(OUT_DIR, "demo");
const STATE_DIR = join(ROOT, ".work-bench/acceptance-live");

const ZHIHU_BUNDLE = "com.zhihu.hmos";
// The device reports PhoneAbility as mainAbility; `EntryAbility` in the plan
// does not exist in this build.
const ZHIHU_ABILITY = "PhoneAbility";

/** The query the keyboard scenario types. Public content, no personal data. */
const QUERY = "鸿蒙";

/** Ten minutes of input, per the plan, unless a flag shortens it for iteration. */
const DEFAULT_STABILITY_MS = 600_000;
const DEFAULT_BASELINE_MS = 60_000;
/** One input every 500 ms. */
const TICK_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface NodeInfo {
  ref: number;
  role: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  clickable: boolean;
  input: boolean;
  scrollable: boolean;
  masked?: boolean;
}

interface NodesMessage {
  type: "nodes";
  bundle: string;
  display: { width: number; height: number } | null;
  nodes: NodeInfo[];
  /** Local counter: the order this client received layouts in. */
  seq: number;
}

interface Stats {
  p50: number;
  p95: number;
  n: number;
}

/**
 * One browser-like client on the page's protocol: HTTP upgrade, text frames
 * out, text/binary frames in.
 */
class LiveClient {
  readonly texts: Array<Record<string, unknown>> = [];
  nodesSeq = 0;
  binaries = 0;
  private buf: Buffer = Buffer.alloc(0);
  private upgraded = false;
  private readonly layouts: NodesMessage[] = [];
  private closed = false;

  private constructor(private readonly socket: Socket) {}

  static async connect(port: number): Promise<LiveClient> {
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new LiveClient(socket);
    client.listen();
    const upgraded = new Promise<void>((resolve) => {
      client.onUpgraded = resolve;
    });
    socket.write(
      buildHandshake(`127.0.0.1:${port}`).replace("GET / HTTP/1.1", "GET /live HTTP/1.1"),
    );
    await upgraded;
    return client;
  }

  private onUpgraded: (() => void) | null = null;

  private listen(): void {
    this.socket.on("data", (d: Buffer) => this.onData(d));
    this.socket.on("error", () => undefined);
    this.socket.on("close", () => {
      this.closed = true;
    });
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.upgraded) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.upgraded = true;
      this.buf = this.buf.subarray(end + 4);
      this.onUpgraded?.();
      this.onUpgraded = null;
    }
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x1) {
        const message = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        this.texts.push(message);
        if (message.type === "nodes") {
          this.nodesSeq++;
          this.layouts.push({ ...(message as unknown as NodesMessage), seq: this.nodesSeq });
        }
      } else if (frame.opcode === 0x2) this.binaries++;
    }
  }

  send(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.socket.write(encodeTextFrame(JSON.stringify(message)));
  }

  sendInput(message: Record<string, unknown>): void {
    this.send({ type: "input", ...message });
  }

  async until(pred: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  async hello(): Promise<Record<string, unknown>> {
    await this.until(() => this.texts.some((t) => t.type === "hello"), 8000, "hello");
    return this.texts.find((t) => t.type === "hello")!;
  }

  nodes(): NodesMessage {
    const last = this.layouts[this.layouts.length - 1];
    if (!last) throw new Error("no layout received yet");
    return last;
  }

  async waitForLayout(ms = 6000): Promise<void> {
    await this.until(() => this.layouts.length > 0, ms, "first layout");
  }

  async waitForStats(ms = 5000): Promise<Stats> {
    await this.until(() => this.latestStats() !== null, ms, "the stats broadcast");
    return this.latestStats()!;
  }

  /**
   * Waits for a stats broadcast that covers at least `n` injections.
   *
   * Stats go out once a second, so the first message after a gesture can be
   * from before it: measuring that one reports one op's latency as the tap's.
   */
  async waitForStatsAtLeast(n: number, ms = 6000): Promise<Stats> {
    await this.until(
      () => (this.latestStats()?.n ?? 0) >= n,
      ms,
      `stats covering ${n} injections`,
    );
    return this.latestStats()!;
  }

  latestStats(): Stats | null {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i]!;
      const stats = t.stats as Stats | undefined;
      if (t.type === "control" && stats && typeof stats.p50 === "number") return stats;
    }
    return null;
  }

  /** The last control state this tab was told about. */
  lastControl(): Record<string, unknown> | null {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i]!;
      if (t.type === "control" && typeof t.state === "string") return t;
    }
    return null;
  }

  /** Waits for a control message with this state, sent after index `from`. */
  async waitForControl(
    state: string,
    from = 0,
    ms = 5000,
  ): Promise<Record<string, unknown>> {
    await this.until(
      () => this.texts.slice(from).some((t) => t.type === "control" && t.state === state),
      ms,
      `control state ${state}`,
    );
    return this.texts
      .slice(from)
      .find((t) => t.type === "control" && t.state === state)!;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
    } catch {
      // The peer is gone; destroy still cleans up locally.
    }
    this.socket.destroy();
  }
}

interface ScenarioResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  ms: number;
  detail: string;
  evidence: string[];
}

/** `--only a,b`: run selected scenarios while iterating; null runs all. */
let onlyFilter: string[] | null = null;

async function scenario(
  name: string,
  run: () => Promise<{ detail: string; evidence?: string[] }>,
): Promise<ScenarioResult> {
  const started = performance.now();
  if (!shouldRun(name, onlyFilter)) {
    return { name, status: "SKIP", ms: 0, detail: "未运行（--only 过滤）", evidence: [] };
  }
  try {
    const out = await run();
    return {
      name,
      status: "PASS",
      ms: Math.round(performance.now() - started),
      detail: out.detail,
      evidence: out.evidence ?? [],
    };
  } catch (e) {
    return {
      name,
      status: "FAIL",
      ms: Math.round(performance.now() - started),
      detail: e instanceof Error ? e.message : String(e),
      evidence: [],
    };
  }
}

function labelKey(nodes: NodeInfo[]): string {
  return nodes
    .map((n) => n.label.trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

function area(n: NodeInfo): number {
  return n.w * n.h;
}

/** Safe tab-like targets: switching a feed or a sort changes the screen. */
const SAFE_TABS = ["最新", "最热", "精华", "知识", "圈子", "首页"];

// Anything that opens a private inbox, changes the account's state or starts
// an action that cannot be taken back. The screenshots land in the repository,
// so a stray tap on 消息 would publish someone's chats.
const UNSAFE = /消息|我的|关注|赞同|喜欢|收藏|评论|分享|举报|邀请|写回答|登录|退出|删除|发布|私信|通知|设置|账号|充值|会员|订单|购物|支付/;

/**
 * Every safe tab on screen, not just the first: the app restores its last
 * category across a restart, and tapping an already-selected tab changes
 * nothing, so the caller needs the rest of the list.
 */
function pickTabTargets(nodes: NodeInfo[]): NodeInfo[] {
  return SAFE_TABS.flatMap((label) =>
    nodes.filter(
      (n) => n.clickable && !n.masked && n.label.trim() === label && area(n) >= 1200,
    ),
  );
}

/**
 * The search entry in the top bar: the only wide, clickable node between the
 * menu button and the search button. Its label is whatever trend it rotates
 * through, so it is found by geometry, not by text.
 */
function isSearchEntry(n: NodeInfo): boolean {
  return isSearchEntryNode(n);
}

function pickSearchEntry(nodes: NodeInfo[]): NodeInfo | null {
  // The top bar also has a wide background container lower in the row; the
  // input itself sits highest, so the top-most match is the field.
  const hits = nodes.filter(isSearchEntry).sort((a, b) => a.cy - b.cy);
  return hits[0] ?? null;
}

/** Labels only the system input assistant puts on screen after a hold. */
const ASSISTANT = /自动填充|拍摄输入|小艺帮写/;

/** The Zhihu feed: its tab labels are the one stable landmark across pages. */
function isFeed(nodes: NodeInfo[]): boolean {
  const labels = nodes.map((n) => n.label.trim());
  return labels.includes("首页") && (labels.includes("推荐") || labels.includes("关注"));
}

/** The search page's field: an input in the top bar. */
function pickField(nodes: NodeInfo[]): NodeInfo | null {
  const hits = nodes
    .filter((n) => n.input && !n.masked && n.cy < 400 && n.w >= 300)
    .sort((a, b) => a.cy - b.cy);
  return hits[0] ?? null;
}

/**
 * Result cards on a search page: wide clickable boxes that carry a title and
 * an excerpt. The page also has full-width containers whose labels are the
 * container id or a `Block:` marker; those navigate nowhere on a tap.
 *
 * The demo frames land on the site, so the card known to carry the HarmonyOS
 * 7 diagram is tried first. Which result a query returns is not fixed — the
 * same search landed on three different articles across runs — and a random
 * article can be a chat screenshot, which shows nothing worth watching.
 */
const DEMO_CARD = /鸿蒙开发还有出路吗/;

function pickResultCards(nodes: NodeInfo[]): NodeInfo[] {
  return nodes
    .filter((n) => {
      const label = n.label.trim();
      return (
        n.clickable &&
        !n.masked &&
        n.w >= 500 &&
        n.cy > 500 &&
        n.cy < 2200 &&
        label.length > 6 &&
        !/^Block(:|$)/.test(label) &&
        !/^\d+$/.test(label)
      );
    })
    .sort((a, b) => {
      const pa = DEMO_CARD.test(a.label) ? 0 : 1;
      const pb = DEMO_CARD.test(b.label) ? 0 : 1;
      return pa - pb || a.cy - b.cy;
    });
}

/** The search page's result tabs, which no other Zhihu page carries. */
function isSearchResults(nodes: NodeInfo[]): boolean {
  const labels = nodes.map((n) => n.label.trim());
  return labels.includes("综合") && labels.some((l) => /^AI ?搜索$/.test(l));
}

/**
 * Images inside an answer that open the viewer when tapped.
 *
 * Unlike a feed image, an answer's image has no source URL as its label — the
 * page gets an empty label for it. What it keeps is the shape: a large
 * clickable box with no text of its own, while every card-like box on an
 * answer page carries its title or body. The width floor is what separates an
 * inline image from a search page's small unlabeled icon modules (325 px),
 * which also have empty labels.
 */
function pickInlineImages(nodes: NodeInfo[]): NodeInfo[] {
  return nodes
    .filter(
      (n) =>
        n.clickable &&
        !n.masked &&
        n.label.trim() === "" &&
        n.w >= 500 &&
        n.h >= 300 &&
        n.cy > 300 &&
        n.cy < 2400,
    )
    .sort((a, b) => area(b) - area(a));
}

async function decodeJpeg(file: string): Promise<Raster> {
  return decodeJpegBuffer(await readFile(file));
}

/**
 * Mean red channel over a horizontal band: a dark viewer against a white page.
 *
 * The whole-screen average is useless here — the viewer's own image can be a
 * bright news screenshot. The top strip is what differs: an article page is
 * white there, a viewer is black behind its toolbar.
 */
async function meanBrightness(file: string, rows = 200): Promise<number> {
  const img = await decodeJpeg(file);
  const bottom = Math.min(img.height, rows);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < bottom; y += 3) {
    for (let x = 0; x < img.width; x += 5) {
      sum += img.data[(y * img.width + x) * 4]!;
      n++;
    }
  }
  return Math.round(sum / Math.max(1, n));
}

/** Mean absolute channel difference over a sampled grid. */
async function meanDiff(aFile: string, bFile: string): Promise<number> {
  const a = await decodeJpeg(aFile);
  const b = await decodeJpeg(bFile);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      sum +=
        Math.abs(a.data[i]! - b.data[j]!) +
        Math.abs(a.data[i + 1]! - b.data[j + 1]!) +
        Math.abs(a.data[i + 2]! - b.data[j + 2]!);
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

async function tap(c: LiveClient, x: number, y: number): Promise<void> {
  c.sendInput({ action: "down", x, y });
  await sleep(40);
  c.sendInput({ action: "up", x, y });
}

async function longPress(c: LiveClient, x: number, y: number): Promise<void> {
  c.sendInput({ action: "down", x, y });
  // The device's own long-press path takes two seconds (the reference
  // implementation holds `longClick` that long); 750 ms only focuses a field.
  await sleep(2000);
  c.sendInput({ action: "up", x, y });
}

async function swipe(
  c: LiveClient,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  c.sendInput({ action: "down", x: x1, y: y1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    c.sendInput({
      action: "move",
      x: Math.round(x1 + (x2 - x1) * t),
      y: Math.round(y1 + (y2 - y1) * t),
    });
    await sleep(45);
  }
  c.sendInput({ action: "up", x: x2, y: y2 });
}

async function labelsChanged(c: LiveClient, before: string, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (labelKey(c.nodes().nodes) !== before) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Walks back to the feed, relaunching when back has nothing left to pop.
 *
 * Zhihu restores its last page across a restart, so a scenario that follows
 * one which ended on a search or an answer starts one or two pages deep.
 * Every caller needs the same walk; keeping it here means each scenario says
 * "start from the feed" instead of repeating the loop.
 */
async function ensureFeed(c: LiveClient, relaunch: () => Promise<void>, tries = 6): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (isFeed(c.nodes().nodes)) return;
    const before = labelKey(c.nodes().nodes);
    c.sendInput({ action: "key", key: "back" });
    if (!(await labelsChanged(c, before, 4000))) {
      await relaunch();
      await sleep(3000);
    } else {
      await sleep(900);
    }
  }
  if (!isFeed(c.nodes().nodes)) throw new Error("could not get back to the feed");
}

/**
 * Waits until the node table has been unchanged for a while.
 *
 * A page that has just opened ignores a hold for a second or two — the field
 * is still attaching its input method — and the gesture is swallowed. Settling
 * first is what makes the long press land on a ready field.
 */
async function settle(c: LiveClient, quietMs = 1200, ms = 12_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = JSON.stringify(c.nodes().nodes);
  let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(150);
    const now = JSON.stringify(c.nodes().nodes);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
}

/** Tab bar plus system navigation: the account avatar and unread count live here. */
const BOTTOM_CROP_PX = 200;

/** Margin below the input assistant's bar, in display pixels. */
const ASSISTANT_MARGIN_PX = 24;

/** The launcher's app grid; its search history sits below. */
const LAUNCHER_CROP_PX = 360;

/**
 * Cuts a screenshot to its top `height` pixels (default: everything but the
 * bottom strip).
 *
 * The screenshots are committed, and the bottom of the screen holds the
 * signed-in account's avatar and unread badge. Neither is evidence for
 * anything this run measures, so both are cut rather than published.
 */
async function cropJpeg(file: string, height?: number): Promise<void> {
  const image = jpeg.decode(await readFile(file), { useTArray: true });
  const keep = height === undefined ? Math.max(1, image.height - BOTTOM_CROP_PX) : Math.min(image.height, height);
  const data = Buffer.alloc(image.width * keep * 4);
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(
    data,
    0,
    0,
    data.length,
  );
  await writeFile(file, jpeg.encode({ data, width: image.width, height: keep }, 85).data);
}

/**
 * Saves the device's screen into `dir` and crops the bottom strip.
 *
 * `keepTop` limits the result to the top strip instead (the long-press
 * evidence keeps only the field and the assistant above the keyboard).
 */
async function shotInto(
  c: LiveClient,
  dir: string,
  name: string,
  keepTop?: number,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const from = c.texts.length;
  c.send({ type: "shot" });
  await c.until(
    () => c.texts.slice(from).some((t) => t.type === "saved"),
    15_000,
    "the screenshot",
  );
  const saved = c.texts.slice(from).find((t) => t.type === "saved")!;
  if (saved.error || !saved.path) throw new Error(`screenshot failed: ${String(saved.error)}`);
  const out = join(dir, `${name}.jpg`);
  await copyFile(String(saved.path), out);
  await cropJpeg(out, keepTop);
  return relative(ROOT, out).replace(/\\/g, "/");
}

async function shot(c: LiveClient, name: string, keepTop?: number): Promise<string> {
  return shotInto(c, SHOT_DIR, name, keepTop);
}

/**
 * Saves the whole screen to `demo/`, uncropped except the account strip.
 *
 * The site's control animation needs the device frame (status bar and all);
 * its CSS crops the chrome.
 */
async function demoSave(c: LiveClient, name: string): Promise<string> {
  return shotInto(c, DEMO_DIR, name);
}

interface Env {
  tag: string;
  model: string;
  osVersion: string;
  size: string;
  zhihu: string;
  commit: string;
  startedAt: string;
}

/**
 * The real page in headless Chrome, driven over CDP.
 *
 * The two checks the plan asks a person to perform are keyboard timing rules
 * that only the page implements — a 300 ms idle flush and a composition that
 * stays local until `compositionend`. Running them here means they are run,
 * every time, against the same server and device as the scenarios, instead of
 * being a checklist item someone may skip.
 */
async function runBrowserChecks(
  port: number,
  watcher: LiveClient,
): Promise<BrowserCheck[]> {
  const checks: BrowserCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, status: ok ? "PASS" : "FAIL", detail });
  };
  const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(chromePath)) {
    add("真实页面：英文 300 ms 空闲落设备", false, `找不到 Chrome（${chromePath}），设置 CHROME_PATH 后重跑`);
    add("真实页面：拼音组合不上屏", false, "同上");
    return checks;
  }

  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const profile = join(ROOT, ".work-bench/chrome-acceptance");
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let socket: WebSocket | undefined;
  const stop = (): void => {
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    try {
      execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Chrome already exited.
    }
  };
  try {
    let pageUrl = "";
    for (let i = 0; i < 100 && !pageUrl; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl: string;
        }>;
        pageUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {
        // Chrome is still starting.
      }
      if (!pageUrl) await sleep(100);
    }
    if (!pageUrl) {
      add("真实页面：英文 300 ms 空闲落设备", false, "Chrome 的调试端口没有起来");
      add("真实页面：拼音组合不上屏", false, "同上");
      return checks;
    }

    socket = new WebSocket(pageUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("CDP socket failed"));
    });
    let nextId = 1;
    const pending = new Map<number, (v: unknown) => void>();
    socket.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number };
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket!.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} timed out`));
          }
        }, 10_000);
      });
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = (await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { exceptionDetails?: unknown; result?: { value?: unknown } } };
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };
    const until = async (pred: () => Promise<boolean>, ms = 8000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await pred()) return true;
        await sleep(100);
      }
      return false;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    if (!(await until(async () => (await evaluate("document.readyState")) === "complete"))) {
      throw new Error("the page did not load");
    }
    if (!(await until(async () => (await evaluate("typeof document.getElementById('takeover')?.click")) === "function"))) {
      throw new Error("the page has no takeover button");
    }
    // Take control from the page itself — the same path a person uses.
    await evaluate("document.getElementById('takeover').click()");
    const took = await until(async () => (await evaluate("document.body.classList.contains('controlled')")) === true);
    if (!took) throw new Error("the page did not take control");

    // The device is the only witness that matters: the page can hold text in
    // its box forever and still look right. `deviceKey` is the visible screen;
    // these checks wait for it to change (or to hold still during a
    // composition) instead of trusting the page's own state.
    const deviceKey = (): string => labelKey(watcher.nodes().nodes);

    // The page sends text to its last canvas press, and the device sends it to
    // the focused field. Both have to point at the search box, or the text
    // lands wherever the screen's centre happens to be. This presses the
    // canvas over the field, exactly as a person would.
    const focusField = async (): Promise<string> => {
      // Zhihu's search box is a TextArea, which the screen model does not map
      // to `input`; the geometry picker finds it all the same.
      const field =
        pickField(watcher.nodes().nodes) ?? pickSearchEntry(watcher.nodes().nodes);
      const display = watcher.nodes().display;
      if (!field || !display) {
        const seen = watcher
          .nodes()
          .nodes.slice(0, 12)
          .map((n) => `${n.role}:${n.label.slice(0, 12)}@${n.cx},${n.cy} ${n.w}x${n.h}${n.input ? " input" : ""}`)
          .join(" | ");
        return `no field on the device (display ${display ? "yes" : "no"}; screen: ${seen})`;
      }
      // The canvas draws the decoded frame, which is half the display on this
      // MJPEG path, so the press is placed by the display size. Using the
      // canvas size here used to cancel out against the page's own error;
      // with the page fixed, that would put the press in the corner.
      const rect = (await evaluate(`(() => {
        const r = document.getElementById('screen').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      })()`)) as { left: number; top: number; width: number; height: number };
      const at = clientPointFor({ x: field.cx, y: field.cy }, display, rect);
      await evaluate(`(() => {
        const c = document.getElementById('screen');
        const init = { clientX: ${at.x}, clientY: ${at.y}, pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true };
        c.dispatchEvent(new PointerEvent('pointerdown', init));
        c.dispatchEvent(new PointerEvent('pointerup', init));
        return true;
      })()`);
      await sleep(800);
      return "";
    };

    // 1) English: the page flushes 300 ms after the last keystroke.
    const focused = await focusField();
    if (focused) {
      add("真实页面：英文 300 ms 空闲落设备", false, focused);
      add("真实页面：拼音组合不上屏", false, focused);
      return checks;
    }
    await evaluate(`(() => {
      const t = document.getElementById('text-input');
      t.focus();
      t.value = 'scrcpy';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const englishLanded = await until(async () => deviceKey().includes("scrcpy"), 8000);
    add(
      "真实页面：英文 300 ms 空闲落设备",
      englishLanded,
      englishLanded ? "输入框里的文字在空闲后到达设备，设备画面随之变化" : "页面没有在空闲后把文本发到设备",
    );

    // 2) Pinyin: nothing leaves the page until the composition ends. The
    // check looks for the pinyin itself on the device, not just any change:
    // the page keeps animating, so "the screen moved" is not evidence.
    // The first flush left the device's caret somewhere else (its own search
    // box submits and moves on), so the field is re-focused before the
    // composition check — otherwise the word lands off-screen and "did not
    // arrive" would be measuring the wrong thing.
    await focusField();
    await evaluate(`(() => {
      const t = document.getElementById('text-input');
      t.focus();
      t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      t.value = 'hongmeng';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(2000);
    const leaked = deviceKey().includes("hongmeng");
    await evaluate(`(() => {
      const t = document.getElementById('text-input');
      t.value = '组合词';
      t.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组合词' }));
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const committed = await until(async () => deviceKey().includes("组合词"), 10_000);
    add(
      "真实页面：拼音组合不上屏",
      !leaked && committed,
      leaked
        ? "组合期间就把拼音发到了设备"
        : committed
          ? "组合期间设备无变化，compositionend 后整词到达"
          : "compositionend 后整词没有到达设备",
    );

    // Leave the page read-only again; the next scenario takes it back.
    await evaluate("document.getElementById('takeover').click()").catch(() => undefined);
    await sleep(500);
    return checks;
  } finally {
    stop();
  }
}

function gitHead(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    // A run on a dirty tree cannot be attributed to HEAD: this report was once
    // stamped with a commit while the script and the browser checks it ran were
    // uncommitted changes that landed in the next commit, so the line named a
    // tree that could not have produced it. Say so instead of lying.
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

async function preflight(target: string): Promise<Env> {
  const dev = await Device.connect({ deviceId: target });
  try {
    await assertCapturable(dev.hypium);
    // The screen sleeps on its own schedule. A touch on a dark screen wakes
    // it and never reaches the app — measured as a long press that focuses
    // nothing and a tap that lands 20 ms late. Holding the timeout open for
    // the run is the difference between measuring input and measuring the
    // power manager. The original timeout is restored when the run ends.
    await dev.hdc.shell("power-shell timeout -o 1800000").catch(() => undefined);
    const size = await dev.agent.getDisplaySize();
    const model = (await dev.hdc.shell("param get const.product.model")).trim();
    const osVersion = (await dev.hdc.shell("param get const.product.software.version")).trim();
    // A known start: the app otherwise keeps the last tab, category and
    // scroll position, and the scenarios below pick targets from what is up.
    await dev.hdc.shell(`aa force-stop ${ZHIHU_BUNDLE}`).catch(() => undefined);
    await sleep(500);
    const launched = await dev.hdc.shell(`aa start -b ${ZHIHU_BUNDLE} -a ${ZHIHU_ABILITY}`);
    if (/error/i.test(launched)) {
      throw new Error(`cannot launch Zhihu: ${launched.trim()}`);
    }
    return {
      tag: `dev-${deviceTag(target)}`,
      model,
      osVersion,
      size: `${size.width}×${size.height}`,
      zhihu: `${ZHIHU_BUNDLE}/${ZHIHU_ABILITY}`,
      commit: gitHead(),
      startedAt: new Date().toISOString(),
    };
  } finally {
    await dev.dispose();
  }
}

interface BrowserCheck {
  name: string;
  status: "PASS" | "FAIL";
  detail: string;
}

function renderReport(
  env: Env,
  results: ScenarioResult[],
  inputStats: Stats | null,
  browserChecks: BrowserCheck[],
): string {
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.status === "PASS" ? "✅ PASS" : r.status === "SKIP" ? "⏭ SKIP" : "❌ FAIL"} | ${r.ms} | ${r.detail} | ${r.evidence.join("<br>") || "—"} |`,
    )
    .join("\n");
  const browser = browserChecks.length
    ? browserChecks
        .map((b) => `- [${b.status === "PASS" ? "x" : " "}] ${b.name} — ${b.detail}`)
        .join("\n")
    : "- [ ] 未运行：`browser keyboard` 场景被 `--only` 过滤掉了";

  return `# live 页接管输入验收报告

- 设备：${env.tag}（${env.model}，${env.osVersion}）
- 屏幕：${env.size}
- 应用：知乎 ${env.zhihu}
- 代码：${env.commit}
- 开始：${env.startedAt}
- 结果：**${passed}/${results.length - skipped} PASS**${skipped ? `（另有 ${skipped} 项未运行：\`--only\` 过滤，本次不是完整验收）` : ""}
${inputStats ? `- 本次注入延迟：p50 ${inputStats.p50.toFixed(1)} ms · p95 ${inputStats.p95.toFixed(1)} ms · n=${inputStats.n}\n` : ""}
| 场景 | 结果 | 耗时 (ms) | 说明 | 证据 |
|---|---|---|---|---|
${rows}

## 真实页面键盘检查

\`browser keyboard\` 场景用无头 Chrome 打开同一个 live 页面、同一台设备，键盘事件走页面的真实监听器（不是模拟服务器）：

${browser}

> 本报告由 \`npx tsx scripts/acceptance-live.ts --target <id>\` 生成；设备只以 8 位标签出现。
> 证据截图底部裁去 ${BOTTOM_CROP_PX} px（登录账号的头像与未读角标）；长按证据只保留输入助手条及其下 ${ASSISTANT_MARGIN_PX} px（其下是搜索历史，位置随搜索词变化，所以按节点几何裁）。其余保持原始分辨率。
> \`docs/acceptance/live/demo/\` 是官网动画用的整屏原图，同样裁去底部 ${BOTTOM_CROP_PX} px。
`;
}

async function main(): Promise<number> {
  const i = process.argv.indexOf("--target");
  const target = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.UITEST_TARGET;
  if (!target) {
    process.stderr.write(
      "usage: npx tsx scripts/acceptance-live.ts --target <device id> [--stability-min N] [--baseline-min N]\n",
    );
    return 2;
  }
  const flag = (name: string): number | null => {
    const at = process.argv.indexOf(name);
    if (at < 0) return null;
    const v = Number(process.argv[at + 1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  // Shortening these is for iterating on the script; the committed run uses
  // the plan's ten minutes and one minute.
  const onlyAt = process.argv.indexOf("--only");
  onlyFilter = parseOnly(onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined);
  const stabilityMsArg = (flag("--stability-min") ?? DEFAULT_STABILITY_MS / 60_000) * 60_000;
  const baselineMsArg = (flag("--baseline-min") ?? DEFAULT_BASELINE_MS / 60_000) * 60_000;
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(DEMO_DIR, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });

  let env: Env;
  try {
    env = await preflight(target);
  } catch (e) {
    process.stderr.write(`preflight failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  await sleep(2000);

  const run = await startLive(
    { deviceId: target },
    { ...liveOptions({}), httpPort: 0, open: false, layout: true },
    { stateDir: STATE_DIR, task: "live-acceptance" },
  );

  const results: ScenarioResult[] = [];
  let a: LiveClient | null = null;
  let b: LiveClient | null = null;
  const browserChecks: BrowserCheck[] = [];
  const relaunchZhihu = async (): Promise<void> => {
    const out = await new HdcRunner({ deviceId: target }).shell(
      `aa start -b ${ZHIHU_BUNDLE} -a ${ZHIHU_ABILITY}`,
    );
    if (/error/i.test(out)) throw new Error(`cannot launch Zhihu: ${out.trim()}`);
  };
  try {
    a = await LiveClient.connect(run.server.port);
    b = await LiveClient.connect(run.server.port);
    const hello = await a.hello();
    const clientId = String(hello.clientId ?? "");
    if (!clientId) throw new Error("the server did not name this tab");
    await a.waitForLayout(10_000);
    await b.waitForLayout(10_000);
    // A fresh start shows the splash ad first, and its node table already
    // carries 首页; the feed itself is the screen with the category tabs.
    await a.until(
      () => {
        const labels = a!.nodes().nodes.map((n) => n.label.trim());
        return labels.includes("首页") && (labels.includes("推荐") || labels.includes("关注"));
      },
      25_000,
      "the Zhihu feed",
    );
    await settle(a!);

    results.push(
      await scenario("readonly guard", async () => {
        // The node table is not the invariant: the feed animates and refreshes
        // on its own, so it can change with no input at all. What an injected
        // tap must not do is leave the page it was on, or grant control.
        //
        // The tap has to land on something that *would* navigate: a blank
        // spot proves nothing, because a routed tap there changes nothing
        // either. The search entry is the one wide clickable node in the top
        // bar and opens the search page, so a server that forwarded read-only
        // input would be caught by the feed assertion below.
        const before = a!.nodes();
        const entry = pickSearchEntry(before.nodes);
        if (!entry) throw new Error("no search entry to aim the guard at");
        const seq = a!.nodesSeq;
        a!.sendInput({ action: "down", x: entry.cx, y: entry.cy });
        await sleep(120);
        a!.sendInput({ action: "up", x: entry.cx, y: entry.cy });
        await a!.until(() => a!.nodesSeq > seq, 6000, "a layout after the ignored input");
        // Give a routed tap the same window the keyboard scenario waits for,
        // so a slow navigation is not mistaken for an ignored one.
        await sleep(1200);
        const after = a!.nodes();
        const verdict = readonlyGuardVerdict(before, after);
        if (verdict) throw new Error(verdict);
        if (a!.texts.some((t) => t.type === "control" && t.state === "controlled")) {
          throw new Error("read-only input granted control");
        }
        return {
          detail: "未接管时注入被忽略：点搜索框后仍在信息流，未获得控制权",
          evidence: [await shot(a!, "01-readonly")],
        };
      }),
    );

    results.push(
      await scenario("takeover", async () => {
        const t0 = performance.now();
        a!.send({ type: "control", action: "take" });
        await a!.until(
          () => a!.texts.some((t) => t.type === "control" && t.state === "controlled"),
          5000,
          "controlled",
        );
        const cold = Math.round(performance.now() - t0);
        const ctrl = a!.texts.find((t) => t.type === "control" && t.state === "controlled")!;
        if (ctrl.clientId !== clientId) throw new Error("another tab was named controller");
        b!.send({ type: "control", action: "take" });
        await b!.until(
          () => b!.texts.some((t) => t.type === "control" && t.reason === "busy"),
          4000,
          "the busy refusal",
        );
        const busy = b!.texts.find((t) => t.type === "control" && t.reason === "busy")!;
        if (busy.by !== clientId) throw new Error("busy did not name the holder");
        if (cold >= 1500) throw new Error(`cold takeover took ${cold} ms (target ≤ 1500)`);
        return { detail: `冷接管 ${cold} ms；第二个页面被拒（busy by ${String(busy.by)}）` };
      }),
    );

    results.push(
      await scenario("tap", async () => {
        // The site's animation opens on the 推荐 feed; this is that frame,
        // taken before the scenario taps anything.
        const demoFeed = await demoSave(a!, "1-feed");
        const display = a!.nodes().display;
        if (!display) throw new Error("no display size in the layout");
        const nodes = a!.nodes().nodes;
        let used: NodeInfo | null = null;
        let beforeKey = labelKey(nodes);
        const fallback = nodes.filter(
          (n) =>
            n.clickable &&
            !n.masked &&
            n.label.trim() &&
            !UNSAFE.test(n.label) &&
            !isSearchEntry(n) &&
            area(n) >= 2000,
        );
        // A tap that leaves the feed would change what the next scenario sees,
        // so every safe tab is tried before any content node.
        const seen = new Set<string>();
        const candidates: NodeInfo[] = [];
        for (const n of [...pickTabTargets(nodes), ...fallback]) {
          const key = `${n.label.trim()}|${n.cx}|${n.cy}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push(n);
        }
        const n0 = a!.latestStats()?.n ?? 0;
        let taps = 0;
        for (const node of candidates) {
          if (!node) continue;
          beforeKey = labelKey(a!.nodes().nodes);
          await tap(a!, node.cx, node.cy);
          taps++;
          if (await labelsChanged(a!, beforeKey, 4000)) {
            used = node;
            break;
          }
          await sleep(300);
        }
        if (!used) throw new Error("no tap changed the screen");
        // A category switch lands on a skeleton whose node table still carries
        // the tab labels, so a label count is not proof the cards rendered —
        // measured: the shot at 2.5 s was grey placeholder rows. The skeleton
        // is replaced by a second screen change; wait for that, and fall back
        // to a dwell when the content arrives in place.
        const skeletonKey = labelKey(a!.nodes().nodes);
        const skeletonDeadline = Date.now() + 8000;
        let loaded = false;
        while (Date.now() < skeletonDeadline) {
          await sleep(150);
          const now = labelKey(a!.nodes().nodes);
          if (now !== skeletonKey && a!.nodes().nodes.filter((n) => !n.masked && n.label.trim().length >= 12).length >= 3) {
            loaded = true;
            break;
          }
        }
        if (!loaded) await sleep(1500);
        // Every tap is a down and an up; wait for a broadcast that saw them.
        const stats = await a!.waitForStatsAtLeast(n0 + taps * 2);
        if (stats.p50 > 20) throw new Error(`p50 ${stats.p50.toFixed(1)} ms > 20 ms`);
        if (stats.p95 > 50) throw new Error(`p95 ${stats.p95.toFixed(1)} ms > 50 ms`);
        return {
          detail: `点击「${used.label.trim().slice(0, 24)}」后画面变化；p50 ${stats.p50.toFixed(1)} ms · p95 ${stats.p95.toFixed(1)} ms · n=${stats.n}`,
          evidence: [demoFeed, await shot(a!, "02-tap")],
        };
      }),
    );

    results.push(
      await scenario("long press", async () => {
        // A hold on a feed card in this build behaves exactly like a tap, so
        // it would pass while proving nothing about the hold. The gesture that
        // only a hold produces is on a text field: it opens the system input
        // assistant (自动填充 / 拍摄输入 / 小艺帮写). The tap that opens the
        // search page is the gesture proven by the previous scenario.
        const entry = pickSearchEntry(a!.nodes().nodes);
        if (!entry) throw new Error("no search entry in the top bar");
        const beforeKey = labelKey(a!.nodes().nodes);
        await tap(a!, entry.cx, entry.cy);
        if (!(await labelsChanged(a!, beforeKey, 6000))) {
          throw new Error("the search entry did not open");
        }
        // The page opens with the field already focused. Tapping it first
        // makes the next hold a caret action instead of the assistant, so the
        // hold is the first thing that touches the field.
        await settle(a!);
        const field = pickSearchEntry(a!.nodes().nodes);
        if (!field) throw new Error("no search field on the search page");
        const known = new Set(a!.nodes().nodes.map((n) => n.label.trim()));
        const beforeN = a!.latestStats()?.n ?? 0;
        await longPress(a!, field.cx, field.cy);
        const deadline = Date.now() + 5000;
        let assist: NodeInfo[] = [];
        while (Date.now() < deadline) {
          assist = a!.nodes().nodes.filter(
            (n) => ASSISTANT.test(n.label) && !known.has(n.label.trim()),
          );
          if (assist.length > 0) break;
          await sleep(100);
        }
        if (assist.length === 0) {
          const seen = a!.nodes().nodes
            .map((n) => n.label.trim())
            .filter(Boolean)
            .slice(0, 12)
            .join("|");
          const afterN = a!.latestStats()?.n ?? 0;
          throw new Error(
            `the hold did not open the input assistant at ${field.cx},${field.cy} (ops ${beforeN}→${afterN}, screen: ${seen})`,
          );
        }
        // The assistant bar moves with the search text (a long query wraps and
        // pushes it down), so the crop follows the bar's own geometry instead
        // of a fixed height — a constant either cut the bar or kept a history
        // row, and both happened on this device.
        const display = a!.nodes().display;
        if (!display) throw new Error("no display size in the layout");
        const evidence = await shot(
          a!,
          "03-long-press",
          assistantCropHeight(assist, display, { width: display.width / 2, height: display.height / 2 }, ASSISTANT_MARGIN_PX),
        );
        // Close the keyboard, then the search page.
        a!.sendInput({ action: "key", key: "back" });
        await sleep(600);
        a!.sendInput({ action: "key", key: "back" });
        await sleep(600);
        return {
          detail: `长按搜索框弹出系统输入助手（${assist.map((n) => n.label.trim()).join(" / ")}）`,
          evidence: [evidence],
        };
      }),
    );

    results.push(
      await scenario("scroll", async () => {
        const display = a!.nodes().display;
        if (!display) throw new Error("no display size in the layout");
        const nodes = a!.nodes().nodes;
        const list = nodes.filter((n) => n.scrollable).sort((x, y) => y.h - x.h)[0];
        const before = labelKey(nodes);
        const cx = list ? list.cx : Math.floor(display.width / 2);
        const top = list
          ? Math.min(display.height - 200, list.y + 200)
          : Math.floor(display.height * 0.25);
        const bottom = list
          ? Math.min(
              display.height - 100,
              Math.max(top + 200, list.y + list.h - 200),
            )
          : Math.floor(display.height * 0.75);
        await swipe(a!, cx, bottom, cx, top);
        if (!(await labelsChanged(a!, before, 6000))) {
          throw new Error("the swipe did not move the list");
        }
        await sleep(600);
        return {
          detail: `在 ${cx},${bottom} → ${cx},${top} 竖划后可见内容变化`,
          evidence: [await shot(a!, "04-scroll")],
        };
      }),
    );

    results.push(
      await scenario("keyboard", async () => {
        // Search is reached from the feed's top bar. The previous scenarios
        // leave a search page open, so back out first.
        await ensureFeed(a!, relaunchZhihu);
        const entry = pickSearchEntry(a!.nodes().nodes);
        if (!entry) throw new Error("no search entry in the top bar");
        const beforeOpen = labelKey(a!.nodes().nodes);
        await tap(a!, entry.cx, entry.cy);
        if (!(await labelsChanged(a!, beforeOpen, 6000))) {
          throw new Error("the search entry did not open");
        }
        await settle(a!);
        const field = pickField(a!.nodes().nodes) ?? pickSearchEntry(a!.nodes().nodes);
        if (!field) throw new Error("no search field on the search page");
        // Tap the field so it takes the caret; the input then goes where the
        // page's own text box points, which is how a person types.
        await tap(a!, field.cx, field.cy);
        await sleep(800);
        const beforeText = labelKey(a!.nodes().nodes);
        const n0 = a!.latestStats()?.n ?? 0;
        a!.sendInput({ action: "text", text: QUERY, x: field.cx, y: field.cy });
        // Suggestions appear as the query lands; typing alone is not the proof.
        await a!.waitForStatsAtLeast(n0 + 1, 8000);
        await sleep(1200);
        a!.sendInput({ action: "key", key: "enter" });
        await a!.waitForStatsAtLeast(n0 + 2, 8000);
        let found = false;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const nodes = a!.nodes().nodes;
          const labels = nodes.map((n) => n.label);
          if (labels.some((l) => l.includes(QUERY)) && labelKey(nodes) !== beforeText) {
            found = true;
            break;
          }
          await sleep(200);
        }
        if (!found) {
          const seen = a!.nodes().nodes.map((n) => n.label).filter(Boolean).slice(0, 10).join("|");
          throw new Error(`enter did not search for ${QUERY} (screen: ${seen})`);
        }
        // Results load after the transition; the shot is the evidence.
        await sleep(2000);
        const evidence = await shot(a!, "06-keyboard");
        const demo = await demoSave(a!, "3-search");
        // Leave a search field focused for the browser checks: the page's own
        // text box sends to the device's caret, and that caret has to exist.
        a!.sendInput({ action: "key", key: "back" });
        await sleep(1500);
        const again = pickField(a!.nodes().nodes) ?? pickSearchEntry(a!.nodes().nodes);
        if (again) {
          await tap(a!, again.cx, again.cy);
          await sleep(800);
        }
        return {
          detail: `输入「${QUERY}」并回车后结果页出现该词；键盘走写通道`,
          evidence: [evidence, demo],
        };
      }),
    );

    results.push(
      await scenario("browser keyboard", async () => {
        // The two rules the plan asks a person to check by hand are page code
        // (a 300 ms idle flush and a composition that stays local). Driving
        // the real page here runs them every time, on the same server and
        // device as the rest of the run.
        //
        // The page types into whatever field the device has focused, so the
        // device is put on its search page first: a field that submits and
        // navigates would make the second check measure the wrong screen.
        await ensureFeed(a!, relaunchZhihu);
        const entry = pickSearchEntry(a!.nodes().nodes);
        if (!entry) throw new Error("no search entry in the top bar");
        const beforeOpen = labelKey(a!.nodes().nodes);
        await tap(a!, entry.cx, entry.cy);
        if (!(await labelsChanged(a!, beforeOpen, 6000))) {
          throw new Error("the search entry did not open");
        }
        await settle(a!);
        const from = a!.texts.length;
        a!.send({ type: "control", action: "release" });
        await a!.waitForControl("readonly", from, 6000);
        const checks = await runBrowserChecks(run.server.port, a!);
        browserChecks.push(...checks);
        const failed = checks.filter((c) => c.status === "FAIL");
        const from2 = a!.texts.length;
        a!.send({ type: "control", action: "take" });
        await a!.waitForControl("controlled", from2, 8000);
        if (failed.length > 0) {
          throw new Error(failed.map((c) => `${c.name}: ${c.detail}`).join("；"));
        }
        return {
          detail: checks.map((c) => `${c.name}（${c.detail}）`).join("；"),
          evidence: [],
        };
      }),
    );

    results.push(
      await scenario("system keys", async () => {
        // `back` must pop one page, not close the app. The previous scenarios
        // leave the device somewhere in Zhihu, so the check opens a known page
        // first: from the feed, open search, then back — a change either way
        // proves the key reached the device as a navigation, not a kill.
        await ensureFeed(a!, relaunchZhihu);
        const entry = pickSearchEntry(a!.nodes().nodes);
        if (!entry) throw new Error("no search entry in the top bar");
        const feedKey = labelKey(a!.nodes().nodes);
        await tap(a!, entry.cx, entry.cy);
        if (!(await labelsChanged(a!, feedKey, 6000))) {
          throw new Error("the search entry did not open");
        }
        const searchKey = labelKey(a!.nodes().nodes);
        a!.sendInput({ action: "key", key: "back" });
        if (!(await labelsChanged(a!, searchKey, 6000))) {
          throw new Error("back did not leave the search page");
        }
        await settle(a!);
        await ensureFeed(a!, relaunchZhihu);
        const homeBefore = labelKey(a!.nodes().nodes);
        a!.sendInput({ action: "key", key: "home" });
        // The launcher is a different bundle, not just different labels.
        await a!.until(
          () => {
            const bundle = a!.nodes().bundle;
            return Boolean(bundle) && bundle !== ZHIHU_BUNDLE;
          },
          8000,
          "the launcher's bundle",
        );
        if (labelKey(a!.nodes().nodes) === homeBefore) {
          throw new Error("home did not change the screen");
        }
        const launcher = a!.nodes().bundle;
        await sleep(600);
        // Captured now: after the relaunch below the launcher is gone. Only
        // the app grid is kept — below it sits the launcher's own search
        // history, which is the person's, not evidence.
        const homeShot = await shot(a!, "07-home", LAUNCHER_CROP_PX);
        // Leave the device in a known place for the next scenario.
        await relaunchZhihu();
        await a!.until(
          () => a!.nodes().bundle === ZHIHU_BUNDLE,
          10_000,
          "Zhihu's bundle again",
        );
        return {
          detail: `返回键退出搜索页；Home 键切到桌面（${launcher}），再冷启动回知乎`,
          evidence: [homeShot],
        };
      }),
    );

    results.push(
      await scenario("pinch", async () => {
        // The pinch needs the full-screen viewer, and reaching it takes three
        // steps: search, a result card, then that answer's own image. The
        // route is search rather than the feed because the demo frames land
        // on the site, and the feed's top card is whatever the recommendation
        // service returns — a celebrity answer on the run that was tried. A
        // query keeps the frames on the release's own subject.
        //
        // Which result carries an image is not predictable: a card can be a
        // video channel, whose page has no viewer. So the walk tries the
        // results in order and checks each landing by what the screen becomes
        // — a viewer is black behind its toolbar, an answer is white.
        //
        // A landing that is neither (a hot-topic module, an unrecognised page)
        // means a cold restart and another search. That is bounded: an
        // unbounded walk never fails, so it never finishes either, and the
        // run's finally-block never restores the screen-off timeout.
        const restarts = new RestartBudget(2);
        const openViewer = async (): Promise<{ cx: number; cy: number; dark: number }> => {
          // A cold start resets the tab and the scroll position: the previous
          // scenario leaves the device wherever Home sent it.
          await new HdcRunner({ deviceId: target })
            .shell(`aa force-stop ${ZHIHU_BUNDLE}`)
            .catch(() => undefined);
          await sleep(600);
          await relaunchZhihu();
          await a!.until(() => a!.nodes().bundle === ZHIHU_BUNDLE, 12_000, "Zhihu after restart");
          await settle(a!);
          const entry = pickSearchEntry(a!.nodes().nodes);
          if (!entry) throw new Error("no search entry in the top bar");
          const feedKey = labelKey(a!.nodes().nodes);
          await tap(a!, entry.cx, entry.cy);
          if (!(await labelsChanged(a!, feedKey, 6000))) {
            throw new Error("the search entry did not open");
          }
          await settle(a!);
          const field = pickField(a!.nodes().nodes) ?? pickSearchEntry(a!.nodes().nodes);
          if (!field) throw new Error("no search field on the search page");
          await tap(a!, field.cx, field.cy);
          await sleep(800);
          const beforeQuery = labelKey(a!.nodes().nodes);
          a!.sendInput({ action: "text", text: QUERY, x: field.cx, y: field.cy });
          await sleep(1200);
          a!.sendInput({ action: "key", key: "enter" });
          if (!(await labelsChanged(a!, beforeQuery, 8000))) {
            throw new Error(`the search for ${QUERY} did not open a results page`);
          }
          await settle(a!);

          const display = a!.nodes().display;
          if (!display) throw new Error("no display size in the layout");
          const shotViewer = async (): Promise<number> => {
            await shot(a!, "08-pinch-before");
            return meanBrightness(join(SHOT_DIR, "08-pinch-before.jpg"));
          };
          // Walk the result cards, and on each page scroll for an image. A
          // result can also be a hot-topic module rather than an article, so
          // an article without a usable image is a miss, not a failure.
          for (let round = 0; round < 3; round++) {
            const cards = pickResultCards(a!.nodes().nodes);
            for (const card of cards) {
              const resultsKey = labelKey(a!.nodes().nodes);
              await tap(a!, card.cx, card.cy);
              if (!(await labelsChanged(a!, resultsKey, 8000))) continue;
              await settle(a!);
              for (let scroll = 0; scroll < 4; scroll++) {
                const inline = pickInlineImages(a!.nodes().nodes)[0];
                if (inline) {
                  const pageKey = labelKey(a!.nodes().nodes);
                  await tap(a!, inline.cx, inline.cy);
                  if (await labelsChanged(a!, pageKey, 8000)) {
                    await sleep(1500);
                    const dark = await shotViewer();
                    if (dark <= 120) return { cx: inline.cx, cy: inline.cy, dark };
                  }
                  // Not a viewer (or the tap missed): back to the answer.
                  a!.sendInput({ action: "key", key: "back" });
                  await sleep(1200);
                  await settle(a!);
                }
                await swipe(
                  a!,
                  608,
                  Math.round(display.height * 0.8),
                  608,
                  Math.round(display.height * 0.35),
                );
                await sleep(1500);
              }
              // Back to the results; the next card is tried from there.
              a!.sendInput({ action: "key", key: "back" });
              await sleep(1500);
              await settle(a!);
              if (!isSearchResults(a!.nodes().nodes)) {
                if (!restarts.take()) {
                  throw new Error("no result led to an image viewer, and the cold-start budget is spent");
                }
                return await openViewer();
              }
            }
            await swipe(
              a!,
              608,
              Math.round(display.height * 0.8),
              608,
              Math.round(display.height * 0.3),
            );
            await sleep(1500);
            await settle(a!);
          }
          throw new Error("no result led to an image viewer");
        };

        const viewer = await openViewer();
        // The viewer before the pinch is the site's last frame: a still of
        // the zoom cannot be faked by scaling the un-zoomed one, because the
        // picture inside the viewer really is rendered larger.
        const demo = await demoSave(a!, "4-image");
        // Three segments: the first only records the baseline, the next two
        // are the real injections (LiveInput's contract). The viewer fills the
        // screen, so the centre of the display is always on the picture.
        const display = a!.nodes().display;
        const cx = display ? Math.floor(display.width / 2) : viewer.cx;
        const cy = display ? Math.floor(display.height / 2) : viewer.cy;
        for (const half of [80, 120, 160]) {
          a!.sendInput({ action: "pinch", cx, cy, half });
          await sleep(400);
        }
        await sleep(1200);
        const after = await shot(a!, "09-pinch-after");
        const demoZoomed = await demoSave(a!, "5-zoomed");
        const changed = await meanDiff(
          join(SHOT_DIR, "08-pinch-before.jpg"),
          join(SHOT_DIR, "09-pinch-after.jpg"),
        );
        if (changed < 8) throw new Error(`the pinch did not change the picture (diff ${changed.toFixed(1)})`);
        // Back out of the viewer to the answer, and capture the article.
        a!.sendInput({ action: "key", key: "back" });
        await sleep(1800);
        await settle(a!);
        const demoArticle = await demoSave(a!, "2-article");
        return {
          detail: `图片查看器内 80→120→160 双指放大；画面差异 ${changed.toFixed(1)}（阈值 8）`,
          evidence: [
            "docs/acceptance/live/screenshots/08-pinch-before.jpg",
            after,
            demo,
            demoZoomed,
            demoArticle,
          ],
        };
      }),
    );

    results.push(
      await scenario("stability", async () => {
        const baselineMs = baselineMsArg;
        const runMs = stabilityMsArg;
        // The stream carries frames only when the picture changes: an idle
        // screen measured 1.25 fps against 13.5 fps while scrolling, so an
        // idle baseline would make "input kept 90% of it" pass by arithmetic
        // alone. The baseline here is the same mixed input for one minute,
        // and the ten-minute run is compared against it — which measures what
        // the claim is about: input does not decay over a long session.
        const tick = (client: LiveClient, n: number): void => {
          const r = n % 20;
          if (r < 14) {
            // 70%: scroll. A negative step every eighth tick walks back up so
            // the run does not end a thousand screens down.
            const down = n % 8 !== 7;
            client.sendInput({ action: "wheel", x: 608, y: 1200, dy: down ? 300 : -300 });
            return;
          }
          if (r < 17) {
            // 15%: text. ASCII keeps the typing path (a paste would clobber the
            // device clipboard on every tick); the Chinese paste path is
            // already covered by the keyboard scenario.
            const field = pickField(client.nodes().nodes);
            if (field) {
              client.sendInput({ action: "text", text: "hm", x: field.cx, y: field.cy });
            } else if (isFeed(client.nodes().nodes)) {
              const entry = pickSearchEntry(client.nodes().nodes);
              if (entry) {
                client.sendInput({ action: "down", x: entry.cx, y: entry.cy });
                client.sendInput({ action: "up", x: entry.cx, y: entry.cy });
              }
            }
            return;
          }
          // 15%: back, but only where it has somewhere to go. On the feed a
          // back backgrounds the app and the rest of the run would type into
          // the launcher; the feed gets one more scroll instead.
          if (!isFeed(client.nodes().nodes)) {
            client.sendInput({ action: "key", key: "back" });
          } else {
            client.sendInput({ action: "wheel", x: 608, y: 1200, dy: 300 });
          }
        };

        const count = async (
          client: LiveClient,
          ms: number,
          withInput: boolean,
          startTick: number,
        ): Promise<{ fps: number; secs: number; ticks: number }> => {
          const startFrames = client.binaries;
          const t0 = performance.now();
          let n = startTick;
          while (performance.now() - t0 < ms) {
            if (withInput) {
              tick(client, n);
              n++;
            }
            await sleep(TICK_MS);
          }
          const secs = (performance.now() - t0) / 1000;
          return { fps: (client.binaries - startFrames) / secs, secs, ticks: n - startTick };
        };

        const baseline = await count(a!, baselineMs, true, 0);
        if (baseline.fps <= 0) throw new Error("the baseline window carried no frames");

        // Hand the lease over mid-run: close the controlling tab, assert the
        // other one is told it is read-only, then take from it and keep going.
        const handoverAt = Math.round(runMs / 2);
        const runStart = performance.now();
        // Frames are counted from here, not from the tab's connection: the
        // baseline window's frames belong to the baseline.
        const aStart = a!.binaries;
        let handedOver = false;
        let ackMs = 0;
        let ticks = 0;
        let aFrames = 0;
        let aSecs = 0;
        let bStart = b!.binaries;
        while (performance.now() - runStart < runMs) {
          if (!handedOver && performance.now() - runStart >= handoverAt) {
            aFrames = a!.binaries - aStart;
            aSecs = (performance.now() - runStart) / 1000;
            a!.close();
            const readonlyFrom = b!.texts.length;
            await b!.waitForControl("readonly", readonlyFrom, 8000);
            const takeAt = performance.now();
            b!.send({ type: "control", action: "take" });
            await b!.until(
              () =>
                b!.texts
                  .slice(readonlyFrom)
                  .some((t) => t.type === "control" && t.state === "controlled"),
              5000,
              "the new tab's takeover",
            );
            ackMs = performance.now() - takeAt;
            if (ackMs > 300) throw new Error(`handover ack ${ackMs.toFixed(0)} ms > 300 ms`);
            // Frames and seconds must cover the same window: everything the
            // handover check does is part of the second half's wall clock.
            bStart = b!.binaries;
            // The new tab is the controller now; it must be able to drive the
            // device. A wheel only proves that where the app happens to be
            // scrollable, and five minutes of mixed input can leave it on an
            // article or a search page — the check then failed on a correct
            // server. The system Home key is the position-independent proof:
            // it always leaves the app for the launcher.
            //
            // The bundle, not the labels: the feed animates on its own, so a
            // label change is not evidence that anything was injected, and
            // waiting on it resolves before the key lands.
            const beforeBundle = b!.nodes().bundle;
            b!.sendInput({ action: "key", key: "home" });
            await b!.until(
              () => b!.nodes().bundle !== beforeBundle,
              8000,
              `the new tab's Home key to leave ${beforeBundle}`,
            );
            // Back to Zhihu for the rest of the run, through the same relaunch
            // every other scenario uses.
            await relaunchZhihu();
            await sleep(2500);
            handedOver = true;
            continue;
          }
          tick(handedOver ? b! : a!, ticks);
          ticks++;
          await sleep(TICK_MS);
        }
        if (!handedOver) throw new Error("the run ended before the handover");
        const bSecs = (performance.now() - runStart) / 1000 - aSecs;
        const bFrames = b!.binaries - bStart;
        const secs = aSecs + bSecs;
        const fps = (aFrames + bFrames) / secs;
        if (fps < baseline.fps * 0.9) {
          throw new Error(
            `input ran at ${fps.toFixed(2)} fps, below 90% of the ${baseline.fps.toFixed(2)} fps baseline`,
          );
        }
        if (b!.lastControl()?.state !== "controlled") {
          throw new Error("control was not held at the end");
        }
        // The stats window keeps only the last 200 timings, so `n` cannot be
        // used as a counter across ten minutes; the latest broadcast is what
        // the page shows and what this records.
        const stats = await b!.waitForStats(6000);
        // Leave the app on its feed for a rerun.
        await new HdcRunner({ deviceId: target })
          .shell(`aa start -b ${ZHIHU_BUNDLE} -a ${ZHIHU_ABILITY}`)
          .catch(() => undefined);
        return {
          detail:
            `基线 ${baseline.fps.toFixed(2)} fps（${baseline.secs.toFixed(0)} s 同样输入）· ` +
            `长跑 ${fps.toFixed(2)} fps（${secs.toFixed(0)} s，${ticks} 次）· ` +
            `换手 ack ${ackMs.toFixed(0)} ms · ` +
            `p50 ${stats.p50.toFixed(1)} ms · p95 ${stats.p95.toFixed(1)} ms`,
          evidence: [],
        };
      }),
    );
  } catch (e) {
    process.stderr.write(`run failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  } finally {
    a?.close();
    b?.close();
    await run.close().catch(() => undefined);
    // Put the person's own screen-off timeout back.
    await new HdcRunner({ deviceId: target })
      .shell("power-shell timeout -r")
      .catch(() => undefined);
  }

  // The last controller's broadcast is the run's final latency picture; `a`
  // was closed at the handover, so its stats stop mid-run.
  const report = renderReport(env, results, b?.latestStats() ?? a?.latestStats() ?? null, browserChecks);
  await writeFile(join(OUT_DIR, "report.md"), report, "utf8");

  for (const r of results) {
    process.stdout.write(`${r.status} ${r.name} (${r.ms} ms) — ${r.detail}\n`);
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  const ran = results.filter((r) => r.status !== "SKIP").length;
  process.stdout.write(
    `${ran - failed}/${ran} passed · report ${relative(ROOT, join(OUT_DIR, "report.md")).replace(/\\/g, "/")}\n`,
  );
  return failed === 0 && ran > 0 ? 0 : 1;
}

const code = await main();
// hdc's child-process handles can outlive a finished run; the report is
// already on disk, so exit instead of waiting for the loop to drain.
process.exit(code);
