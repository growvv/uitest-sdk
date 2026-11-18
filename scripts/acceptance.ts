/**
 * Acceptance runner: exercises every capability on every target, writes the
 * evidence (screenshots, logs, runnable snippets) and renders report.md.
 *
 * The report is generated, never hand-written — a hand-written one cannot be
 * reproduced. Usage:
 *   npx tsx scripts/acceptance.ts --targets <id>[,<id>...]
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tagOf } from "uitest-sdk";
import { AppManager, Device } from "uitest-sdk/drivers";
import { createCast } from "uitest-sdk/cast";
import type { CastClient } from "uitest-sdk/cast";
import { ROOT, Evidence, ensureDirs, type Result } from "../packages/core/test/device/acceptance.helpers.js";

interface Capability {
  name: string;
  requiresCast?: boolean;
  requiresRecord?: boolean;
  run(dev: Device, ev: Evidence): Promise<string>;
}

function parseTargets(): string[] {
  const i = process.argv.indexOf("--targets");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].split(",").filter(Boolean);
  if (process.env.UITEST_TARGETS) return process.env.UITEST_TARGETS.split(",").filter(Boolean);
  return [];
}

/**
 * The column key for one target.
 *
 * Every physical device used to be `"device"`, so two phones attached at once
 * collided: `renderReport` keys its cells by `capability|env`, and the second
 * target's results silently replaced the first's. The tag is unique per serial
 * and is already what the report shows, so it doubles as the key. Loopback
 * keeps the `emulator` name — there is only ever one of those per port, and the
 * older single-target reports stay readable.
 */
export function envName(target: string): string {
  return target.startsWith("127.0.0.1") ? "emulator" : tagOf(target);
}

/**
 * The commit an acceptance report is stamped with.
 *
 * A report must be reproducible: a reader who checks the hash has to find the
 * code that produced the page. So a run on a modified tree says so.
 *
 * `exclude` is the run's own output directory. Every run writes a report and
 * screenshots into a directory that does not exist until the first run at a
 * new version, so without this every such run stamped itself `+dirty` — on a
 * clean tree, because of nothing but its own evidence. A marker that is
 * always there is a marker nobody reads.
 */
export function gitHead(opts: { root?: string; exclude?: string[] } = {}): string {
  const root = opts.root ?? ROOT;
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const paths = (opts.exclude ?? []).flatMap((p) => ["--", `:(exclude)${p}`]);
    const dirty = execFileSync("git", ["status", "--porcelain", ...paths], { cwd: root, encoding: "utf8" }).trim();
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

/** Writes an independent, runnable snippet for one capability. */
async function writeSnippet(cap: Capability): Promise<void> {
  const body = `/**
 * Minimal reproduction for "${cap.name}".
 * Run: npx tsx docs/acceptance/scripts/${cap.name}.ts --target <deviceId>
 */
import { Device } from "uitest-sdk/drivers";

const i = process.argv.indexOf("--target");
const target = i >= 0 ? process.argv[i + 1] : process.env.UITEST_TARGET;

const dev = await Device.connect({ deviceId: target });
try {
  // See the "run" branch for this capability in scripts/acceptance.ts.
  const size = await dev.agent.getDisplaySize();
  console.log("display", size);
} finally {
  await dev.dispose();
}
`;
  await writeFile(join(ROOT, "scripts", `${cap.name}.ts`), body);
}

const CAPABILITIES: Capability[] = [
  {
    name: "connect",
    async run(dev, ev) {
      const s = await dev.agent.getDisplaySize();
      await ev.log(`displaySize ${s.width}x${s.height}`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `${s.width}x${s.height}`;
    },
  },
  {
    name: "click",
    async run(dev, ev) {
      const s = await dev.agent.getDisplaySize();
      const t0 = performance.now();
      await dev.agent.click(Math.floor(s.width / 2), Math.floor(s.height / 2));
      const ms = Math.round(performance.now() - t0);
      await ev.log(`click centre took ${ms} ms`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `${ms} ms`;
    },
  },
  {
    name: "swipe",
    async run(dev, ev) {
      const s = await dev.agent.getDisplaySize();
      const t0 = performance.now();
      await dev.agent.swipe(s.width / 2, s.height * 0.7, s.width / 2, s.height * 0.3, {
        durationMs: 300,
      });
      const ms = Math.round(performance.now() - t0);
      await ev.log(`Gestures swipe took ${ms} ms`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `${ms} ms`;
    },
  },
  {
    name: "touch",
    async run(dev, ev) {
      // The touch protocol, not a gesture: a down, a move and an up at fixed
      // points. Start it in the middle of the screen — (100,100) is inside the
      // status bar, and a drag from there pulls the notification shade down
      // over every screenshot that follows.
      const s = await dev.agent.getDisplaySize();
      const x = Math.round(s.width / 2);
      const y = Math.round(s.height / 2);
      await dev.agent.touchDown(x, y);
      await dev.agent.touchMove(x + 20, y + 20);
      await dev.agent.touchUp(x + 20, y + 20);
      await ev.log(`touchDown/Move/Up completed at ${x},${y}`);
      await ev.screenshot(await dev.agent.captureScreen());
      return "ok";
    },
  },
  {
    name: "triggerKey",
    async run(dev, ev) {
      // Pressing the power key on an awake phone locks it. Without putting the
      // screen back, this screenshot — and every one after it — is the lock
      // screen, with the person's notifications on it.
      //
      // Restoring the screen is not enough on a tablet: there, waking it up
      // lands on the launcher, not on the app that was in front. That app is
      // recorded before the key is pressed and brought back afterwards, so the
      // capabilities after this one still measure the app rather than a
      // desktop that does not scroll.
      const apps = new AppManager(dev.hdc);
      const before = await apps.current().catch(() => null);
      await pressPowerKey(dev.hypium);
      if (before) {
        await apps.launch(before.bundle, before.ability ? { ability: before.ability } : {})
          .catch(() => undefined);
        // `aa start` returns before the window is mapped; a capture taken
        // immediately is the launcher, which the stream probe would then
        // measure as a still image.
        await new Promise((r) => setTimeout(r, 1500));
        await ev.log(`triggerKey 26 (power) sent, screen restored, relaunched ${before.bundle}`);
      } else {
        await ev.log("triggerKey 26 (power) sent, screen restored");
      }
      await ev.screenshot(await dev.agent.captureScreen());
      return "ok";
    },
  },
  {
    name: "captureLayout",
    async run(dev, ev) {
      const tree = await dev.agent.captureLayout();
      const n = countNodes(tree);
      await ev.log(`layout nodes ${n}, bundleName ${tree.attributes["bundleName"] ?? "n/a"}`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `${n} nodes`;
    },
  },
  {
    name: "captureScreen",
    async run(dev, ev) {
      const t0 = performance.now();
      const frame = await dev.agent.captureScreen();
      const ms = Math.round(performance.now() - t0);
      await ev.log(`captureScreen ${frame.length} B in ${ms} ms, FFD8=${frame[0] === 0xff && frame[1] === 0xd8}`);
      await ev.screenshot(frame);
      return `${ms} ms, ${frame.length} B`;
    },
  },
  {
    name: "cropToWindow",
    async run(dev, ev) {
      // The root node usually has no bundleName; the app window sits deeper.
      const tree = await dev.agent.captureLayout();
      const bundle = findBundle(tree);
      if (!bundle) throw new Error("no node in the layout carries a bundleName");
      const cropped = await dev.agent.cropToWindow({ bundleName: bundle });
      await ev.log(`cropped to ${bundle}: ${cropped.length} B`);
      await ev.screenshot(cropped);
      return `${bundle}, ${cropped.length} B`;
    },
  },
  {
    name: "streamScreen",
    async run(dev, ev) {
      const s = await dev.agent.getDisplaySize();
      const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      const t0 = performance.now();
      let frames = 0;
      let last: Buffer | undefined;
      let alive = true;
      // Taps on the keypad, not swipes: the staged surface is the calculator,
      // where a swipe moves nothing and the display only changes when a key is
      // pressed. Each tap redraws the result line, which is the change the
      // stream reports.
      const motion = (async () => {
        let i = 0;
        while (alive) {
          const x = Math.round(s.width * (0.15 + 0.22 * (i++ % 4)));
          await dev.agent.click(x, Math.round(s.height * 0.6)).catch(() => undefined);
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
        await dev.agent.stopStream();
      }
      const ms = performance.now() - t0;
      const fps = (frames / ms) * 1000;
      if (last) await ev.screenshot(last);
      await ev.log(`streamScreen ${frames} frames in ${Math.round(ms)} ms = ${fps.toFixed(1)} fps`);
      // The screen has to be somewhere that moves. A launcher that does not
      // change yields a handful of frames over ten seconds, and reporting that
      // as a pass ("0.2 fps") describes a device that streams perfectly as one
      // that cannot. Below this, the run stops with a message about the app,
      // not the transport.
      if (fps < 3) {
        throw new Error(
          `streamScreen produced ${fps.toFixed(1)} fps: the screen was not changing, ` +
            "so this measured the app rather than the stream — open a scrolling page and run again",
        );
      }
      return `${fps.toFixed(1)} fps`;
    },
  },
  {
    name: "createCast",
    async run(dev, ev) {
      const cast: CastClient = await createCast(dev, { mode: "stream", frameRate: 15 });
      try {
        const it = cast.stream()[Symbol.asyncIterator]();
        const f = await it.next();
        const bytes = (f.value as { data: Buffer }).data.length;
        await ev.log(`castKind=${cast.castKind} first chunk ${bytes} B`);
        await ev.screenshot(await dev.agent.captureScreen());
        return `${cast.castKind}, ${bytes} B`;
      } finally {
        await cast.dispose();
      }
    },
  },
  {
    name: "createCastRecord",
    requiresCast: true,
    requiresRecord: true,
    async run(dev, ev) {
      const out = join(ROOT, "logs", `record-${ev.env}.mp4`);
      const cast = await createCast(dev, { mode: "record", frameRate: 15, outputPath: out });
      const s = await dev.agent.getDisplaySize();
      let alive = true;
      // Keypad taps again: the staged surface is the calculator, and the
      // recording needs the screen to change so the encoder has something to
      // put in the file.
      const motion = (async () => {
        let i = 0;
        while (alive) {
          const x = Math.round(s.width * (0.15 + 0.22 * (i++ % 4)));
          await dev.agent.click(x, Math.round(s.height * 0.6)).catch(() => undefined);
        }
      })();
      await new Promise((r) => setTimeout(r, 3000));
      alive = false;
      await motion;
      await cast.dispose();
      const bytes = statSync(out).size;
      await ev.log(`recorded ${bytes} B to ${out}`);
      await ev.screenshot(await dev.agent.captureScreen());
      if (bytes < 1024) throw new Error(`recorded MP4 is empty (${bytes} B)`);
      return `${bytes} B mp4`;
    },
  },
  {
    name: "dualCast",
    requiresCast: true,
    async run(dev, ev) {
      const a = await createCast(dev, { mode: "stream", socketName: "accept_a", frameRate: 15 });
      const b = await createCast(dev, { mode: "stream", socketName: "accept_b", frameRate: 15 });
      try {
        const [fa, fb] = await Promise.all([
          a.stream()[Symbol.asyncIterator]().next(),
          b.stream()[Symbol.asyncIterator]().next(),
        ]);
        const na = (fa.value as { data: Buffer }).data.length;
        const nb = (fb.value as { data: Buffer }).data.length;
        await ev.log(`dual cast chunks ${na} B / ${nb} B`);
        await ev.screenshot(await dev.agent.captureScreen());
        return `${na} B / ${nb} B`;
      } finally {
        await a.dispose();
        await b.dispose();
      }
    },
  },
  {
    name: "dumpLayout",
    async run(dev, ev) {
      const tree = await dev.cli.dumpLayout({});
      const n = countNodes(tree);
      await ev.log(`dumpLayout ${n} nodes`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `${n} nodes`;
    },
  },
  {
    name: "queue",
    async run(dev, ev) {
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: 10 }, () => dev.agent.getDisplaySize()));
      const ms = Math.round(performance.now() - t0);
      await ev.log(`10 concurrent getDisplaySize all resolved in ${ms} ms`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `10 calls, ${ms} ms`;
    },
  },
  {
    name: "rpcDuringStream",
    async run(dev, ev) {
      const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      await it.next();
      const t0 = performance.now();
      await dev.agent.getDisplaySize();
      const ms = Math.round(performance.now() - t0);
      await dev.agent.stopStream();
      await ev.log(`getDisplaySize during stream took ${ms} ms`);
      await ev.screenshot(await dev.agent.captureScreen());
      return `${ms} ms`;
    },
  },
  // Kept last on purpose: `stopCaptureUiAction` makes the daemon close the
  // session (and the socket with it), so anything after it in the same connect
  // would see `agent connection closed`. That is device behaviour, not a bug.
  {
    name: "streamUiActions",
    async run(dev, ev) {
      await dev.agent.call("Captures", { api: "startCaptureUiAction", args: [] });
      await new Promise((r) => setTimeout(r, 500));
      const shot = await dev.agent.captureScreen();
      await ev.screenshot(shot);
      await dev.agent.call("Captures", { api: "stopCaptureUiAction", args: [] }).catch(() => undefined);
      await ev.log("startCaptureUiAction / stopCaptureUiAction round-trip ok; session closes after stop");
      return "session opens; synthetic touches are not reported (device behaviour)";
    },
  },
];

function countNodes(n: { children?: unknown[] }): number {
  const kids = (n.children ?? []) as Array<{ children?: unknown[] }>;
  return 1 + kids.reduce((acc, c) => acc + countNodes(c), 0);
}

/** The part of `dev.hypium` this guard needs, so a test can stand in for it. */
export interface DisplayLike {
  isDisplayLocked(): Promise<boolean>;
  unlock(): Promise<void>;
}

/** The part of `dev.hypium` the shade guard needs. */
export interface ShadeLike {
  isShadeOpen(): Promise<boolean>;
  closeShade(): Promise<void>;
}

/**
 * Makes sure the notification shade is not covering the app before evidence is
 * written.
 *
 * The `touch` capability starts at (100,100) — inside the status bar — and
 * drags from there, which on this ROM pulls the shade down. Every screenshot
 * after it would then be the person's messages, bank alerts and delivery
 * notices, which is exactly what the lock-screen guard exists to keep out of a
 * published repository. The shade is read from the window manager, not from a
 * picture, and a shade that will not close stops the run.
 *
 * The re-read is not immediate: the window manager keeps reporting the shade
 * for a beat after BACK is pressed. Measured on a phone, `closeShade()`
 * returned in 208 ms and the very next read still said open, which failed a
 * run whose shade had in fact closed. So the guard waits for the window to
 * settle, and still stops the run if it never does.
 */
export async function assertShadeClosed(
  display: ShadeLike,
  wait: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (!(await display.isShadeOpen())) return;
  await display.closeShade();
  const deadline = Date.now() + (wait.timeoutMs ?? 1500);
  const pollMs = wait.pollMs ?? 100;
  while (await display.isShadeOpen()) {
    if (Date.now() >= deadline) {
      throw new Error(
        "the notification shade is still open: close it and run again, or the next capture publishes its contents",
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Makes sure the screen is worth photographing before evidence is written.
 *
 * The lock screen is where a real person's messages, bank alerts and delivery
 * notices live, and every screenshot here is committed and published. Two ways
 * it gets captured anyway: the phone sleeps mid-run (the `triggerKey(26)` step
 * presses the power key on purpose), or it was left locked before the run.
 * A swipe cannot clear a PIN, so a phone that stays locked stops the run
 * rather than writing someone's notifications into the repository.
 */
export async function assertCapturable(display: DisplayLike): Promise<void> {
  if (!(await display.isDisplayLocked())) return;
  await display.unlock();
  if (await display.isDisplayLocked()) {
    throw new Error(
      "the phone is still on its lock screen: unlock it (a PIN cannot be swiped away) and run again",
    );
  }
}

/**
 * Sends the power key and then puts the screen back where it was.
 *
 * The capability exists to prove key events reach the device. Pressing it on an
 * awake phone locks the phone, and every later capture is then the lock screen
 * — which is where a person's notifications are. Pressing it again restores
 * the screen, so the run continues on the app it started on.
 */
export async function pressPowerKey(
  dev: DisplayLike & { pressKey(code: number): Promise<unknown> },
): Promise<void> {
  await dev.pressKey(26);
  await assertCapturable(dev);
}

/** First bundleName in the tree that also has parsable bounds. */
function findBundle(n: {
  attributes: Record<string, string>;
  children?: unknown[];
}): string | null {
  const b = n.attributes["bundleName"];
  if (b && n.attributes["bounds"]) return b;
  for (const c of (n.children ?? []) as typeof n[]) {
    const hit = findBundle(c);
    if (hit) return hit;
  }
  return null;
}

export interface EnvInfo {
  target: string;
  env: string;
  abi: string;
  model: string;
  osVersion: string;
  size: string;
  agentMd5: string;
}

async function probeEnv(dev: Device, target: string): Promise<EnvInfo> {
  const hdc = (dev as unknown as { hdc: { shell(c: string): Promise<string> } }).hdc;
  const sh = async (c: string) => (await hdc.shell(c).catch(() => "")).trim();
  const s = await dev.agent.getDisplaySize();
  return {
    target,
    env: envName(target),
    abi: await sh("param get const.product.cpu.abilist"),
    model: await sh("param get const.product.model"),
    osVersion: await sh("param get const.ohos.apiversion"),
    size: `${s.width}x${s.height}`,
    agentMd5: await sh("md5sum /data/local/tmp/agent.so"),
  };
}

/**
 * The app the run stages for its screenshots.
 *
 * Every capture here is committed and published, and the phone is whatever the
 * person left open: a feed, a chat, a profile page. A real run photographed a
 * Zhihu feed with a named author and an article about their workplace on it.
 * The system Settings root was tried next and carries the signed-in account
 * and the device's own name; "About phone" carries the baseband and the build.
 * The calculator is a keypad and a result line — nothing about the person —
 * and a key press redraws the result, which the stream probe needs.
 */
export const NEUTRAL_APP = "calculator";

/** The parts of `AppManager` this guard needs, so a test can stand in for it. */
export interface StageLike {
  current(): Promise<{ bundle: string; ability?: string } | null>;
  launch(app: string, opts?: { ability?: string }): Promise<unknown>;
}

/**
 * Puts a neutral app in front and remembers what to put back.
 *
 * The capabilities are about the SDK, not about what was on screen, so the
 * screen is staged before the first capture and the person's app is restored
 * in the run's `finally` — a failed run must not leave their phone on the
 * calculator either.
 */
export async function stageNeutralSurface(
  apps: StageLike,
): Promise<{ restore(): Promise<void> }> {
  const before = await apps.current().catch(() => null);
  await apps.launch(NEUTRAL_APP).catch(() => undefined);
  // `aa start` returns before the window is mapped; a capture taken
  // immediately is whatever was there before.
  await new Promise((r) => setTimeout(r, 1500));
  return {
    async restore() {
      if (!before) return;
      await apps
        .launch(before.bundle, before.ability ? { ability: before.ability } : {})
        .catch(() => undefined);
    },
  };
}

async function runTarget(target: string): Promise<{ results: Result[]; info: EnvInfo }> {
  const results: Result[] = [];
  const dev = await Device.connect({ deviceId: target, ownDaemon: true });
  const info = await probeEnv(dev, target);
  const env = info.env;
  const staged = await stageNeutralSurface(new AppManager(dev.hdc));
  try {
    for (const cap of CAPABILITIES) {
      const ev = new Evidence(cap.name, env);
      if (cap.requiresCast && dev.resolveCastExtension() === null) {
        await ev.log("SKIP: no casting build for this ABI");
        results.push({
          capability: cap.name,
          env,
          status: "SKIP",
          detail: "no casting extension build for this ABI",
        });
        continue;
      }
      const t0 = performance.now();
      try {
        // `triggerKey(26)` presses the power key, so from that capability on
        // the phone may be asleep; every capture after it would otherwise be
        // the lock screen.
        await assertCapturable(dev.hypium);
        await assertShadeClosed(dev.hypium);
        const detail = await cap.run(dev, ev);
        results.push({
          capability: cap.name,
          env,
          status: "PASS",
          ms: Math.round(performance.now() - t0),
          detail,
          screenshot: join(ROOT, "screenshots", `${cap.name}-${env}.png`),
          log: join(ROOT, "logs", `${cap.name}-${env}.log`),
        });
      } catch (e) {
        const err = e as Error;
        await ev.log(`FAILED: ${err.message}\n${err.stack ?? ""}`);
        results.push({
          capability: cap.name,
          env,
          status: "FAIL",
          ms: Math.round(performance.now() - t0),
          detail: err.message,
          log: join(ROOT, "logs", `${cap.name}-${env}.log`),
        });
      }
    }
  } finally {
    // Put back what the person had open. A failed run must not leave their
    // phone on the calculator.
    await staged.restore();
    await dev.dispose();
  }
  return { results, info };
}

function cell(r: Result | undefined): string {
  if (!r) return "—";
  const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "SKIP";
  return r.detail ? `${icon} ${r.detail}` : icon;
}

export function renderReport(infos: EnvInfo[], results: Result[]): string {
  const envs = infos.map((i) => i.env);
  const byKey = new Map(results.map((r) => [`${r.capability}|${r.env}`, r]));

  const envRows: Array<[string, (i: EnvInfo) => string]> = [
    // The serial never leaves the machine: report.md is committed, so the
    // 设备 ID row shows the same short tag the trace, the lease files and
    // sn() use. Being the same hash matters — a reader compares the report
    // against a log, and two different hashes of one serial would not match.
    ["设备 ID", (i) => tagOf(i.target)],
    ["型号", (i) => i.model],
    ["API 版本", (i) => i.osVersion],
    ["ABI", (i) => i.abi],
    ["分辨率", (i) => i.size],
    ["agent.so md5", (i) => i.agentMd5],
  ];

  const envTable = [
    "| 项 | " + envs.join(" | ") + " |",
    "|---|" + envs.map(() => "---").join("|") + "|",
    ...envRows.map(
      ([label, get]) =>
        `| ${label} | ` + infos.map((i) => String(get(i) ?? "")).join(" | ") + " |",
    ),
  ].join("\n");

  const funcTable = [
    "| 能力 | " + envs.join(" | ") + " |",
    "|---|" + envs.map(() => "---").join("|") + "|",
    ...CAPABILITIES.map(
      (c) =>
        `| \`${c.name}\` | ` +
        envs.map((e) => cell(byKey.get(`${c.name}|${e}`))).join(" | ") +
        " |",
    ),
  ].join("\n");

  const perf = results
    .filter((r) => r.status === "PASS" && r.ms !== undefined)
    .map((r) => `| \`${r.capability}\` | ${r.env} | ${r.ms} ms |`)
    .join("\n");

  const problems = results.filter((r) => r.status !== "PASS");
  const problemList =
    problems.length === 0
      ? "_无_"
      : problems
          .map((r) => `- **${r.capability}** (${r.env}): ${r.status} — ${r.detail ?? ""}`)
          .join("\n");

  return `# uitest SDK 验收报告

> 本文件由 \`scripts/acceptance.ts\` 生成，请勿手改。生成时间：${new Date().toISOString()}

## 1. 环境清单

${envTable}

## 2. 功能验收表

${funcTable}

## 3. 性能（各能力端到端耗时）

| 能力 | 环境 | 耗时 |
|---|---|---|
${perf || "| — | — | — |"}

## 4. 失败与跳过项

${problemList}

## 5. 附录

- 截图：\`docs/acceptance/screenshots/\`（每个能力 × 环境一张，由 SDK 自己的 \`captureScreen()\` 产出）
- 日志：\`docs/acceptance/logs/\`（含时间戳与耗时）
- 最小复现脚本：\`docs/acceptance/scripts/\`

多实例专项验收见 \`test/device/multi-instance.test.ts\`（6 用例，独立进程）。
`;
}

async function main(): Promise<void> {
  const targets = parseTargets();
  if (targets.length === 0) {
    console.error("usage: npx tsx scripts/acceptance.ts --targets <id>[,<id>...]");
    process.exit(2);
  }

  await ensureDirs();
  for (const cap of CAPABILITIES) await writeSnippet(cap);

  const infos: EnvInfo[] = [];
  const results: Result[] = [];
  for (const target of targets) {
    console.log(`=== ${target} ===`);
    try {
      const r = await runTarget(target);
      infos.push(r.info);
      results.push(...r.results);
      for (const x of r.results) console.log(`  ${x.status.padEnd(4)} ${x.capability} ${x.detail ?? ""}`);
    } catch (e) {
      console.error(`  target failed: ${(e as Error).message}`);
    }
  }

  await writeFile(join(ROOT, "report.md"), renderReport(infos, results));
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\nreport: ${join(ROOT, "report.md")}`);
  console.log(`pass ${results.filter((r) => r.status === "PASS").length}, fail ${failed.length}, skip ${results.filter((r) => r.status === "SKIP").length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// Only run when executed directly. Importing this file (the report renderer has
// a unit test) must not connect to a device and call process.exit().
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) void main();
