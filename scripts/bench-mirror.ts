/**
 * Mirror-quality benchmark, modelled on pinky's `pinky-mirrorbench`.
 *
 * `bench-compare.ts` answers "how long does one action take"; this answers
 * "how good is the picture". They are different questions, and a mirror can be
 * fast per action and still feel wrong if the first frame is late or the drag
 * stutters.
 *
 * Four numbers, each of them measured rather than asserted:
 *
 *   1. first frame   — from the cast being ready to the first decoded picture
 *   2. drag rate     — frames per second while a finger drags a list
 *   3. input latency — first finger move to the first frame it caused
 *   4. dropped frames— delivered frames against 60 Hz and 120 Hz slots
 *
 * Usage:
 *   unset HDC_SERVER_PORT
 *   npx tsx scripts/bench-mirror.ts --target <deviceId> [--app settings]
 *   npx tsx scripts/bench-mirror.ts --target <deviceId> --out docs/benchmarks-mirror.md
 *
 * Writes `docs/benchmarks-mirror.md` (or `--out`). No screenshot is kept: the
 * device shows a person's own settings and notifications, and this benchmark
 * only needs counts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Device, AppManager } from "uitest-sdk/drivers";
import { createCast } from "uitest-sdk/cast";
import { tagOf } from "uitest-sdk";

const ROOT = join(import.meta.dirname, "..");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  const env = process.env[`UITEST_${name.toUpperCase()}`];
  return env ?? fallback ?? "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

/** The model string the device reports; only ever used with a tag beside it. */
async function modelOf(device: Device): Promise<string> {
  const out = await device.hdc.shell("param get const.product.model").catch(() => "");
  return out.trim().split(/\r?\n/).pop()?.trim() || "unknown";
}

/**
 * Clicks the dismiss button of any system sheet sitting over the app.
 *
 * This phone shows an "应用已过期" sheet over Settings. It swallows touches, so
 * a drag that measures it would report a dead mirror for a phone that is fine.
 * The sheet is found by its own label and only ever dismissed — never "fixed"
 * by poking coordinates that happened to work once.
 */
async function dismissSheets(device: Device): Promise<number> {
  let dismissed = 0;
  for (let round = 0; round < 3; round++) {
    const tree = (await device.agent.captureLayout()) as {
      attributes?: Record<string, string>;
      children?: unknown[];
    };
    type RawNode = { attributes?: Record<string, string>; children?: RawNode[] };
    let target: { x: number; y: number } | null = null;
    const walk = (n: RawNode): void => {
      if (target) return;
      const a = n.attributes ?? {};
      const label = `${a.text ?? ""}${a.description ?? ""}`;
      if (a.clickable === "true" && /^(取消|知道了|关闭)$/.test(label.trim())) {
        const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? "");
        if (m) {
          target = {
            x: Math.round((Number(m[1]) + Number(m[3])) / 2),
            y: Math.round((Number(m[2]) + Number(m[4])) / 2),
          };
          return;
        }
      }
      for (const c of n.children ?? []) walk(c as RawNode);
    };
    walk(tree as RawNode);
    if (!target) break;
    const p = target as { x: number; y: number };
    await device.agent.click(p.x, p.y);
    dismissed++;
    await sleep(700);
  }
  return dismissed;
}

/**
 * Puts a scrollable list in front and proves it moves.
 *
 * A list that fits on the screen does not move under a drag, and a benchmark
 * run on it would report a stutter that is really "nothing to scroll". The
 * check is a real gesture and a pixel comparison, not a node attribute: some
 * builds do not mark their list `scrollable`.
 *
 * The direction is discovered, not assumed. A previous run leaves the page at
 * its bottom, where an upward swipe does nothing at all — the first version
 * took that for "not scrollable" and refused to measure a phone that was fine.
 * Each direction is tried once; the one that moved the content is the one the
 * drag then uses.
 */
async function stageList(
  device: Device,
  app: string,
): Promise<{ width: number; height: number; from: number; to: number }> {
  const apps = new AppManager(device.hdc);
  await apps.launch(app);
  await sleep(2500);
  await dismissSheets(device);

  const { width, height } = await device.agent.getDisplaySize();
  const swipe = (from: number, to: number) =>
    device.agent.swipe(width / 2, Math.round(height * from), width / 2, Math.round(height * to), {
      durationMs: 500,
      steps: 16,
    });
  const moves = async (from: number, to: number): Promise<boolean> => {
    const before = await device.agent.captureScreen();
    await swipe(from, to);
    await sleep(800);
    const after = await device.agent.captureScreen();
    return !before.equals(after);
  };

  // Up first (the common case), then down twice — a page left at its bottom
  // needs the second one to have room left to travel.
  if (await moves(0.8, 0.3)) return { width, height, from: 0.7, to: 0.3 };
  await swipe(0.3, 0.8);
  await sleep(500);
  if (await moves(0.3, 0.8)) return { width, height, from: 0.3, to: 0.7 };

  throw new Error(
    `the list did not move in either direction: ${app} is not scrollable on this screen, so a drag has nothing to measure`,
  );
}

interface FirstFrame {
  /** Daemon start plus the hdc forward. */
  setupMs: number;
  /** First chunk of any size (usually the 31-byte SPS/PPS). */
  firstChunkMs: number | null;
  /** IDR request → first picture, or null when an IDR produced no picture. */
  idrPictureMs: number | null;
  /** Nudge (a real content change) → first picture; null when the IDR sufficed. */
  nudgeToPictureMs: number | null;
}

interface DragResult {
  windowMs: number;
  frames: number;
  fps: number;
  gapsMs: number[];
  slots60: number;
  slots120: number;
  /** Moves the driver actually sent, and how fast — the input side of the rate. */
  moves: number;
  movesPerSec: number;
}

interface LatencyResult {
  samplesMs: number[];
}

/**
 * Measures all four numbers on one cast session.
 *
 * One session, not four: a daemon costs about a second to start, and the four
 * numbers are about the same stream. The first-frame sample is taken on a
 * fresh cast, before any drag has warmed the encoder — that is the number a
 * person opening a mirror actually waits for.
 */
async function run(deviceId: string, transport: "grpc" | "ws", app: string) {
  const device = await Device.connect({ deviceId });
  const model = await modelOf(device);
  const results: { firstFrame?: FirstFrame; drag?: DragResult; latency?: LatencyResult } = {};
  try {
    // A system sheet over the app swallows the nudge below, and the run then
    // reports a dead stream for a phone that is fine. Cleared before the cast
    // exists, so the clock starts on a phone a person could actually use.
    await dismissSheets(device);

    // ---- 1. first frame -------------------------------------------------
    const tSetup = performance.now();
    const cast = await createCast(device, { mode: "stream", frameRate: 60, transport });
    const setupMs = performance.now() - tSetup;

    const arrivals: number[] = [];
    const sizes: number[] = [];
    let stop = false;
    const pump = (async () => {
      for await (const chunk of cast.stream()) {
        arrivals.push(performance.now());
        sizes.push((chunk as { data: Buffer }).data.length);
        if (stop) break;
      }
    })().catch(() => undefined);

    const tReady = performance.now();
    // The encoder is dirty-region driven: a static screen sends nothing. An
    // IDR request alone was measured to return only the 31-byte parameter-set
    // frame — no picture — so a viewer that attaches to an idle phone shows
    // black until something moves. Both halves are reported separately,
    // because adding them together would report this script's own patience
    // (800 ms) as device latency:
    //
    //   idrPictureMs   — null when the IDR request produced no picture;
    //   nudgeToPictureMs — nudge (a real content change) to first picture,
    //                      which is the number a person experiences as
    //                      "how long after I touch it does the mirror react".
    const firstPictureIdx = () => sizes.findIndex((s) => s > 31);
    await cast.requestIDRFrame().catch(() => undefined);
    let idrPictureMs: number | null = null;
    {
      const until = performance.now() + 800;
      while (performance.now() < until && firstPictureIdx() < 0) await sleep(5);
      if (firstPictureIdx() >= 0) idrPictureMs = Math.round(arrivals[firstPictureIdx()]! - tReady);
    }
    let nudgeToPictureMs: number | null = null;
    if (idrPictureMs === null) {
      const { width, height } = await device.agent.getDisplaySize();
      // Both directions: a list already at its end does not move upward, and
      // the nudge would look like a dead stream. The first direction that
      // changes the picture is the one a person would have used.
      for (const dy of [-20, 20]) {
        const before = sizes.length;
        const tNudge = performance.now();
        await device.agent.touchDown(width / 2, Math.round(height / 2));
        await device.agent.touchMove(width / 2, Math.round(height / 2) + dy);
        await device.agent.touchUp(width / 2, Math.round(height / 2) + dy);
        const until = performance.now() + 2500;
        while (performance.now() < until && firstPictureIdx() < 0) await sleep(5);
        const idx = firstPictureIdx();
        if (idx >= 0) {
          nudgeToPictureMs = Math.round(arrivals[idx]! - tNudge);
          break;
        }
        // Nothing moved: let the next direction try from a quiet stream.
        void before;
      }
    }
    const firstFrame: FirstFrame = {
      setupMs: Math.round(setupMs),
      firstChunkMs: arrivals[0] !== undefined ? Math.round(arrivals[0]! - tReady) : null,
      idrPictureMs,
      nudgeToPictureMs,
    };
    results.firstFrame = firstFrame;
    if (idrPictureMs === null && nudgeToPictureMs === null) {
      stop = true;
      await cast.dispose();
      await pump;
      throw new Error("no picture frame arrived after an IDR request and a nudge in both directions");
    }

    // ---- stage the list -------------------------------------------------
    const { width, height, from, to } = await stageList(device, app);
    // The staging gestures were themselves frames; let the stream go quiet so
    // the drag window measures only the drag.
    await sleep(1500);

    // ---- 2. drag rate ---------------------------------------------------
    // The cadence is 16 ms, i.e. a 60 Hz finger. It matters: the encoder is
    // dirty-region driven, so a driver that sends 20 moves a second cannot
    // produce more than 20 fps however fast the phone is — measuring with
    // `sleep(30)` between moves reported 30 fps for a stream that does 62.
    // Deadlines are absolute so the sleep does not accumulate the RPC time.
    const dragStartIdx = arrivals.length;
    const tDown = performance.now();
    const dragSteps = 45;
    const cadenceMs = 16;
    let moves = 0;
    await device.agent.touchDown(width / 2, Math.round(height * from));
    try {
      for (let i = 1; i <= dragSteps; i++) {
        const due = tDown + i * cadenceMs;
        const now = performance.now();
        if (due > now) await sleep(due - now);
        const y = from + ((to - from) * i) / dragSteps;
        await device.agent.touchMove(width / 2, Math.round(height * y));
        moves++;
      }
    } finally {
      await device.agent.touchUp(width / 2, Math.round(height * to)).catch(() => undefined);
    }
    const tUp = performance.now();
    // A drag ends with momentum; count the settle too, then report the window.
    await sleep(600);
    const windowEnd = tUp + 400;
    const during = arrivals.slice(dragStartIdx).filter((t) => t <= windowEnd);
    const gaps = during.slice(1).map((t, i) => t - during[i]!);
    const windowMs = windowEnd - tDown;
    results.drag = {
      windowMs: Math.round(windowMs),
      frames: during.length,
      fps: Number((during.length / (windowMs / 1000)).toFixed(1)),
      gapsMs: gaps.map((g) => Number(g.toFixed(1))),
      slots60: Math.round(windowMs / 16.67),
      slots120: Math.round(windowMs / 8.33),
      moves,
      movesPerSec: Number((moves / ((tUp - tDown) / 1000)).toFixed(1)),
    };

    // ---- 3. input latency ----------------------------------------------
    // Each sample is one short drag: the clock starts at the first finger
    // move, not at touchDown, because a touch that has not moved has not
    // changed anything the encoder could send.
    //
    // The stream is allowed to go quiet first. A frame that was already on
    // its way when the sample started would otherwise be credited to this
    // move, and one sample read 1.5 ms that way — faster than the RPC that
    // caused it could possibly return.
    const latencies: number[] = [];
    for (let i = 0; i < 8; i++) {
      const quietBy = performance.now() + 3000;
      while (performance.now() < quietBy) {
        const last = arrivals[arrivals.length - 1] ?? 0;
        if (performance.now() - last > 350) break;
        await sleep(20);
      }
      const before = arrivals.length;
      // Same direction the staged list moves in, so the move really changes
      // the picture. A drag against the end of the list is a move that
      // produces no frame, and it would be reported as a 2 s timeout.
      const y0 = Math.round(height * ((from + to) / 2));
      const y1 = Math.round(height * ((from + to) / 2 + (to - from) * 0.1));
      await device.agent.touchDown(width / 2, y0);
      const tMove = performance.now();
      await device.agent.touchMove(width / 2, y1);
      await device.agent.touchUp(width / 2, y1);
      const until = performance.now() + 2000;
      let hit = -1;
      while (performance.now() < until) {
        const idx = arrivals.findIndex((t, k) => k >= before && t >= tMove);
        if (idx >= 0) {
          hit = arrivals[idx]! - tMove;
          break;
        }
        await sleep(2);
      }
      if (hit >= 0) latencies.push(Number(hit.toFixed(1)));
    }
    results.latency = { samplesMs: latencies };

    stop = true;
    await cast.dispose();
    await pump;
  } finally {
    await device.dispose();
  }
  return { model, results };
}

function report(
  deviceId: string,
  transport: string,
  app: string,
  model: string,
  r: { firstFrame?: FirstFrame; drag?: DragResult; latency?: LatencyResult },
): string {
  const ff = r.firstFrame!;
  const drag = r.drag!;
  const lat = r.latency!;
  const gapText = (p: number) => `${pct(drag.gapsMs, p).toFixed(1)} ms`;
  const latMedian = median(lat.samplesMs);
  const latMin = Math.min(...lat.samplesMs);
  const latMax = Math.max(...lat.samplesMs);
  const dropped60 = Math.max(0, drag.slots60 - drag.frames);
  const dropped120 = Math.max(0, drag.slots120 - drag.frames);

  return `# 投屏质量实测（mirrorbench）

> 由 \`scripts/bench-mirror.ts\` 生成，请勿手改。生成时间：${new Date().toISOString()}
> 设备：${model} / tag \`${tagOf(deviceId)}\`；传输 ${transport}，\`-frameRate 60\`。
> 本文件只记录计数，不保留任何截图。

## 四项指标

| 指标 | 实测 | 说明 |
|---|---|---|
| 建流（daemon + fport） | ${ff.setupMs} ms | \`createCast()\` 返回所需时间，不含首帧 |
| 首帧（IDR 请求） | ${ff.idrPictureMs === null ? "无画面" : `${ff.idrPictureMs} ms`} | 请求 IDR → 第一帧画面。静止屏幕下 IDR 只换回 31 B 的参数集帧（${ff.firstChunkMs ?? "?"} ms 到达），没有画面 |
| 首帧（轻推 20 px） | ${ff.nudgeToPictureMs === null ? "未用到" : `${ff.nudgeToPictureMs} ms`} | 一次真实内容变化 → 第一帧画面；查看器挂到静止手机上的实际等待 |
| 拖动帧率 | ${drag.fps} fps | 手指拖动列表 ${drag.windowMs} ms 内到达 ${drag.frames} 帧 |
| 拖动输入节奏 | ${drag.moves} 次移动 / ${drag.movesPerSec} 次每秒 | 编码器是脏区驱动的，帧率上限就是输入节奏；60 Hz 手指 = 16 ms 一次 |
| 帧 / 移动 | ${(drag.frames / Math.max(1, drag.moves)).toFixed(2)} | 一次手指移动平均换回多少帧；1.0 附近表示每动一下都出帧 |
| 输入→画面 | 中位 ${latMedian} ms（${latMin}–${latMax} ms，${lat.samplesMs.length} 次） | 第一次手指移动 → 它引起的第一帧 |
| 掉帧（按 60 Hz） | ${dropped60} / ${drag.slots60} | 拖动窗口内 16.67 ms 一格，应到 ${drag.slots60} 帧 |
| 掉帧（按 120 Hz） | ${dropped120} / ${drag.slots120} | 同上，按 8.33 ms 一格 |

## 帧间隔分布（拖动窗口内）

| p50 | p90 | p99 | 最大 |
|---|---|---|---|
| ${gapText(0.5)} | ${gapText(0.9)} | ${gapText(0.99)} | ${drag.gapsMs.length ? Math.max(...drag.gapsMs).toFixed(1) : "-"} ms |

## 读这些数字时必须知道的三件事

1. **编码器是脏区驱动的。** 屏幕不动就没有帧，不是卡住。首帧的触发方式写在上表里：IDR 请求只换回参数集帧，画面要等屏幕真的变化——这是查看器挂到一台静止手机上的真实体验。
2. **「掉帧」按格子算，不等于丢数据。** 设备把画面渲染在 120 Hz 上，编码器只在内容变化时出帧；一次拖动在 60 Hz 格子里「缺」的帧，可能本来就是没有变化的那几格。帧率也受输入节奏约束——编码器不会凭空造出帧，手指 16 ms 动一次最多出 60 fps。这个数字和 pinky 的 mirrorbench 同一口径，只适合横向比，不适合单独当质量结论。
3. **「输入→画面」是端到端可见延迟的近似。** 时钟在客户端，起点是手指移动指令发出，终点是第一帧到达客户端；不含显示器扫描出画面的时间。和外部高速相机量的数字不可直接比。

## 原始样本

- 首帧：setup ${ff.setupMs} ms，参数集帧 ${ff.firstChunkMs ?? "?"} ms，IDR 画面 ${ff.idrPictureMs ?? "无"}，轻推画面 ${ff.nudgeToPictureMs ?? "未用到"}
- 拖动：${drag.windowMs} ms / ${drag.frames} 帧 / ${drag.fps} fps；输入 ${drag.moves} 次移动 / ${drag.movesPerSec} 次每秒
- 帧间隔：${drag.gapsMs.join(", ")}
- 输入延迟：${lat.samplesMs.join(", ")} ms

## 复现

\`\`\`sh
unset HDC_SERVER_PORT
npx tsx scripts/bench-mirror.ts --target <deviceId> --app ${app}
\`\`\`
`;
}

async function main(): Promise<void> {
  const deviceId = arg("target");
  if (!deviceId) throw new Error("pass --target <deviceId> or set UITEST_TARGET");
  const transport = (arg("transport", "grpc") as "grpc" | "ws") ?? "grpc";
  const app = arg("app", "settings");
  const out = arg("out", join(ROOT, "docs", "benchmarks-mirror.md"));

  console.log(`bench-mirror · ${tagOf(deviceId)} · ${transport} · ${app}`);
  const { model, results } = await run(deviceId, transport, app);
  const md = report(deviceId, transport, app, model, results);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
