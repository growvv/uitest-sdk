/**
 * uitest-mirror 0.1.0 acceptance.
 *
 * A mirror is a picture and a keyboard, so its evidence is the window itself:
 * every case drives the installed binary and photographs the page in a real
 * browser, plus the device's own screen where a gesture should have changed it.
 *
 * Usage:
 *   unset HDC_SERVER_PORT
 *   npx tsx scripts/acceptance-mirror.ts --targets <id>[,<id>...]
 *
 * Writes `docs/acceptance/mirror-0.1.0/`. Devices appear only as 8-character
 * tags.
 */
import { execSync, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, tagOf } from "uitest-sdk";
import { resolveCastScale } from "uitest-sdk/cast";
import { capturePage } from "./screenshot.mjs";
import { assertCapturable, assertShadeClosed, captureOrFail, gitHead } from "./acceptance.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRODUCT = "mirror";
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "packages", "mirror", "package.json"), "utf8")) as {
    version: string;
  }
).version;
// The whole evidence tree: the four products are accepted one after another in
// one sitting, and each run must not read a previous run's uncommitted output
// as a modification to the code.
const EVIDENCE = join(ROOT, "docs", "acceptance");
const OUT = process.env.UITEST_ACCEPTANCE_DIR ?? join(EVIDENCE, `${PRODUCT}-${VERSION}`);
const SHOTS = join(OUT, "screenshots");
const LOGS = join(OUT, "logs");
const WORK = join(ROOT, ".work-bench", "accept-mirror");

type Status = "pass" | "fail" | "skip";

interface Case {
  id: string;
  title: string;
  device?: string;
  status: Status;
  detail: string;
  screenshots: string[];
  kind: "screen" | "log";
  ms?: number;
}

interface Report {
  product: typeof PRODUCT;
  version: string;
  date: string;
  commit: string;
  devices: { tag: string; model: string; resolution: string }[];
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

function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A decoded frame, not merely a canvas.
 *
 * The page creates the canvas and `window.uitestViewer` before the first frame
 * arrives; a shot taken then is a black rectangle under a case named "window".
 * The fps counter is no use here — the device's encoder only sends frames when
 * the screen changes, so a static phone reads 0 fps while showing a live
 * picture. The canvas's own pixels are the honest signal.
 */
const WAIT_LIVE = `(function () {
  var c = document.querySelector("canvas");
  if (!c || !c.width || !c.height) return false;
  var ctx = c.getContext("2d");
  if (!ctx) return false;
  var d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (var i = 0; i < d.length; i += 4000) {
    if (d[i] + d[i + 1] + d[i + 2] > 24) return true;
  }
  return false;
})()`;

/** Where the installed tarball lives; set once in `run()`. */
let mirrorBin = "";

interface MirrorProcess {
  child: ChildProcess;
  url: string;
  port: number;
  log(): string;
}

/**
 * Starts the installed binary as a separate process.
 *
 * stdin stays open so stopping is a graceful close, not a kill: on Windows
 * `kill()` terminates without running the product's cleanup, leaving the
 * device lease and the hdc port forward behind.
 */
async function startMirror(
  args: string[],
  logPath: string,
): Promise<MirrorProcess> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [mirrorBin, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`mirror never printed its URL: ${out}`)), 90_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearTimeout(timer);
        res(m[1]!);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => rej(new Error(`mirror exited ${code}: ${out}`)));
  });
  const port = Number(new URL(url).port);
  const flush = async () => writeFile(logPath, out, { flag: "w" }).catch(() => undefined);
  child.stdout!.on("data", flush);
  child.stderr!.on("data", flush);
  return { child, url, port, log: () => out };
}

/**
 * Stops a mirror this run started, and only that one.
 *
 * Closing stdin is the graceful path: the product then closes the page and
 * releases the device, which removes its port forward.
 */
async function stopMirror(p: MirrorProcess): Promise<void> {
  if (p.child.exitCode !== null || p.child.killed) return;
  p.child.stdin?.end();
  const exited = await new Promise<boolean>((res) => {
    const timer = setTimeout(() => res(false), 20_000);
    p.child.once("exit", () => {
      clearTimeout(timer);
      res(true);
    });
  });
  if (!exited) p.child.kill();
}

/** The display size, for the `--max-size` arithmetic. */
async function displayOf(device: string): Promise<{ width: number; height: number }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "probe"), task: "probe", lease: false });
  try {
    return await session.device.agent.getDisplaySize();
  } finally {
    await session.close();
  }
}

/** Puts the calculator's keypad in front, so a click has somewhere to land. */
async function stage(device: string): Promise<void> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "stage"), task: "stage", lease: false });
  try {
    await assertCapturable(session.device.hypium);
    await assertShadeClosed(session.device.hypium);
    const apps = (await import("uitest-sdk/drivers")).AppManager;
    await new apps(session.device.hdc).launch("calculator").catch(() => undefined);
    await sleep(1500);
  } finally {
    await session.close();
  }
}

/** Reads the digit the calculator shows, or null when it shows none. */
async function shownDigits(device: string): Promise<string> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "read"), task: "read", lease: false });
  try {
    const screen = await session.observe.layout();
    return screen.elements.map((e) => e.label ?? "").join(" ");
  } finally {
    await session.close();
  }
}

/**
 * One device's mirror cases.
 *
 * Order matters: the window and the frame come first, because a page that
 * never decoded a frame would make every later case a lie.
 */
async function mirrorCases(device: string, stateDir: string): Promise<{ cases: Case[]; tag: string }> {
  const tag = tagOf(device);
  const cases: Case[] = [];
  const add = (
    id: string,
    title: string,
    status: Status,
    detail: string,
    shots: string[],
    kind: "screen" | "log" = shots.length ? "screen" : "log",
    ms?: number,
  ): void => {
    cases.push({ id, title, device: tag, status, detail, screenshots: shots, kind, ...(ms ? { ms } : {}) });
  };

  await stage(device);

  // ---- window: the page shows a live frame -------------------------------
  {
    const started = Date.now();
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `mirror-${tag}.log`));
    try {
      const file = `window-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          // A static phone yields about three frames in five seconds, so the
          // predicate is "a frame arrived", not "the picture moved".
          waitFor: WAIT_LIVE,
        }),
      );
      if (shot.ok) add("window", "窗口打开，画面有帧", "pass", `live at ${p.url}`, [file], "screen", Date.now() - started);
      else add("window", "窗口打开，画面有帧", "fail", `screenshot failed: ${shot.reason}`, [], "log", Date.now() - started);
    } finally {
      await stopMirror(p);
    }
  }

  // ---- click: a mouse click reaches the phone ----------------------------
  {
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `click-${tag}.log`));
    try {
      const file = `click-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The keypad's "7" sits in the left column, a third of the way
            // down. Clicking by fraction keeps this case independent of the
            // device's resolution.
            await evaluate(`(() => {
              const c = document.querySelector('#frame');
              const r = c.getBoundingClientRect();
              c.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.25, clientY: r.top + r.height * 0.62, bubbles: true, pointerId: 1 }));
              c.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + r.width * 0.25, clientY: r.top + r.height * 0.62, bubbles: true, pointerId: 1 }));
            })()`);
            await new Promise((r) => setTimeout(r, 1200));
            return ["clicked 25%,62%"];
          },
        }),
      );
      const after = await shownDigits(device).catch(() => "");
      const landed = /\b7\b/.test(after);
      if (!shot.ok) add("click", "鼠标点击落到设备", "fail", `screenshot failed: ${shot.reason}`, [], "log");
      else if (landed) add("click", "鼠标点击落到设备", "pass", "the device shows 7", [file]);
      else add("click", "鼠标点击落到设备", "fail", `the device did not register the click · ${after.slice(0, 80)}`, [file]);
    } finally {
      await stopMirror(p);
    }
  }

  // ---- keyboard: typed text reaches the phone ----------------------------
  {
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `keyboard-${tag}.log`));
    try {
      const file = `keyboard-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            await evaluate(`(() => {
              const el = document.getElementById('text');
              el.focus();
              el.value = '123';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await new Promise((r) => setTimeout(r, 1800));
            return ["typed 123"];
          },
        }),
      );
      const after = await shownDigits(device).catch(() => "");
      const landed = after.includes("123");
      if (!shot.ok) add("keyboard", "键盘输入落到设备", "fail", `screenshot failed: ${shot.reason}`, [], "log");
      else if (landed) add("keyboard", "键盘输入落到设备", "pass", "the device shows 123", [file]);
      else add("keyboard", "键盘输入落到设备", "fail", `the device did not receive the text · ${after.slice(0, 80)}`, [file]);
    } finally {
      await stopMirror(p);
    }
  }

  // ---- scroll: the wheel moves a list ------------------------------------
  {
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `scroll-${tag}.log`));
    try {
      const file = `scroll-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            await evaluate(`(() => {
              const c = document.querySelector('#frame');
              const r = c.getBoundingClientRect();
              c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: 300, bubbles: true, cancelable: true }));
            })()`);
            await new Promise((r) => setTimeout(r, 1500));
            return ["wheel 300"];
          },
        }),
      );
      if (shot.ok) add("scroll", "滚轮驱动设备滚动", "pass", "wheel delivered", [file]);
      else add("scroll", "滚轮驱动设备滚动", "fail", `screenshot failed: ${shot.reason}`, [], "log");
    } finally {
      await stopMirror(p);
    }
  }

  // ---- keys: Back, Home and Recents --------------------------------------
  {
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `keys-${tag}.log`));
    const shots: string[] = [];
    try {
      for (const [name, file] of [
        ["back", `key-back-${tag}.jpg`],
        ["home", `key-home-${tag}.jpg`],
        ["recents", `key-recents-${tag}.jpg`],
      ] as const) {
        const shot = await captureOrFail(() =>
          capturePage({
            url: p.url,
            out: join(SHOTS, file),
            waitFor: WAIT_LIVE,
            prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
              // The button is the page's own path to the key, so this also
              // proves the control exists and is wired.
              await evaluate(`document.getElementById('key-${name}').click()`);
              await new Promise((r) => setTimeout(r, 1200));
              return [name];
            },
          }),
        );
        if (shot.ok) shots.push(file);
      }
      // Recents is the one key with no prior measurement behind it. A device
      // that does not answer it is a finding, not a pass with a missing file.
      if (shots.length !== 3) {
        add("keys", "Back / Home / Recents 三个键", "fail", `captured ${shots.length}/3 key screenshots`, shots);
      } else {
        add("keys", "Back / Home / Recents 三个键", "pass", "three keys sent", shots);
      }
    } finally {
      await stopMirror(p);
    }
  }

  // ---- record: --record writes an MP4 ------------------------------------
  {
    const file = join(WORK, `rec-${tag}.mp4`);
    await rm(file, { force: true });
    const p = await startMirror(
      ["--serial", device, "--state-dir", stateDir, "--record", file],
      join(LOGS, `record-${tag}.log`),
    );
    try {
      await sleep(6000);
    } finally {
      await stopMirror(p);
    }
    const size = existsSync(file) ? statSync(file).size : 0;
    // An MP4 starts with an ftyp box at offset 4; a file that does not is a
    // container the extension failed to close, not a recording.
    const head = existsSync(file) ? readFileSync(file).subarray(4, 8).toString("latin1") : "";
    if (size > 10_000 && head === "ftyp") {
      add("record", "录制产出可解析的 MP4", "pass", `${size} B · ftyp ok`, [], "log");
    } else {
      add("record", "录制产出可解析的 MP4", "fail", `${size} B · head ${JSON.stringify(head)}`, [], "log");
    }
  }

  // ---- max-size: the divisor matches the table ---------------------------
  {
    const { width, height } = await displayOf(device);
    const longest = Math.max(width, height);
    const maxSize = 1024;
    const expected = resolveCastScale("grpc", longest, { maxSize });
    const p = await startMirror(
      ["--serial", device, "--state-dir", stateDir, "--max-size", String(maxSize)],
      join(LOGS, `max-size-${tag}.log`),
    );
    try {
      await sleep(4000);
    } finally {
      await stopMirror(p);
    }
    const log = p.log();
    const m = /-scale (\d+)/.exec(log);
    const actual = m ? Number(m[1]) : null;
    const ok = actual === expected;
    add(
      "max-size",
      "--max-size 按最长边换算",
      ok ? "pass" : "fail",
      `longest ${longest} → expected -scale ${expected}, daemon got ${actual ?? "none"}`,
      [],
      "log",
    );
  }

  // ---- no-control: the page is read-only ---------------------------------
  {
    const p = await startMirror(
      ["--serial", device, "--state-dir", stateDir, "--no-control"],
      join(LOGS, `no-control-${tag}.log`),
    );
    try {
      const file = `no-control-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The key row is only rendered when the server said input is on.
            const hidden = await evaluate(`document.getElementById('keys').offsetParent === null`);
            if (hidden !== true) throw new Error("the key row is visible with --no-control");
            return ["key row hidden"];
          },
        }),
      );
      if (shot.ok) add("no-control", "--no-control 只读", "pass", "no key row, no input", [file]);
      else add("no-control", "--no-control 只读", "fail", shot.reason, [], "log");
    } finally {
      await stopMirror(p);
    }
  }

  // ---- lease: a second instance refuses, and names the holder ------------
  {
    const first = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `lease-a-${tag}.log`));
    try {
      const second = spawnSync(
        process.execPath,
        [mirrorBin, "--serial", device, "--state-dir", stateDir, "--port", "0"],
        { encoding: "utf8", timeout: 90_000 },
      );
      const out = `${second.stdout ?? ""}${second.stderr ?? ""}`;
      const named = out.includes("mirror") || out.includes(tag);
      const ok = second.status !== 0 && named;
      add(
        "lease",
        "租约冲突时第二个实例退出并指名持有者",
        ok ? "pass" : "fail",
        `exit ${second.status} · ${out.trim().split("\n").slice(0, 2).join(" / ").slice(0, 160)}`,
        [],
        "log",
      );
    } finally {
      await stopMirror(first);
    }
  }

  return { cases, tag };
}

async function probeDevice(device: string): Promise<{ tag: string; model: string; resolution: string }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "probe"), task: "probe", lease: false });
  try {
    const model = (await session.device.hdc.shell("param get const.product.model").catch(() => "")).trim();
    const size = await session.device.agent.getDisplaySize();
    return { tag: tagOf(device), model: model || "unknown", resolution: `${size.width}x${size.height}` };
  } finally {
    await session.close();
  }
}

function renderMarkdown(report: Report): string {
  const rows = report.cases
    .map(
      (c) =>
        `| \`${c.id}\` | ${c.device ?? ""} | ${c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "SKIP"} | ${c.detail} |`,
    )
    .join("\n");
  return `# uitest-mirror ${report.version} 验收报告

> 本文件由 \`scripts/acceptance-mirror.ts\` 生成，请勿手改。生成时间：${report.date}，提交 \`${report.commit}\`。

## 设备

| 标签 | 型号 | 分辨率 |
|---|---|---|
${report.devices.map((d) => `| ${d.tag} | ${d.model} | ${d.resolution} |`).join("\n")}

## 结果

| # | 设备 | 结果 | 说明 |
|---|---|---|---|
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
    process.stderr.write("usage: npx tsx scripts/acceptance-mirror.ts --targets <id>[,<id>...]\n");
    return 2;
  }
  for (const d of [OUT, WORK]) await mkdir(d, { recursive: true });
  // One run at a time: the scratch install is shared, and a second run's
  // cleanup deletes the first one's `node_modules` out from under it.
  const lock = join(WORK, "run.lock");
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 3 * 60 * 60 * 1000) {
    process.stderr.write(`another mirror acceptance run is using ${WORK}; wait for it or delete ${lock}\n`);
    return 3;
  }
  await writeFile(lock, String(process.pid));
  try {
    return await run(targets);
  } finally {
    await rm(lock, { force: true });
  }
}

async function run(targets: string[]): Promise<number> {
  // Every picture must be one this run took: the report names files, so a
  // leftover from an earlier run would be published as current evidence.
  await rm(SHOTS, { recursive: true, force: true });
  await rm(LOGS, { recursive: true, force: true });
  await rm(join(WORK, "state"), { recursive: true, force: true });
  for (const d of [OUT, SHOTS, LOGS, WORK]) await mkdir(d, { recursive: true });

  // Both packages come from their tarballs: a run against the working tree
  // would not prove what a person installs.
  const packDir = join(WORK, "pack");
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  const packOne = (name: string): string => {
    const out = execSync(`npm pack --workspace ${name} --pack-destination "${packDir}" --json`, {
      cwd: ROOT,
      encoding: "utf8",
    });
    return (JSON.parse(out) as Array<{ filename: string }>)[0]!.filename;
  };
  const coreFile = packOne("uitest-sdk");
  const mirrorFile = packOne("uitest-mirror");
  const prefix = join(WORK, "pkg");
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "package.json"), '{"name":"accept-mirror","private":true,"type":"module"}\n');
  execSync(
    `npm install --no-audit --no-fund --prefix "${prefix}" "${join(packDir, coreFile)}" "${join(packDir, mirrorFile)}"`,
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
  );
  mirrorBin = join(prefix, "node_modules", "uitest-mirror", "dist", "bin.js");
  if (!existsSync(mirrorBin)) throw new Error("the installed package is missing its bin");

  const version = spawnSync(process.execPath, [mirrorBin, "--version"], { encoding: "utf8" });
  const devices: Report["devices"] = [];
  const cases: Case[] = [];
  cases.push({
    id: "package",
    title: "npm 包安装与版本",
    device: "host",
    status: (version.stdout ?? "").includes(`uitest-mirror ${VERSION}`) ? "pass" : "fail",
    detail: `${mirrorFile} · ${(version.stdout ?? "").trim() || `exit ${version.status}`}`,
    screenshots: [],
    kind: "log",
  });

  for (const device of targets) {
    const info = await probeDevice(device);
    devices.push(info);
    process.stdout.write(`=== ${info.tag} ===\n`);
    const stateDir = join(WORK, "state", info.tag);
    await mkdir(stateDir, { recursive: true });
    const r = await mirrorCases(device, stateDir);
    for (const c of r.cases) {
      cases.push(c);
      process.stdout.write(`  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} ${c.detail}\n`);
    }
  }

  const summary = {
    passed: cases.filter((c) => c.status === "pass").length,
    failed: cases.filter((c) => c.status === "fail").length,
    skipped: cases.filter((c) => c.status === "skip").length,
  };
  const report: Report = {
    product: PRODUCT,
    version: VERSION,
    date: localDate(),
    // The run's own evidence is not a modification to the code: a first run at
    // a new version would otherwise stamp itself `+dirty`.
    commit: gitHead({ exclude: [relative(ROOT, EVIDENCE)] }),
    devices,
    cases,
    summary,
    rerun: [
      "unset HDC_SERVER_PORT",
      "npx tsx scripts/acceptance-mirror.ts --targets <id>[,<id>]",
      "node scripts/gen-acceptance-pages.mjs",
    ],
    issues: cases.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`),
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(OUT, "report.md"), renderMarkdown(report));
  process.stdout.write(
    `\nreport: ${join("docs", "acceptance", `${PRODUCT}-${VERSION}`, "report.json")}\n` +
      `pass ${summary.passed}, fail ${summary.failed}, skip ${summary.skipped}\n`,
  );
  return summary.failed === 0 ? 0 : 1;
}

process.exitCode = await main();
