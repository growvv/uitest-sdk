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
  /** The product's own pid: its daemons are named `uitest_live_<pid>`. */
  pid: number | undefined;
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
  const flush = () => {
    void writeFile(logPath, out, { flag: "w" }).catch(() => undefined);
  };
  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`mirror never printed its URL: ${out}`)), 90_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      flush();
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
  return { child, url, port, pid: child.pid, log: () => out };
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

/**
 * Puts the calculator's keypad in front and proves it got there.
 *
 * The launch used to be fire-and-forget. On a phone left asleep, `launch` is a
 * no-op on the lock screen, and every later case then drove a page whose
 * picture was the lock screen — the leather-case notice that covered this
 * phone made the click case fail with "the device did not register the click"
 * when the click was fine and the screen underneath was wrong.
 *
 * A run spends several minutes driving a browser, and a real phone does what
 * it likes in that time: it sleeps, it drifts back to the launcher, a system
 * sheet appears. So this is called before *every* case that needs the keypad,
 * not once at the start, and it retries rather than trusting one launch.
 */
async function stage(device: string): Promise<void> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "stage"), task: "stage", lease: false });
  try {
    const apps = (await import("uitest-sdk/drivers")).AppManager;
    const manager = new apps(session.device.hdc);
    const keypadUp = (screen: { elements: Array<{ role: string; node: { attributes: Record<string, string> } }> }): boolean =>
      screen.elements.some((e) => e.role === "button" && /^keyCode_\d+$/.test(e.node.attributes.id ?? ""));

    for (let attempt = 0; attempt < 3; attempt++) {
      await assertCapturable(session.device.hypium);
      await assertShadeClosed(session.device.hypium);
      await manager.launch("calculator").catch(() => undefined);
      await sleep(2000);

      // A system notice (the leather-case sheet on this phone) can sit on top
      // of the app and swallow every touch. Dismissing it is not "fixing the
      // test": without it the run would report a broken mirror while the
      // mirror works.
      for (let i = 0; i < 3; i++) {
        const screen = await session.observe.layout();
        const dismiss = screen.elements.find((e) => e.label === "知道了");
        if (!dismiss) break;
        await session.core.tap({ ref: dismiss.ref });
        await sleep(1200);
      }

      // Launching an app that is already open resumes it where it was, which
      // for the scroll case is its history screen. Every interactive case
      // needs the keypad, so leave the history screen if it is showing.
      let screen = await session.observe.layout();
      const historyBack = screen.elements.find((e) => e.label === "history back icon");
      if (historyBack) {
        await session.core.tap({ ref: historyBack.ref });
        await sleep(1500);
        screen = await session.observe.layout();
      }
      if (keypadUp(screen)) return;
    }
    const screen = await session.observe.layout();
    throw new Error(
      `the calculator's keypad is not in front (bundle ${screen.bundle}, ${screen.elements.length} elements); unlock the phone and run again`,
    );
  } finally {
    await session.close();
  }
}

/**
 * What the calculator currently shows.
 *
 * The display is the screen's focused input; its label is the expression, and
 * a finished sum also renders a `text` element with the value. Both are read
 * because a case may assert on either ("7" is in the expression, "123" may be
 * the value). Reading every label joined by spaces was too loose: the keypad's
 * own "7" button is a label too, so "does the device show 7" was true before
 * any click landed.
 */
async function calculatorState(
  device: string,
): Promise<{ expression: string; value: string; bundle: string; labels: string[]; field: boolean }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "read"), task: "read", lease: false });
  try {
    const screen = await session.observe.layout();
    const field = screen.elements.find((e) => e.input);
    const value = screen.elements.find((e) => e.role === "text");
    return {
      expression: field?.label ?? "",
      value: value?.label ?? "",
      bundle: screen.bundle,
      labels: screen.elements.map((e) => e.label ?? ""),
      // Whether the keypad was even up. An empty expression on the launcher
      // reads the same as an empty one on a cleared keypad, and a case that
      // treats those alike reports a mirror defect for a phone that drifted.
      field: field !== undefined,
    };
  } finally {
    await session.close();
  }
}

/** Clears the calculator's display, so a case starts from a known screen. */
async function clearCalculator(device: string): Promise<void> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "clear"), task: "clear", lease: false });
  try {
    // "AC" is `keyCode_16`: its label is rendered by a symbol child, so the id
    // is the only stable handle. Tapped twice because the first press may
    // clear an entry while a second clears the whole expression.
    for (let i = 0; i < 2; i++) {
      const screen = await session.observe.layout();
      const ac = screen.elements.find((e) => e.node.attributes.id === "keyCode_16");
      if (!ac) return;
      await session.core.tap({ ref: ac.ref });
      await sleep(400);
    }
  } finally {
    await session.close();
  }
}

/**
 * Opens the calculator's history list with enough rows to scroll.
 *
 * The history screen is a `list` whose rows are the person's own past sums —
 * a list that fits does not move under a wheel, so a scroll case on a fresh
 * phone would be a claim about nothing. Eight finished sums are seeded from
 * the keypad; the screen is then opened and its list confirmed scrollable.
 */
async function seedHistory(device: string): Promise<void> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "seed"), task: "seed", lease: false });
  try {
    const { AppManager } = await import("uitest-sdk/drivers");
    await new AppManager(session.device.hdc).launch("calculator").catch(() => undefined);
    await sleep(2000);

    // Leave the history screen if a previous case opened it.
    let screen = await session.observe.layout();
    const back = screen.elements.find((e) => e.label === "history back icon");
    if (back) {
      await session.core.tap({ ref: back.ref });
      await sleep(1200);
    }

    // Eight sums: a digit then equals. The equals key is `keyCode_18`, whose
    // label is a symbol, so the id is the only stable handle.
    for (let i = 1; i <= 8; i++) {
      for (const id of [`keyCode_${i % 10}`, "keyCode_18"]) {
        const now = await session.observe.layout();
        const key = now.elements.find((e) => e.node.attributes.id === id);
        if (!key) continue;
        await session.core.tap({ ref: key.ref });
        await sleep(280);
      }
    }

    screen = await session.observe.layout();
    const go = screen.elements.find((e) => e.label === "history record go");
    if (!go) throw new Error("the calculator has no history button on this build");
    await session.core.tap({ ref: go.ref });
    await sleep(1500);

    const list = (await session.observe.layout()).elements.find((e) => e.role === "list");
    if (!list?.scrollable) throw new Error("the history list is not scrollable, so a wheel has nothing to move");
  } finally {
    await session.close();
  }
}

/**
 * The `-scale` the casting daemon of *this* mirror was started with.
 *
 * The daemon lives on the device and its argv is the only place `-scale`
 * appears — the product's stdout never prints it. The socket name carries the
 * mirror's own pid (`uitest_live_<pid>`), so this reads that daemon and not a
 * leftover from an earlier run or another tool.
 */
async function daemonScale(device: string, pid: number | undefined): Promise<number | null> {
  if (pid === undefined) return null;
  const session = await connect({ deviceId: device, stateDir: join(WORK, "probe"), task: "probe", lease: false });
  try {
    const out = await session.device.hdc.shell("ps -ef");
    const line = out.split(/\r?\n/).find((l) => l.includes(`uitest_live_${pid} `) || l.includes(`uitest_live_${pid}\r`));
    const m = /-scale (\d+)/.exec(line ?? "");
    return m ? Number(m[1]) : null;
  } finally {
    await session.close();
  }
}

/**
 * The device's screen-off timeout, and the override on it.
 *
 * `power-shell timeout` only prints usage, so the values come from the power
 * manager's dump, which reports both on one line:
 * `ScreenOffTime: Timeout=600000ms  OverrideTimeout=3600000ms`. `Timeout` is
 * the person's setting; `OverrideTimeout` is what `-o` installed and `-r`
 * removes. Reading only the first field made `--stay-awake` look broken when
 * it was working — the setting is deliberately left alone.
 */
async function screenTimeout(device: string): Promise<{ timeout: number | null; override: number | null }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "probe"), task: "probe", lease: false });
  try {
    const out = await session.device.hdc.shell("hidumper -s PowerManagerService -a -a");
    const line = out.split(/\r?\n/).find((l) => l.includes("ScreenOffTime:")) ?? "";
    const num = (re: RegExp): number | null => {
      const m = re.exec(line);
      return m ? Number(m[1]) : null;
    };
    return {
      timeout: num(/Timeout=(\d+)ms/),
      override: num(/OverrideTimeout=(\d+)ms/),
    };
  } finally {
    await session.close();
  }
}

/**
 * Where a keypad button sits, as a fraction of the display.
 *
 * The page's pointer handler converts browser coordinates against the display,
 * so a fraction of the display is the one form that survives a different
 * resolution. Read from the device rather than hard-coded: the keypad is laid
 * out differently on each phone, and a fixed ratio silently misses.
 */
async function keyFraction(device: string, id: string): Promise<{ fx: number; fy: number }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "read"), task: "read", lease: false });
  try {
    const screen = await session.observe.layout();
    const key = screen.elements.find((e) => e.node.attributes.id === id);
    if (!key) throw new Error(`the calculator has no ${id} button on this screen`);
    return {
      fx: Math.round((key.center.x / screen.display.width) * 1000) / 1000,
      fy: Math.round((key.center.y / screen.display.height) * 1000) / 1000,
    };
  } finally {
    await session.close();
  }
}

/**
 * Keeps the phone's screen on for the length of one device's cases.
 *
 * The mirror has `--stay-awake` for the same reason, but the runner needs it
 * too: its own layout reads and browser captures take minutes, and a phone
 * that dims half way through reports every later case as a mirror defect. The
 * restore is guarded because the run's `finally` and an early failure can both
 * reach it.
 */
async function holdScreenAwake(device: string): Promise<{ restore(): Promise<void> }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "probe"), task: "probe", lease: false });
  try {
    await session.device.hypium.setSleepTime(3600);
  } finally {
    await session.close();
  }
  let restored = false;
  return {
    async restore() {
      if (restored) return;
      restored = true;
      const s = await connect({ deviceId: device, stateDir: join(WORK, "probe"), task: "probe", lease: false });
      try {
        await s.device.hypium.restoreSleepTime();
      } catch {
        // A phone that went away mid-run keeps the override; the README names
        // `hdc shell power-shell timeout -r` for that case.
      } finally {
        await s.close();
      }
    },
  };
}

/** Puts one of the two apps this run stages in front, and waits for it. */
async function launchApp(device: string, app: "calculator" | "settings"): Promise<void> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "launch"), task: "launch", lease: false });
  try {
    await assertCapturable(session.device.hypium);
    const { AppManager } = await import("uitest-sdk/drivers");
    await new AppManager(session.device.hdc).launch(app).catch(() => undefined);
    await sleep(2200);
    // A system sheet over the app swallows the key this case is about.
    for (let i = 0; i < 3; i++) {
      const screen = await session.observe.layout();
      const dismiss = screen.elements.find((e) => e.label === "知道了");
      if (!dismiss) break;
      await session.core.tap({ ref: dismiss.ref });
      await sleep(1200);
    }
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
    await stage(device);
    await clearCalculator(device);
    const before = await calculatorState(device);
    // The "7" key's position, read from the device instead of hard-coded: the
    // keypad's fractions differ between phones, and a fixed 15%,56.7% was
    // measured on one device and would silently miss on another.
    const sevenAt = await keyFraction(device, "keyCode_7");
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `click-${tag}.log`));
    try {
      const file = `click-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The listeners are on the canvas (`#screen`); `#frame` is only
            // the box around it, so a pointer event sent there never reached
            // the page's handler.
            const clicked = await evaluate(`(() => {
              const c = document.querySelector('#screen');
              const r = c.getBoundingClientRect();
              const x = r.left + r.width * ${sevenAt.fx};
              const y = r.top + r.height * ${sevenAt.fy};
              for (const type of ['pointerdown', 'pointerup']) {
                c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0, isPrimary: true }));
              }
              return { w: Math.round(r.width), h: Math.round(r.height) };
            })()`);
            await new Promise((r) => setTimeout(r, 1500));
            return [`canvas ${JSON.stringify(clicked)}`, `clicked ${sevenAt.fx},${sevenAt.fy}`];
          },
        }),
      );
      const after = await calculatorState(device).catch(() => null);
      // The keypad's own "7" button is a label on the screen, so a check for
      // "7" anywhere in the layout passed before any click landed. The
      // expression is the only place a click can show up.
      const landed = after !== null && after.expression !== before.expression && after.expression.includes("7");
      if (!shot.ok) add("click", "鼠标点击落到设备", "fail", `screenshot failed: ${shot.reason}`, [], "log");
      else if (landed) add("click", "鼠标点击落到设备", "pass", `display "${before.expression}" → "${after!.expression}"`, [file]);
      else
        add(
          "click",
          "鼠标点击落到设备",
          "fail",
          `the display did not change to 7 · "${before.expression}" → "${after?.expression ?? "(no read)"}"`,
          [file],
        );
    } finally {
      await stopMirror(p);
    }
  }

  // ---- keyboard: typed text reaches the phone ----------------------------
  {
    await stage(device);
    await clearCalculator(device);
    const before = await calculatorState(device);
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `keyboard-${tag}.log`));
    try {
      const file = `keyboard-${tag}.jpg`;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The page's text field is `#text-input`; `#text` does not exist,
            // and the earlier run failed here with a null `.focus()`.
            const ok = await evaluate(`(() => {
              const el = document.getElementById('text-input');
              if (!el) return 'no #text-input';
              el.focus();
              el.value = '123';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return 'typed';
            })()`);
            // The page flushes text 300 ms after the last keystroke, and the
            // device then types character by character (~179 ms each).
            await new Promise((r) => setTimeout(r, 2500));
            return [String(ok), "typed 123"];
          },
        }),
      );
      const after = await calculatorState(device).catch(() => null);
      const shown = `${after?.expression ?? ""} ${after?.value ?? ""}`;
      const landed = after !== null && shown !== `${before.expression} ${before.value}` && shown.includes("123");
      if (!shot.ok) add("keyboard", "键盘输入落到设备", "fail", `screenshot failed: ${shot.reason}`, [], "log");
      else if (landed) add("keyboard", "键盘输入落到设备", "pass", `display now "${after!.expression || after!.value}"`, [file]);
      else if (after !== null && !after.field) {
        // No text field means the keypad was not on screen at all — the phone
        // drifted during the capture. That is a fact about the run, not about
        // the mirror, and it must not be reported as "text did not arrive".
        add("keyboard", "键盘输入落到设备", "fail", `the phone left the calculator (${after.bundle}) during the capture`, [file]);
      } else add("keyboard", "键盘输入落到设备", "fail", `the device did not receive the text · "${shown.trim().slice(0, 60)}"`, [file]);
    } finally {
      await stopMirror(p);
    }
  }

  // ---- scroll: the wheel moves the history list --------------------------
  {
    await stage(device);
    // A list that fits on the screen does not scroll, so this case needs one
    // that overflows. Four finished sums are enough rows for the list to move.
    await seedHistory(device);
    const before = await calculatorState(device);
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `scroll-${tag}.log`));
    try {
      // The history list holds the person's own past sums, and this repository
      // is public, so the case is proven by the layout and no picture of their
      // arithmetic is kept. A page screenshot of the mirror's own chrome would
      // prove nothing about the wheel.
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(WORK, `scroll-${tag}.jpg`),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The wheel listener is on the canvas, and a page that is not the
            // controller ignores it, so this also proves input is on.
            await evaluate(`(() => {
              const c = document.querySelector('#screen');
              const r = c.getBoundingClientRect();
              c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: 300, bubbles: true, cancelable: true }));
            })()`);
            await new Promise((r) => setTimeout(r, 2000));
            return ["wheel 300"];
          },
        }),
      );
      await rm(join(WORK, `scroll-${tag}.jpg`), { force: true });
      // A scroll is a claim about the device, not about the page: the history
      // list must have moved. Comparing the layout is what makes that a real
      // assertion — the earlier version took a screenshot and passed.
      const after = await calculatorState(device).catch(() => null);
      const moved = after !== null && after.labels.join("|") !== before.labels.join("|");
      if (!shot.ok) add("scroll", "滚轮驱动设备滚动", "fail", `screenshot failed: ${shot.reason}`, [], "log");
      else if (moved) add("scroll", "滚轮驱动设备滚动", "pass", "the history list moved (layout comparison; the list holds the person's own sums, so no picture is kept)", [], "log");
      else add("scroll", "滚轮驱动设备滚动", "fail", "the wheel did not move the device's list", [], "log");
    } finally {
      await stopMirror(p);
    }
  }

  // ---- keys: Back, Home and Recents --------------------------------------
  {
    await stage(device);
    const p = await startMirror(["--serial", device, "--state-dir", stateDir], join(LOGS, `keys-${tag}.log`));
    const shots: string[] = [];
    const missed: string[] = [];
    try {
      // Each key gets a screen where it has a visible effect, and the case
      // asserts the device moved rather than that a screenshot was taken. The
      // earlier version passed on three files and never looked at the phone.
      //
      // The recents view is a gallery of whatever the person had open — a
      // feed, a chat, their settings — and this repository is public. Its
      // proof is the layout, and its picture is written to scratch space and
      // deleted: a `kind: "screen"` case with no file is better than a
      // published picture of somebody's afternoon.
      for (const [name, keepShot, prep] of [
        ["home", true, "calculator"],
        ["back", true, "settings"],
        ["recents", false, "calculator"],
      ] as const) {
        const file = `key-${name}-${tag}.jpg`;
        // The recents picture must exist for `prepare` to run at all, so it is
        // captured into the scratch directory and never enters the report.
        const out = keepShot ? join(SHOTS, file) : join(WORK, `recents-${tag}.jpg`);
        await launchApp(device, prep);
        const before = await calculatorState(device);
        const shot = await captureOrFail(() =>
          capturePage({
            url: p.url,
            out,
            waitFor: WAIT_LIVE,
            prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
              // The button is the page's own path to the key, so this also
              // proves the control exists and is wired.
              const found = await evaluate(`(() => {
                const el = document.getElementById('key-${name}');
                if (!el) return false;
                el.click();
                return true;
              })()`);
              if (found !== true) throw new Error(`the page has no #key-${name} button`);
              // Recents is a 3.5 s bottom-edge hold; the others are one key.
              await new Promise((r) => setTimeout(r, name === "recents" ? 5000 : 2000));
              return [name];
            },
          }),
        );
        if (!keepShot) await rm(out, { force: true });
        const after = await calculatorState(device).catch(() => null);
        const changed = after !== null && (after.bundle !== before.bundle || after.labels.join("|") !== before.labels.join("|"));
        if (!shot.ok) missed.push(`${name}: screenshot failed (${shot.reason})`);
        else if (!changed) missed.push(`${name}: the device did not change (${before.bundle})`);
        else if (keepShot) shots.push(file);
      }
      if (missed.length > 0) {
        add("keys", "Back / Home / Recents 三个键", "fail", missed.join(" · "), shots);
      } else {
        add(
          "keys",
          "Back / Home / Recents 三个键",
          "pass",
          "three keys changed the device · recents proven by layout only (its screen shows other apps, so no picture is kept)",
          shots,
        );
      }
    } finally {
      await stopMirror(p);
    }
  }

  // ---- record: --record writes an MP4, and --stay-awake holds the screen --
  {
    // The keys case leaves the phone on the launcher; a picture of the
    // person's home screen is not evidence about the mirror.
    await stage(device);
    const file = join(WORK, `rec-${tag}.mp4`);
    await rm(file, { force: true });
    const p = await startMirror(
      ["--serial", device, "--state-dir", stateDir, "--record", file, "--stay-awake"],
      join(LOGS, `record-${tag}.log`),
    );
    let live = false;
    let awake: { timeout: number | null; override: number | null } | null = null;
    try {
      // record mode is a second device-side daemon, and a run that only
      // records would not show the picture survives.
      const shot = await captureOrFail(() =>
        capturePage({ url: p.url, out: join(SHOTS, `record-live-${tag}.jpg`), waitFor: WAIT_LIVE }),
      );
      live = shot.ok;
      // `--stay-awake` installs an override for the length of the run; the
      // person's own timeout is deliberately left alone.
      awake = await screenTimeout(device).catch(() => null);
      await sleep(6000);
    } finally {
      await stopMirror(p);
    }
    const timeoutAfter = await screenTimeout(device).catch(() => null);
    const size = existsSync(file) ? statSync(file).size : 0;
    // An MP4 starts with an ftyp box at offset 4; a file that does not is a
    // container the extension failed to close, not a recording.
    const head = existsSync(file) ? readFileSync(file).subarray(4, 8).toString("latin1") : "";
    const recorded = size > 10_000 && head === "ftyp";
    const stayedAwake = awake?.override !== null && awake?.override !== undefined && awake.override >= 3_600_000;
    // The override must be undone: a mirror that leaves a person's phone awake
    // for an hour has changed something they never asked about.
    const restored = timeoutAfter?.override === null || timeoutAfter?.override === undefined;
    const detail = [
      recorded ? `${size} B · ftyp ok` : `${size} B · head ${JSON.stringify(head)}`,
      live ? "picture live" : "no live picture",
      stayedAwake ? `stay-awake override ${awake!.override} ms` : `stay-awake NOT set (override ${awake?.override ?? "unreadable"})`,
      restored ? "override removed" : `override left at ${timeoutAfter?.override} ms`,
    ].join(" · ");
    add(
      "record",
      "录制产出 MP4，--stay-awake 生效并复原",
      recorded && stayedAwake && restored ? "pass" : "fail",
      detail,
      live ? [`record-live-${tag}.jpg`] : [],
    );
  }

  // ---- max-size: the divisor reaches the device's daemon -----------------
  {
    await stage(device);
    const { width, height } = await displayOf(device);
    const longest = Math.max(width, height);
    const maxSize = 1024;
    const expected = resolveCastScale("grpc", longest, { maxSize });
    const p = await startMirror(
      ["--serial", device, "--state-dir", stateDir, "--max-size", String(maxSize)],
      join(LOGS, `max-size-${tag}.log`),
    );
    try {
      // The daemon only starts when a tab asks for the stream, and its argv is
      // on the device — not in the product's stdout, where the earlier version
      // looked. Reading `ps` is the only place `-scale` really appears.
      let frameWidth: number | null = null;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, `max-size-${tag}.jpg`),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The spec's case is about the picture, not the argument: a
            // correct `-scale` that produced a full-size frame would pass the
            // old check. The canvas is sized to the decoded frame.
            const width = await evaluate(`(() => {
              const c = document.querySelector('canvas');
              return c && c.width ? c.width : 0;
            })()`);
            frameWidth = typeof width === "number" ? width : null;
            return [`frame ${String(width)} px wide`];
          },
        }),
      );
      const scale = await daemonScale(device, p.pid).catch(() => null);
      const withinBound = frameWidth !== null && frameWidth > 0 && frameWidth <= maxSize;
      const ok = shot.ok && scale === expected && withinBound;
      add(
        "max-size",
        "--max-size 按最长边换算",
        ok ? "pass" : "fail",
        `longest ${longest} → expected -scale ${expected}, daemon got ${scale ?? "none"} · ` +
          `frame ${frameWidth ?? "none"} px (bound ${maxSize})${shot.ok ? "" : " · no frame"}`,
        shot.ok ? [`max-size-${tag}.jpg`] : [],
      );
    } finally {
      await stopMirror(p);
    }
  }

  // ---- no-control: the page is read-only ---------------------------------
  {
    await stage(device);
    const p = await startMirror(
      ["--serial", device, "--state-dir", stateDir, "--no-control"],
      join(LOGS, `no-control-${tag}.log`),
    );
    try {
      const file = `no-control-${tag}.jpg`;
      const before = await calculatorState(device);
      let injected: string | null = null;
      const shot = await captureOrFail(() =>
        capturePage({
          url: p.url,
          out: join(SHOTS, file),
          waitFor: WAIT_LIVE,
          prepare: async (evaluate: (expr: string) => Promise<unknown>) => {
            // The key row is only rendered when the server said input is on.
            const hidden = await evaluate(`document.getElementById('keys').offsetParent === null`);
            if (hidden !== true) throw new Error("the key row is visible with --no-control");
            // The spec's case says "injection is refused", not "the buttons
            // are hidden": hiding is presentation, and a page could still be
            // scripted. Dispatch a full tap and a key on the canvas and let
            // the device say whether anything landed.
            injected = String(
              await evaluate(`(() => {
                const c = document.querySelector('#screen');
                const r = c.getBoundingClientRect();
                for (const type of ['pointerdown', 'pointerup']) {
                  c.dispatchEvent(new PointerEvent(type, { clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0, isPrimary: true }));
                }
                window.uitestViewer && window.uitestViewer.send && window.uitestViewer.send({ type: 'input', action: 'key', key: 'enter' });
                return 'tap+enter dispatched';
              })()`),
            );
            // The device needs the round trip to show it, if it was going to.
            await new Promise((r) => setTimeout(r, 1200));
            return [`key row hidden`, injected ?? ""];
          },
        }),
      );
      const after = await calculatorState(device).catch(() => null);
      const unchanged =
        after !== null && after.expression === before.expression && after.value === before.value;
      if (!shot.ok) add("no-control", "--no-control 只读", "fail", shot.reason, [], "log");
      else if (!unchanged) {
        add(
          "no-control",
          "--no-control 只读",
          "fail",
          `the device changed despite --no-control · "${after?.expression ?? ""} ${after?.value ?? ""}"`,
          [file],
        );
      } else add("no-control", "--no-control 只读", "pass", `no key row; ${injected} left the display unchanged`, [file]);
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
    // A run spends minutes driving a browser, and a phone that sleeps in the
    // middle of it lands on the lock screen or the launcher — every later
    // case then fails for a reason that is not about the mirror. The runner
    // holds the screen itself, and puts the person's timeout back afterwards;
    // `--stay-awake` is proven separately by the record case.
    const awake = await holdScreenAwake(device);
    let r: { cases: Case[]; tag: string };
    try {
      r = await mirrorCases(device, stateDir);
    } finally {
      await awake.restore();
    }
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
