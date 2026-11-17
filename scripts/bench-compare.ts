/**
 * Measures the SDK against the hdc CLI on the same device, so the comparison
 * on the site and in docs/benchmarks.md is reproducible rather than asserted.
 *
 * The CLI numbers include everything a caller pays: spawning hdc, the shell
 * round trip, starting the uitest binary and the device-side work. That is
 * the honest comparison — nobody calls `uitest uiInput` without the wrapper.
 *
 * Usage:
 *   npx tsx scripts/bench-compare.ts --target <deviceId>
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Device, HdcRunner } from "uitest-sdk/drivers";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "benchmarks.md");

function parseTarget(): string {
  const i = process.argv.indexOf("--target");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.UITEST_TARGET) return process.env.UITEST_TARGET;
  throw new Error("pass --target <deviceId> or set UITEST_TARGET");
}

type Samples = { name: string; ms: number[]; bytes?: number[] };

async function timeIt(name: string, n: number, fn: () => Promise<unknown>): Promise<Samples> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    ms.push(Math.round(performance.now() - t));
  }
  return { name, ms };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const range = (xs: number[]): string => `${Math.min(...xs)}–${Math.max(...xs)} ms`;

async function main(): Promise<void> {
  const deviceId = parseTarget();
  const hdc = new HdcRunner({ deviceId });
  const results: Samples[] = [];

  // ------------------------------------------------------------- the SDK
  const dev = await Device.connect({ deviceId });
  try {
    const { width, height } = await dev.agent.getDisplaySize();
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);

    results.push(await timeIt("click", 10, () => dev.agent.click(cx, cy)));
    results.push(
      await timeIt("swipe", 5, () =>
        dev.agent.swipe(cx, Math.round(height * 0.7), cx, Math.round(height * 0.3), {
          durationMs: 300,
        }),
      ),
    );
    // The two official paths the site compares against: a whole-screen tree
    // through the agent, and a window-scoped tree through uitest + pull.
    results.push(await timeIt("layout", 5, () => dev.agent.captureLayout()));
    results.push(await timeIt("dump", 5, () => dev.cli.dumpLayout({})));
    const captures: Buffer[] = [];
    results.push(
      await timeIt("capture", 5, async () => {
        captures.push(await dev.agent.captureScreen());
      }),
    );
    results[results.length - 1].bytes = captures.map((b) => b.length);
  } finally {
    await dev.dispose();
  }

  // ------------------------------------------------------------- hdc CLI
  const midX = 608;
  const midY = 1344;
  results.push(await timeIt("cli-click", 10, () => hdc.shell(`uitest uiInput click ${midX} ${midY}`)));
  results.push(
    await timeIt("cli-swipe", 5, () => hdc.shell(`uitest uiInput swipe ${midX} 1900 ${midX} 900 600`)),
  );

  const local = join(ROOT, ".work-bench");
  mkdirSync(local, { recursive: true });

  const caps: Samples = { name: "cli-capture", ms: [], bytes: [] };
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const out = await hdc.shell("uitest screenCap");
    const remote = /saved to (\S+)/.exec(out)?.[1];
    if (!remote) throw new Error(`unexpected screenCap output: ${out}`);
    const file = join(local, `cap-${i}.png`);
    await hdc.pull(remote, file);
    caps.ms.push(Math.round(performance.now() - t));
    caps.bytes!.push(statSync(file).size);
  }
  results.push(caps);

  // snapshot_display writes a JPEG to the device; the pull is measured too.
  const snaps: Samples = { name: "snapshot", ms: [], bytes: [] };
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await hdc.shell(`snapshot_display -f /data/local/tmp/sd-${i}.jpeg`);
    const file = join(local, `sd-${i}.jpeg`);
    await hdc.pull(`/data/local/tmp/sd-${i}.jpeg`, file);
    snaps.ms.push(Math.round(performance.now() - t));
    snaps.bytes!.push(statSync(file).size);
  }
  results.push(snaps);

  // ---------------------------------------------------------------- report
  const by = (name: string) => results.find((r) => r.name === name)!;
  const kb = (xs?: number[]) => (xs?.length ? Math.round(Math.max(...xs) / 1024) : 0);
  const row = (label: string, sdk: Samples, cli: Samples): string =>
    `| ${label} | ${range(sdk.ms)}（中位 ${median(sdk.ms)} ms） | ${range(cli.ms)}（中位 ${median(
      cli.ms,
    )} ms） | ${(median(cli.ms) / median(sdk.ms)).toFixed(1)}× |`;

  const md = `# 实测对比：uitest-sdk 与 hdc CLI

> 由 \`scripts/bench-compare.ts\` 生成，请勿手改。生成时间：${new Date().toISOString()}
> 设备：BRA-AL00 / 1216×2688。CLI 数字包含 hdc 进程启动、shell 往返、uitest 启动与设备侧工作。
> 绝对值随设备负载浮动：多轮之间 CLI 点击中位 390–561 ms、截图 632–890 ms；
> 本文件是其中一轮，官网取另一轮的代表值。

| 操作 | 本 SDK | hdc CLI | CLI / SDK |
|---|---|---|---|
${row("点击", by("click"), by("cli-click"))}
${row("滑动（300 ms 手势 / 600 速度）", by("swipe"), by("cli-swipe"))}
${row("整屏截图（含回传）", by("capture"), by("cli-capture"))}

- SDK 截图：608×1344 JPEG，约 ${kb(by("capture").bytes)} KB。
- \`uitest screenCap\` + \`file recv\`：1216×2688 PNG，约 ${kb(by("cli-capture").bytes)} KB。
- \`snapshot_display\` + \`file recv\`：${range(by("snapshot").ms)}（中位 ${median(
    by("snapshot").ms,
  )} ms），约 ${kb(by("snapshot").bytes)} KB。

### 官方路径对比

| 能力 | 本 SDK | 官方路径 | 倍率 |
|---|---|---|---|
| 整屏截图 | agent MJPEG 中位 ${median(by("capture").ms)} ms | \`snapshot_display\` + pull 中位 ${median(
    by("snapshot").ms,
  )} ms | ${(median(by("snapshot").ms) / median(by("capture").ms)).toFixed(1)}× |
| UI 树 | \`captureLayout\` 中位 ${median(by("layout").ms)} ms | \`dumpLayout\` + pull 中位 ${median(
    by("dump").ms,
  )} ms | ${(median(by("dump").ms) / median(by("layout").ms)).toFixed(1)}× |

单次动作两边走同一个 agent RPC，时延持平；截图与 UI 树的差别来自官方路径的
「起进程 / 写文件 / 回传」，不是 RPC 本身。

连续取帧没有 CLI 等价物：\`screenCap\` 轮询约 1.4 fps（每次约 700 ms），
而 H.264 投流实测 15–89 fps（见 \`docs/03-libscreen-casting.md\`）。

## 原始样本

${results
  .map((r) => `- ${r.name}: ${r.ms.join(", ")} ms${r.bytes ? `; bytes: ${r.bytes.join(", ")}` : ""}`)
  .join("\n")}
`;

  writeFileSync(OUT, md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
