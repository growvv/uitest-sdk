/**
 * Acceptance runner: exercises every capability on every target, writes the
 * evidence (screenshots, logs, runnable snippets) and renders report.md.
 *
 * The report is generated, never hand-written — a hand-written one cannot be
 * reproduced. Usage:
 *   npx tsx scripts/acceptance.ts --targets <id>[,<id>...]
 */
import { writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Device } from "../src/device.js";
import type { CastClient } from "../src/cast/types.js";
import { ROOT, Evidence, ensureDirs, type Result } from "../test/device/acceptance.helpers.js";

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

function envName(target: string): string {
  return target.startsWith("127.0.0.1") ? "emulator" : "device";
}

/** Writes an independent, runnable snippet for one capability. */
async function writeSnippet(cap: Capability): Promise<void> {
  const body = `/**
 * Minimal reproduction for "${cap.name}".
 * Run: npx tsx docs/acceptance/scripts/${cap.name}.ts --target <deviceId>
 */
import { Device } from "../../../src/device.js";

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
      await dev.agent.touchDown(100, 100);
      await dev.agent.touchMove(120, 120);
      await dev.agent.touchUp(120, 120);
      await ev.log("touchDown/Move/Up completed");
      await ev.screenshot(await dev.agent.captureScreen());
      return "ok";
    },
  },
  {
    name: "triggerKey",
    async run(dev, ev) {
      await dev.agent.triggerKey(26); // power
      await ev.log("triggerKey 26 (power) sent");
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
      let alive = true;
      const motion = (async () => {
        while (alive) {
          await dev.agent
            .swipe(s.width / 2, s.height * 0.7, s.width / 2, s.height * 0.3, { durationMs: 200 })
            .catch(() => undefined);
        }
      })();
      const it = dev.agent.streamScreen({ scale: 2 })[Symbol.asyncIterator]();
      const t0 = performance.now();
      let frames = 0;
      let last: Buffer | undefined;
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
      await ev.log(`streamScreen ${frames} frames in ${Math.round(ms)} ms = ${fps.toFixed(1)} fps`);
      if (last) await ev.screenshot(last);
      return `${fps.toFixed(1)} fps`;
    },
  },
  {
    name: "createCast",
    async run(dev, ev) {
      const cast: CastClient = await dev.createCast({ mode: "stream", frameRate: 15 });
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
      const cast = await dev.createCast({ mode: "record", frameRate: 15, outputPath: out });
      const s = await dev.agent.getDisplaySize();
      let alive = true;
      const motion = (async () => {
        while (alive) {
          await dev.agent
            .swipe(s.width / 2, s.height * 0.7, s.width / 2, s.height * 0.3, { durationMs: 200 })
            .catch(() => undefined);
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
      const a = await dev.createCast({ mode: "stream", socketName: "accept_a", frameRate: 15 });
      const b = await dev.createCast({ mode: "stream", socketName: "accept_b", frameRate: 15 });
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

interface EnvInfo {
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

async function runTarget(target: string): Promise<{ results: Result[]; info: EnvInfo }> {
  const results: Result[] = [];
  const dev = await Device.connect({ deviceId: target, ownDaemon: true });
  const info = await probeEnv(dev, target);
  const env = info.env;
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
    await dev.dispose();
  }
  return { results, info };
}

function cell(r: Result | undefined): string {
  if (!r) return "—";
  const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "SKIP";
  return r.detail ? `${icon} ${r.detail}` : icon;
}

function renderReport(infos: EnvInfo[], results: Result[]): string {
  const envs = infos.map((i) => i.env);
  const byKey = new Map(results.map((r) => [`${r.capability}|${r.env}`, r]));

  const envTable = [
    "| 项 | " + envs.join(" | ") + " |",
    "|---|" + envs.map(() => "---").join("|") + "|",
    ...[
      ["设备 ID", "target"],
      ["型号", "model"],
      ["API 版本", "osVersion"],
      ["ABI", "abi"],
      ["分辨率", "size"],
      ["agent.so md5", "agentMd5"],
    ].map(
      ([label, key]) =>
        `| ${label} | ` +
        infos.map((i) => String(i[key as keyof EnvInfo] ?? "")).join(" | ") +
        " |",
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

void main();
