/**
 * Device acceptance for the live page's takeover input.
 *
 * Drives the page's own WebSocket protocol — not a private test hook — so what
 * passes here is what a browser tab can do. Scenarios 1-5 in this file cover
 * the read-only guard, takeover arbitration, tap, long press and scroll; the
 * keyboard, system key, pinch and stability runs live in the same script.
 *
 * Writes `docs/acceptance/live/report.md` and screenshots under
 * `docs/acceptance/live/screenshots/`. The report names the device by its
 * 8-character tag, never by serial.
 *
 * Usage:
 *   npx tsx scripts/acceptance-live.ts --target <device id>
 */
import { createConnection, type Socket } from "node:net";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import jpeg from "jpeg-js";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Device } from "../src/device.js";
import { startLive, liveOptions } from "../src/live/cli.js";
import { buildHandshake, decodeFrames, encodeTextFrame } from "../src/cast/ws.js";
import { deviceTag } from "../src/trace.js";
import { assertCapturable } from "./acceptance.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/acceptance/live");
const SHOT_DIR = join(OUT_DIR, "screenshots");
const STATE_DIR = join(ROOT, ".work-bench/acceptance-live");

const ZHIHU_BUNDLE = "com.zhihu.hmos";
// The device reports PhoneAbility as mainAbility; `EntryAbility` in the plan
// does not exist in this build.
const ZHIHU_ABILITY = "PhoneAbility";

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

  latestStats(): Stats | null {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i]!;
      const stats = t.stats as Stats | undefined;
      if (t.type === "control" && stats && typeof stats.p50 === "number") return stats;
    }
    return null;
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
  status: "PASS" | "FAIL";
  ms: number;
  detail: string;
  evidence: string[];
}

async function scenario(
  name: string,
  run: () => Promise<{ detail: string; evidence?: string[] }>,
): Promise<ScenarioResult> {
  const started = performance.now();
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

function pickTabTarget(nodes: NodeInfo[]): NodeInfo | null {
  for (const label of SAFE_TABS) {
    const hit = nodes.find(
      (n) => n.clickable && !n.masked && n.label.trim() === label && area(n) >= 1200,
    );
    if (hit) return hit;
  }
  return null;
}

function pickPressTarget(nodes: NodeInfo[]): NodeInfo | null {
  const candidates = nodes
    .filter(
      (n) =>
        n.clickable &&
        !n.masked &&
        !UNSAFE.test(n.label) &&
        area(n) >= 15_000 &&
        n.label.trim().length >= 8,
    )
    .sort((a, b) => b.label.length - a.label.length);
  return candidates[0] ?? null;
}

async function tap(c: LiveClient, x: number, y: number): Promise<void> {
  c.sendInput({ action: "down", x, y });
  await sleep(40);
  c.sendInput({ action: "up", x, y });
}

async function longPress(c: LiveClient, x: number, y: number): Promise<void> {
  c.sendInput({ action: "down", x, y });
  await sleep(750);
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

/** Tab bar plus system navigation: the account avatar and unread count live here. */
const BOTTOM_CROP_PX = 200;

/**
 * Strips the bottom strip from an evidence screenshot.
 *
 * The screenshots are committed, and the bottom of the screen holds the
 * signed-in account's avatar and unread badge. Neither is evidence for
 * anything this run measures, so both are cut rather than published.
 */
async function cropBottom(file: string): Promise<void> {
  const image = jpeg.decode(await readFile(file), { useTArray: true });
  const height = Math.max(1, image.height - BOTTOM_CROP_PX);
  const data = Buffer.alloc(image.width * height * 4);
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(
    data,
    0,
    0,
    data.length,
  );
  await writeFile(file, jpeg.encode({ data, width: image.width, height }, 85).data);
}

async function shot(c: LiveClient, name: string): Promise<string> {
  await mkdir(SHOT_DIR, { recursive: true });
  const from = c.texts.length;
  c.send({ type: "shot" });
  await c.until(
    () => c.texts.slice(from).some((t) => t.type === "saved"),
    15_000,
    "the screenshot",
  );
  const saved = c.texts.slice(from).find((t) => t.type === "saved")!;
  if (saved.error || !saved.path) throw new Error(`screenshot failed: ${String(saved.error)}`);
  const out = join(SHOT_DIR, `${name}.jpg`);
  await copyFile(String(saved.path), out);
  await cropBottom(out);
  return relative(ROOT, out).replace(/\\/g, "/");
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

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function preflight(target: string): Promise<Env> {
  const dev = await Device.connect({ deviceId: target });
  try {
    await assertCapturable(dev.hypium);
    const size = await dev.agent.getDisplaySize();
    const model = (await dev.hdc.shell("param get const.product.model")).trim();
    const osVersion = (await dev.hdc.shell("param get const.product.software.version")).trim();
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

function renderReport(env: Env, results: ScenarioResult[], inputStats: Stats | null): string {
  const passed = results.filter((r) => r.status === "PASS").length;
  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.status === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${r.ms} | ${r.detail} | ${r.evidence.join("<br>") || "—"} |`,
    )
    .join("\n");
  return `# live 页接管输入验收报告

- 设备：${env.tag}（${env.model}，${env.osVersion}）
- 屏幕：${env.size}
- 应用：知乎 ${env.zhihu}
- 代码：${env.commit}
- 开始：${env.startedAt}
- 结果：**${passed}/${results.length} PASS**
${inputStats ? `- 本次注入延迟：p50 ${inputStats.p50.toFixed(1)} ms · p95 ${inputStats.p95.toFixed(1)} ms · n=${inputStats.n}\n` : ""}
| 场景 | 结果 | 耗时 (ms) | 说明 | 证据 |
|---|---|---|---|---|
${rows}

> 本报告由 \`npx tsx scripts/acceptance-live.ts --target <id>\` 生成；设备只以 8 位标签出现。
> 证据截图底部裁去 ${BOTTOM_CROP_PX} px（登录账号的头像与未读角标），其余保持原始分辨率。
`;
}

async function main(): Promise<number> {
  const i = process.argv.indexOf("--target");
  const target = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.UITEST_TARGET;
  if (!target) {
    process.stderr.write("usage: npx tsx scripts/acceptance-live.ts --target <device id>\n");
    return 2;
  }
  await mkdir(SHOT_DIR, { recursive: true });
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
  try {
    a = await LiveClient.connect(run.server.port);
    b = await LiveClient.connect(run.server.port);
    const hello = await a.hello();
    const clientId = String(hello.clientId ?? "");
    if (!clientId) throw new Error("the server did not name this tab");
    await a.waitForLayout(10_000);
    await b.waitForLayout(10_000);

    results.push(
      await scenario("readonly guard", async () => {
        const before = JSON.stringify(a!.nodes().nodes);
        const seq = a!.nodesSeq;
        a!.sendInput({ action: "down", x: 100, y: 100 });
        await sleep(300);
        await a!.until(() => a!.nodesSeq > seq, 6000, "a layout after the ignored input");
        if (JSON.stringify(a!.nodes().nodes) !== before) {
          throw new Error("the node table changed without takeover");
        }
        if (a!.texts.some((t) => t.type === "control" && t.state === "controlled")) {
          throw new Error("read-only input granted control");
        }
        return { detail: "未接管时注入被忽略，节点表不变", evidence: [await shot(a!, "01-readonly")] };
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
            area(n) >= 2000,
        );
        const candidates = [pickTabTarget(nodes), ...fallback];
        for (const node of candidates) {
          if (!node) continue;
          beforeKey = labelKey(a!.nodes().nodes);
          await tap(a!, node.cx, node.cy);
          if (await labelsChanged(a!, beforeKey, 4000)) {
            used = node;
            break;
          }
          await sleep(300);
        }
        if (!used) throw new Error("no tap changed the screen");
        const stats = await a!.waitForStats(5000);
        if (stats.p50 > 20) throw new Error(`p50 ${stats.p50.toFixed(1)} ms > 20 ms`);
        if (stats.p95 > 50) throw new Error(`p95 ${stats.p95.toFixed(1)} ms > 50 ms`);
        return {
          detail: `点击「${used.label.trim().slice(0, 24)}」后画面变化；p50 ${stats.p50.toFixed(1)} ms · p95 ${stats.p95.toFixed(1)} ms · n=${stats.n}`,
          evidence: [await shot(a!, "02-tap")],
        };
      }),
    );

    results.push(
      await scenario("long press", async () => {
        const node = pickPressTarget(a!.nodes().nodes);
        if (!node) throw new Error("no safe long-press target on this screen");
        const before = a!.nodes().nodes.length;
        const beforeKey = labelKey(a!.nodes().nodes);
        await longPress(a!, node.cx, node.cy);
        const deadline = Date.now() + 5000;
        let changed = false;
        while (Date.now() < deadline) {
          const now = a!.nodes().nodes;
          if (now.length !== before || labelKey(now) !== beforeKey) {
            changed = true;
            break;
          }
          await sleep(100);
        }
        if (!changed) throw new Error("long press did not open anything");
        // A sheet animates in after the node table has already changed;
        // shooting immediately catches the surface mid-transition (black).
        await sleep(700);
        const evidence = await shot(a!, "03-long-press");
        // Close the popup without choosing anything in it.
        a!.sendInput({ action: "key", key: "back" });
        await sleep(800);
        return {
          detail: `长按「${node.label.trim().slice(0, 20)}」弹出菜单（节点 ${before} → ${a!.nodes().nodes.length}），已返回`,
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
        return {
          detail: `在 ${cx},${bottom} → ${cx},${top} 竖划后可见内容变化`,
          evidence: [await shot(a!, "04-scroll")],
        };
      }),
    );
  } catch (e) {
    process.stderr.write(`run failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  } finally {
    a?.close();
    b?.close();
    await run.close().catch(() => undefined);
  }

  const report = renderReport(env, results, a?.latestStats() ?? null);
  await writeFile(join(OUT_DIR, "report.md"), report, "utf8");

  for (const r of results) {
    process.stdout.write(
      `${r.status === "PASS" ? "PASS" : "FAIL"} ${r.name} (${r.ms} ms) — ${r.detail}\n`,
    );
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  process.stdout.write(`${results.length - failed}/${results.length} passed · report ${relative(ROOT, join(OUT_DIR, "report.md")).replace(/\\/g, "/")}\n`);
  return failed === 0 && results.length > 0 ? 0 : 1;
}

process.exitCode = await main();
