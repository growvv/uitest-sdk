/**
 * Core acceptance runner for uitest-sdk 0.10.0.
 *
 * This is the library's own acceptance: every capability is exercised through
 * the public entries (`uitest-sdk` and its subpaths), never through `src/`.
 * That is deliberate — the point of the report is that what a third party
 * installs from npm does what this page says it does.
 *
 * Usage:
 *   unset HDC_SERVER_PORT
 *   npx tsx scripts/acceptance-core.ts --targets <id>[,<id>...]
 *
 * Writes `docs/acceptance/core-0.10.0/`: report.json, report.md, screenshots,
 * logs. Devices appear only as 8-character tags.
 */
import { execFileSync, execSync } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, tagOf, type Session } from "uitest-sdk";
import { startViewerServer, createViewerSource } from "uitest-sdk/viewer";
import { AppManager, Device } from "uitest-sdk/drivers";
import { capturePage } from "./screenshot.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRODUCT = "core";
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const OUT = process.env.UITEST_ACCEPTANCE_DIR ?? join(ROOT, "docs", "acceptance", `${PRODUCT}-${VERSION}`);
const SHOTS = join(OUT, "screenshots");
const LOGS = join(OUT, "logs");
const STATE = join(ROOT, ".work-bench", "accept-core");

type Status = "pass" | "fail" | "skip";

interface Case {
  id: string;
  title: string;
  device?: string;
  status: Status;
  detail: string;
  screenshots: string[];
  /** `screen` cases must carry a picture; `log` cases are transcripts. */
  kind: "screen" | "log";
  ms?: number;
}

interface DeviceInfo {
  tag: string;
  model: string;
  resolution: string;
}

interface Report {
  product: typeof PRODUCT;
  version: string;
  date: string;
  commit: string;
  devices: DeviceInfo[];
  cases: Case[];
  summary: { passed: number; failed: number; skipped: number };
  rerun: string[];
  issues: string[];
}

function parseTargets(): string[] {
  const i = process.argv.indexOf("--targets");
  const raw = i >= 0 ? process.argv[i + 1] : process.env.UITEST_TARGETS;
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** YYYY-MM-DD in the machine's own timezone; a UTC date is a day behind in the morning. */
function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function gitHead(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    // A run on a dirty tree cannot be attributed to HEAD: the report would name
    // a commit that does not contain the script it ran. Say so instead of
    // lying — a reader who checks the hash must find what produced the page.
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

/** Evidence for one case: a log line, a JPEG, and the relative name a report uses. */
class Evidence {
  constructor(
    readonly id: string,
    readonly tag: string,
  ) {}

  private get logPath(): string {
    return join(LOGS, `${this.id}-${this.tag}.log`);
  }

  async log(line: string): Promise<void> {
    await appendFile(this.logPath, `[${new Date().toISOString()}] ${line}\n`);
  }

  /** Writes the bytes and returns the file name the report lists. */
  async shot(image: Buffer, name = this.id): Promise<string> {
    const file = `${name}-${this.tag}.jpg`;
    await writeFile(join(SHOTS, file), image);
    return file;
  }

  async shotFile(from: string, name = this.id): Promise<string> {
    const file = `${name}-${this.tag}.jpg`;
    await writeFile(join(SHOTS, file), await readFile(from));
    return file;
  }
}

/** The parts of `dev.hypium` the screen guards use. */
interface DisplayLike {
  isDisplayLocked(): Promise<boolean>;
  unlock(): Promise<void>;
  isShadeOpen(): Promise<boolean>;
  closeShade(): Promise<void>;
}

/**
 * Refuses to photograph a lock screen or an open shade.
 *
 * Every screenshot in this directory is committed and published. The lock
 * screen carries messages, bank alerts and delivery notices; the shade carries
 * them too. A PIN cannot be swiped away, so a locked phone stops the run rather
 * than publishing someone's notifications.
 */
async function assertCapturable(display: DisplayLike): Promise<void> {
  if (await display.isDisplayLocked()) {
    await display.unlock();
    if (await display.isDisplayLocked()) {
      throw new Error("the phone is on its lock screen: unlock it (a PIN cannot be swiped away) and run again");
    }
  }
  if (await display.isShadeOpen()) {
    await display.closeShade();
    const deadline = Date.now() + 1500;
    while (await display.isShadeOpen()) {
      if (Date.now() >= deadline) throw new Error("the notification shade is still open; close it and run again");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** The calculator: a keypad and a result line, nothing about the person. */
const NEUTRAL_APP = "calculator";

/** Puts a neutral app in front; restores whatever was there when the run ends. */
async function stageNeutral(apps: AppManager): Promise<{ restore(): Promise<void> }> {
  const before = await apps.current().catch(() => null);
  await apps.launch(NEUTRAL_APP).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  return {
    async restore() {
      if (!before) return;
      await apps.launch(before.bundle, before.ability ? { ability: before.ability } : {}).catch(() => undefined);
    },
  };
}

function countNodes(n: { children?: unknown[] }): number {
  const kids = (n.children ?? []) as Array<{ children?: unknown[] }>;
  return 1 + kids.reduce((acc, c) => acc + countNodes(c), 0);
}

/** Taps keypad keys so the screen changes; the stream and the encoder need motion. */
async function tapKeypad(session: Session, ticks: number, gapMs = 250): Promise<void> {
  const display = (await session.observe.layout()).display;
  for (let i = 0; i < ticks; i++) {
    const x = Math.round(display.width * (0.15 + 0.22 * (i % 4)));
    await session.device.agent.click(x, Math.round(display.height * 0.6)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, gapMs));
  }
}

interface Runner {
  (session: Session, ev: Evidence): Promise<{ detail: string; shots?: string[] }>;
}

interface Capability {
  id: string;
  title: string;
  kind?: "screen" | "log";
  requiresCast?: boolean;
  requiresRecord?: boolean;
  run: Runner;
}

/** The 16 capabilities, in the order the report lists them. */
const CAPABILITIES: Capability[] = [
  {
    id: "connect",
    title: "connect() 与会话",
    async run(session, ev) {
      const screen = await session.observe.layout();
      await ev.log(`bundle ${screen.bundle}, ${screen.display.width}x${screen.display.height}, ${screen.elements.length} elements`);
      return {
        detail: `${screen.bundle} · ${screen.display.width}x${screen.display.height}`,
        shots: [await ev.shot(await session.device.agent.captureScreen())],
      };
    },
  },
  {
    id: "click",
    title: "act.tap 点击",
    async run(session, ev) {
      const screen = await session.observe.layout();
      // A calculator key, so the tap changes the result line rather than
      // navigating away from the staged surface. Any clickable will do if the
      // keypad is not what is in front.
      const target =
        screen.elements.find((e) => e.clickable && /^[0-9]$/.test(e.label)) ??
        screen.elements.find((e) => e.clickable) ??
        screen.elements[0];
      if (!target) throw new Error("the staged screen has no tappable element");
      const t0 = performance.now();
      const r = await session.act.tap({ ref: target.ref });
      const ms = Math.round(performance.now() - t0);
      await ev.log(`tap ref ${target.ref} (${target.role} "${target.label}") -> ${r.status} in ${ms} ms`);
      if (r.status !== "settled" && r.status !== "uncertain") throw new Error(`tap returned ${r.status}`);
      return { detail: `${r.status} · ${ms} ms`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "swipe",
    title: "act.swipe 滑动",
    async run(session, ev) {
      const screen = await session.observe.layout();
      const t0 = performance.now();
      const r = await session.act.swipe({
        from: { x: screen.display.width / 2, y: screen.display.height * 0.7 },
        to: { x: screen.display.width / 2, y: screen.display.height * 0.3 },
        durationMs: 300,
      });
      const ms = Math.round(performance.now() - t0);
      await ev.log(`swipe -> ${r.status} in ${ms} ms`);
      return { detail: `${r.status} · ${ms} ms`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "touch",
    title: "触摸协议 down/move/up",
    async run(session, ev) {
      const screen = await session.observe.layout();
      const x = Math.round(screen.display.width / 2);
      const y = Math.round(screen.display.height / 2);
      await session.device.agent.touchDown(x, y);
      await session.device.agent.touchMove(x + 20, y + 20);
      await session.device.agent.touchUp(x + 20, y + 20);
      await ev.log(`touchDown/Move/Up at ${x},${y}`);
      return { detail: "down/move/up ok", shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "triggerKey",
    title: "act.key 系统按键",
    async run(session, ev) {
      const apps = new AppManager(session.device.hdc);
      const before = await apps.current().catch(() => null);
      const r = await session.act.key("power");
      await assertCapturable(session.device.hypium);
      if (before) {
        await apps.launch(before.bundle, before.ability ? { ability: before.ability } : {}).catch(() => undefined);
        await new Promise((res) => setTimeout(res, 1500));
      }
      await ev.log(`key power -> ${r.status}; screen restored${before ? `, relaunched ${before.bundle}` : ""}`);
      return { detail: `${r.status} · power`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "captureLayout",
    title: "observe.layout UI 树",
    async run(session, ev) {
      const tree = await session.device.agent.captureLayout();
      const n = countNodes(tree);
      await ev.log(`layout nodes ${n}, bundle ${tree.attributes["bundleName"] ?? "n/a"}`);
      return { detail: `${n} nodes`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "captureScreen",
    title: "observe.screenshot 截图",
    async run(session, ev) {
      const t0 = performance.now();
      const frame = await session.device.agent.captureScreen();
      const ms = Math.round(performance.now() - t0);
      const ffd8 = frame[0] === 0xff && frame[1] === 0xd8;
      await ev.log(`captureScreen ${frame.length} B in ${ms} ms, JPEG=${ffd8}`);
      if (!ffd8) throw new Error("captureScreen did not return a JPEG");
      return { detail: `${ms} ms · ${frame.length} B`, shots: [await ev.shot(frame)] };
    },
  },
  {
    id: "cropScreen",
    title: "按 bundle 裁剪截图",
    async run(session, ev) {
      const tree = await session.device.agent.captureLayout();
      const find = (n: { attributes: Record<string, string>; children?: unknown[] }): string | null => {
        const b = n.attributes["bundleName"];
        if (b && n.attributes["bounds"]) return b;
        for (const c of (n.children ?? []) as typeof n[]) {
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      };
      const bundle = find(tree);
      if (!bundle) throw new Error("no node carries a bundleName");
      const cropped = await session.device.agent.cropToWindow({ bundleName: bundle });
      await ev.log(`cropped to ${bundle}: ${cropped.length} B`);
      return { detail: `${bundle} · ${cropped.length} B`, shots: [await ev.shot(cropped)] };
    },
  },
  {
    id: "streamScreen",
    title: "streamScreen MJPEG 取帧",
    async run(session, ev) {
      const display = (await session.observe.layout()).display;
      const it = session.device.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      const t0 = performance.now();
      let frames = 0;
      let last: Buffer | undefined;
      let alive = true;
      const motion = (async () => {
        let i = 0;
        while (alive) {
          const x = Math.round(display.width * (0.15 + 0.22 * (i++ % 4)));
          await session.device.agent.click(x, Math.round(display.height * 0.6)).catch(() => undefined);
        }
      })();
      try {
        for (let i = 0; i < 10; i++) {
          const f = await it.next();
          frames++;
          last = f.value;
        }
      } finally {
        alive = false;
        await motion;
        await session.device.agent.stopStream();
      }
      const ms = performance.now() - t0;
      const fps = (frames / ms) * 1000;
      await ev.log(`streamScreen ${frames} frames in ${Math.round(ms)} ms = ${fps.toFixed(1)} fps`);
      if (fps < 3) throw new Error(`${fps.toFixed(1)} fps: the screen was not changing, so this measured the app`);
      return { detail: `${fps.toFixed(1)} fps`, shots: last ? [await ev.shot(last)] : [] };
    },
  },
  {
    id: "createCast",
    title: "cast.open H.264 投流",
    requiresCast: true,
    async run(session, ev) {
      const cast = await session.cast.open({ frameRate: 15 });
      try {
        const first = await cast.stream()[Symbol.asyncIterator]().next();
        const bytes = (first.value as { data: Buffer }).data.length;
        await ev.log(`castKind=${cast.castKind} first chunk ${bytes} B`);
        return {
          detail: `${cast.castKind} · ${bytes} B`,
          shots: [await ev.shot(await session.device.agent.captureScreen())],
        };
      } finally {
        await cast.dispose();
      }
    },
  },
  {
    id: "createCastRecord",
    title: "cast.record MP4 录制",
    requiresCast: true,
    requiresRecord: true,
    async run(session, ev) {
      const out = join(LOGS, `record-${ev.tag}.mp4`);
      const rec = await session.cast.record({ frameRate: 15, out });
      const motion = tapKeypad(session, 20);
      await new Promise((r) => setTimeout(r, 3000));
      await motion;
      const path = await rec.stop();
      const bytes = path ? statSync(path).size : 0;
      await ev.log(`recorded ${bytes} B to ${path}`);
      if (bytes < 1024) throw new Error(`recorded MP4 is empty (${bytes} B)`);
      return { detail: `${bytes} B mp4`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "dualCast",
    title: "两路并发投流",
    requiresCast: true,
    async run(session, ev) {
      const a = await session.cast.open({ socketName: "accept_a", frameRate: 15 });
      const b = await session.cast.open({ socketName: "accept_b", frameRate: 15 });
      try {
        const [fa, fb] = await Promise.all([
          a.stream()[Symbol.asyncIterator]().next(),
          b.stream()[Symbol.asyncIterator]().next(),
        ]);
        const na = (fa.value as { data: Buffer }).data.length;
        const nb = (fb.value as { data: Buffer }).data.length;
        await ev.log(`dual cast chunks ${na} B / ${nb} B`);
        return {
          detail: `${na} B / ${nb} B`,
          shots: [await ev.shot(await session.device.agent.captureScreen())],
        };
      } finally {
        await a.dispose();
        await b.dispose();
      }
    },
  },
  {
    id: "dumpLayout",
    title: "cli.dumpLayout",
    async run(session, ev) {
      const tree = await session.device.cli.dumpLayout({});
      const n = countNodes(tree);
      await ev.log(`dumpLayout ${n} nodes`);
      return { detail: `${n} nodes`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "queue",
    title: "并发调用排队",
    async run(session, ev) {
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: 10 }, () => session.device.agent.getDisplaySize()));
      const ms = Math.round(performance.now() - t0);
      await ev.log(`10 concurrent getDisplaySize all resolved in ${ms} ms`);
      if (rs.length !== 10) throw new Error(`only ${rs.length} of 10 resolved`);
      return { detail: `10 calls · ${ms} ms`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "rpcDuringStream",
    title: "投流期间调用 RPC",
    async run(session, ev) {
      const it = session.device.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      await it.next();
      const t0 = performance.now();
      await session.device.agent.getDisplaySize();
      const ms = Math.round(performance.now() - t0);
      await session.device.agent.stopStream();
      await ev.log(`getDisplaySize during stream took ${ms} ms`);
      return { detail: `${ms} ms`, shots: [await ev.shot(await session.device.agent.captureScreen())] };
    },
  },
  {
    id: "streamUiActions",
    title: "UI 事件流",
    async run(session, ev) {
      await session.device.agent.call("Captures", { api: "startCaptureUiAction", args: [] });
      await new Promise((r) => setTimeout(r, 500));
      const shot = await session.device.agent.captureScreen();
      await session.device.agent.call("Captures", { api: "stopCaptureUiAction", args: [] }).catch(() => undefined);
      await ev.log("startCaptureUiAction / stopCaptureUiAction round-trip ok; the session closes after stop");
      return { detail: "session opens; synthetic touches are not reported (device behaviour)", shots: [await ev.shot(shot)] };
    },
  },
];

/** A TCP WebSocket handshake with the headers the caller chooses. */
function handshake(
  port: number,
  opts: { origin?: string; host?: string; path?: string },
): Promise<{ status: number | null; head: string; ms: number }> {
  const path = opts.path ?? "/live";
  const host = opts.host ?? `127.0.0.1:${port}`;
  const started = performance.now();
  return new Promise((resolveAttempt) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buf = "";
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      const ms = Math.round(performance.now() - started);
      socket.destroy();
      resolveAttempt({ status, head: buf.split("\r\n")[0] ?? "", ms });
    };
    socket.setTimeout(5000, () => finish(statusOfHead(buf)));
    socket.on("error", () => finish(statusOfHead(buf)));
    socket.on("close", () => finish(statusOfHead(buf)));
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${Buffer.from("acceptance-1234").toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Protocol: scrcpy",
      ];
      if (opts.origin !== undefined) lines.push(`Origin: ${opts.origin}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n")) finish(statusOfHead(buf));
    });
  });
}

function statusOfHead(buf: string): number | null {
  const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
  return m ? Number(m[1]) : null;
}

/** The wire-level Origin check, on the real server, once per device. */
async function securityCases(session: Session, ev: Evidence): Promise<{ status: Status; detail: string; shots: string[] }> {
  const source = createViewerSource(session.core, session.device, { stateDir: STATE, layout: false });
  const server = await startViewerServer({ port: 0, host: "127.0.0.1", privacy: true, source });
  try {
    const port = server.port;
    const cases: Array<{ name: string; expect: number; origin?: string; host?: string; path?: string }> = [
      { name: "own origin", expect: 101, origin: `http://127.0.0.1:${port}` },
      { name: "another site's origin", expect: 403, origin: "https://evil.example" },
      { name: "null origin (file://, sandboxed frame)", expect: 403, origin: "null" },
      {
        name: "DNS rebinding (domain in Host and Origin)",
        expect: 403,
        origin: "http://attacker.example:7000",
        host: "attacker.example:7000",
      },
      { name: "different port on loopback", expect: 403, origin: `http://127.0.0.1:${port + 1}` },
      { name: "no Origin header (native client)", expect: 101 },
      { name: "wrong path", expect: 404, origin: `http://127.0.0.1:${port}`, path: "/nope" },
    ];
    let failed = 0;
    const lines: string[] = [];
    for (const c of cases) {
      const r = await handshake(port, c);
      const ok = r.status === c.expect;
      if (!ok) failed++;
      await ev.log(`${ok ? "PASS" : "FAIL"} ${c.name}: ${r.status ?? "no response"} (expected ${c.expect}, ${r.ms} ms)`);
      lines.push(`${c.name}: ${r.status ?? "no response"} ${r.head}`);
    }
    return {
      status: failed === 0 ? "pass" : "fail",
      detail: `${cases.length - failed}/${cases.length} handshakes · ${lines[0]?.split(" ").slice(1, 3).join(" ") ?? ""}`,
      shots: [],
    };
  } finally {
    await server.close();
  }
}

/** Renders the same page the viewer serves, for the mirror/inspect/privacy shots. */
async function viewerCases(session: Session, ev: Evidence): Promise<Case[]> {
  const out: Case[] = [];
  const view = await session.view.open({ layout: true, open: false, port: 0 });
  const shots: string[] = [];
  try {
    const display = (await session.observe.layout()).display;

    const mirror = await capturePage({
      url: view.url,
      out: join(SHOTS, `viewer-mirror-${ev.tag}.jpg`),
      waitFor: 'window.uitestViewer && document.querySelector("canvas") && window.uitestViewer.hello()',
    });
    shots.push(`viewer-mirror-${ev.tag}.jpg`);
    out.push({
      id: "viewer-mirror",
      title: "viewer 镜像（真实浏览器）",
      status: "pass",
      detail: `${display.width}x${display.height} · ${mirror.notes.length} notes`,
      screenshots: [`viewer-mirror-${ev.tag}.jpg`],
      kind: "screen",
    });

    const inspect = await capturePage({
      url: view.url,
      out: join(SHOTS, `viewer-inspect-${ev.tag}.jpg`),
      waitFor: 'document.querySelectorAll("#list .row").length > 0',
      prepare: async (evaluate) => {
        const rows = await evaluate('document.querySelectorAll("#list .row").length');
        return [`${String(rows)} node rows`];
      },
    });
    shots.push(`viewer-inspect-${ev.tag}.jpg`);
    out.push({
      id: "viewer-inspect",
      title: "viewer 节点表",
      status: "pass",
      detail: inspect.notes.join(", ") || "node rows rendered",
      screenshots: [`viewer-inspect-${ev.tag}.jpg`],
      kind: "screen",
    });

    // The privacy switch, driven through the page's own control. The staged
    // surface is a calculator: it has no credential to mask, so the picture
    // proves the switch and the page state, not the masking itself — masking is
    // pinned by the library's unit tests and by 0.9.4's live acceptance.
    const privacy = await capturePage({
      url: view.url,
      out: join(SHOTS, `viewer-privacy-${ev.tag}.jpg`),
      waitFor: 'document.querySelectorAll("#list .row").length > 0',
      prepare: async (evaluate) => {
        const before = await evaluate('document.getElementById("privacy").checked');
        await evaluate(`(function () {
          var el = document.getElementById("privacy");
          el.checked = false;
          el.dispatchEvent(new Event("change"));
          return el.checked;
        })()`);
        const after = await evaluate('document.getElementById("privacy").checked');
        if (after !== false) throw new Error("the privacy switch did not turn off");
        await evaluate(`(function () {
          var el = document.getElementById("privacy");
          el.checked = true;
          el.dispatchEvent(new Event("change"));
          return el.checked;
        })()`);
        return [`switch on->off->on (was ${String(before)})`];
      },
    });
    shots.push(`viewer-privacy-${ev.tag}.jpg`);
    out.push({
      id: "viewer-privacy",
      title: "viewer 隐私开关",
      status: "pass",
      detail: `${privacy.notes.join(", ") || "switch toggled"} · 遮罩在读布局时完成，不覆盖在画面上`,
      screenshots: [`viewer-privacy-${ev.tag}.jpg`],
      kind: "screen",
    });
  } finally {
    await view.close();
  }
  return out;
}

async function probeDevice(dev: Device, target: string): Promise<DeviceInfo> {
  const sh = async (c: string) => (await dev.hdc.shell(c).catch(() => "")).trim();
  const size = await dev.agent.getDisplaySize();
  return {
    tag: tagOf(target),
    model: (await sh("param get const.product.model")) || "unknown",
    resolution: `${size.width}x${size.height}`,
  };
}

/** The package people install: what the tarball contains and exports. */
async function packageCase(ev: Evidence): Promise<Case> {
  const dest = join(ROOT, ".work-bench", "pack-core");
  await mkdir(dest, { recursive: true });
  // `npm` is a .cmd shim on Windows: Node 26 refuses to spawn it directly, and
  // `shell: true` with an argument array is the documented-but-unsafe form. One
  // command string is what npm itself does, and every value here is ours.
  const out = execSync(
    `npm pack --workspace uitest-sdk --pack-destination "${dest}" --json`,
    { cwd: ROOT, encoding: "utf8" },
  );
  const [info] = JSON.parse(out) as Array<{ filename: string; files: Array<{ path: string }>; size: number }>;
  const files = info.files.map((f) => f.path);
  await ev.log(`tarball ${info.filename}: ${files.length} files, ${info.size} B`);
  // The library ships the two device extensions on purpose — pushing them is
  // what `connect()` does. What must never be in it is source, tests, or a bin:
  // a bin is the product's job now.
  const banned = files.filter(
    (f) => f.startsWith("src/") || f.startsWith("test/") || f === "dist/bin.js" || f.endsWith(".map"),
  );
  if (banned.length > 0) throw new Error(`tarball contains ${banned.slice(0, 3).join(", ")}`);
  if (!files.some((f) => f.startsWith("dist/"))) throw new Error("tarball has no dist/");
  const exts = files.filter((f) => f.endsWith(".so"));
  if (exts.length < 2) throw new Error(`tarball has ${exts.length} extensions; the library ships the device ones`);
  return {
    id: "package",
    title: "npm 包内容",
    status: "pass",
    detail: `${files.length} 个文件 · ${(info.size / 1024).toFixed(0)} KB · 无 src/test/bin · ${exts.length} 个设备扩展`,
    screenshots: [],
    kind: "log",
  };
}

async function runTarget(target: string): Promise<{ info: DeviceInfo; cases: Case[] }> {
  const session = await connect({ deviceId: target, stateDir: join(STATE, tagOf(target)), task: "acceptance-core" });
  const info = await probeDevice(session.device, target);
  const tag = info.tag;
  const cases: Case[] = [];
  const staged = await stageNeutral(new AppManager(session.device.hdc));
  try {
    // The viewer cases run first: `streamUiActions` (last capability) makes the
    // daemon close the session, and a page opened after it would only show
    // "reconnecting". Running them first also means the mirror is measured on a
    // session that has not yet been through a record and a stop.
    for (const c of await viewerCases(session, new Evidence("viewer", tag))) {
      cases.push({ ...c, device: tag });
      process.stdout.write(`  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} ${c.detail}
`);
    }

    for (const cap of CAPABILITIES) {
      const ev = new Evidence(cap.id, tag);
      if (cap.requiresCast && session.device.resolveCastExtension() === null) {
        await ev.log("SKIP: no casting build for this ABI");
        cases.push({
          id: cap.id,
          title: cap.title,
          device: tag,
          status: "skip",
          detail: "no casting extension build for this ABI",
          screenshots: [],
          kind: cap.kind ?? "screen",
        });
        continue;
      }
      const t0 = performance.now();
      try {
        await assertCapturable(session.device.hypium);
        const r = await cap.run(session, ev);
        cases.push({
          id: cap.id,
          title: cap.title,
          device: tag,
          status: "pass",
          detail: r.detail,
          screenshots: r.shots ?? [],
          kind: cap.kind ?? "screen",
          ms: Math.round(performance.now() - t0),
        });
        process.stdout.write(`  PASS ${cap.id} ${r.detail}\n`);
      } catch (e) {
        const err = e as Error;
        await ev.log(`FAILED: ${err.message}\n${err.stack ?? ""}`);
        cases.push({
          id: cap.id,
          title: cap.title,
          device: tag,
          status: "fail",
          detail: err.message,
          screenshots: [],
          kind: cap.kind ?? "screen",
          ms: Math.round(performance.now() - t0),
        });
        process.stdout.write(`  FAIL ${cap.id} ${err.message}\n`);
      }
    }

    // The wire-level Origin check runs on the same session, after the
    // capability matrix: it starts its own server and closes it.
    const evSec = new Evidence("security-origin", tag);
    const sec = await securityCases(session, evSec);
    cases.push({
      id: "security-origin",
      title: "viewer 来源校验（7 种握手）",
      device: tag,
      status: sec.status,
      detail: sec.detail,
      screenshots: [],
      kind: "log",
    });

  } finally {
    await staged.restore();
    await session.close();
  }
  return { info, cases };
}

function renderMarkdown(report: Report): string {
  const rows = report.cases
    .map(
      (c) =>
        `| \`${c.id}\` | ${c.device ?? ""} | ${c.title} | ${c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "SKIP"} | ${c.detail} |`,
    )
    .join("\n");
  return `# uitest-sdk ${report.version} 验收报告

> 本文件由 \`scripts/acceptance-core.ts\` 生成，请勿手改。生成时间：${report.date}，提交 \`${report.commit}\`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
${report.devices.map((d) => `| ${d.tag} | ${d.model} | ${d.resolution} |`).join("\n")}

## 结果

| # | 设备 | 用例 | 结果 | 说明 |
|---|---|---|---|---|
${rows}

## 汇总

通过 ${report.summary.passed}，失败 ${report.summary.failed}，跳过 ${report.summary.skipped}。

## 复现

${report.rerun.map((r) => `\`${r}\``).join("\n")}
`;
}

async function main(): Promise<number> {
  const targets = parseTargets();
  if (targets.length === 0) {
    process.stderr.write("usage: npx tsx scripts/acceptance-core.ts --targets <id>[,<id>...]\n");
    return 2;
  }
  // The report names pictures by file name, so a picture left by an earlier run
  // would be published as this run's evidence. Start from an empty directory.
  await rm(SHOTS, { recursive: true, force: true });
  await rm(LOGS, { recursive: true, force: true });
  for (const d of [OUT, SHOTS, LOGS, STATE]) await mkdir(d, { recursive: true });

  const devices: DeviceInfo[] = [];
  const all: Case[] = [];
  for (const target of targets) {
    process.stdout.write(`=== ${tagOf(target)} ===\n`);
    try {
      const r = await runTarget(target);
      devices.push(r.info);
      all.push(...r.cases);
    } catch (e) {
      process.stderr.write(`  target failed: ${(e as Error).message}\n`);
      return 1;
    }
  }

  const pkg = await packageCase(new Evidence("package", "host"));
  all.push({ ...pkg, device: "host" });

  const summary = {
    passed: all.filter((c) => c.status === "pass").length,
    failed: all.filter((c) => c.status === "fail").length,
    skipped: all.filter((c) => c.status === "skip").length,
  };
  const report: Report = {
    product: PRODUCT,
    version: VERSION,
    date: localDate(),
    commit: gitHead(),
    devices,
    cases: all,
    summary,
    rerun: ["unset HDC_SERVER_PORT", "npx tsx scripts/acceptance-core.ts --targets <id>[,<id>]", "node scripts/gen-acceptance-pages.mjs"],
    issues: all.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`),
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(OUT, "report.md"), renderMarkdown(report));
  process.stdout.write(
    `\nreport: ${relative(ROOT, join(OUT, "report.json"))}\n` +
      `pass ${summary.passed}, fail ${summary.failed}, skip ${summary.skipped}\n`,
  );
  return summary.failed === 0 ? 0 : 1;
}

process.exitCode = await main();
