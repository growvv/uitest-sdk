/**
 * uitest-console 0.1.0 acceptance.
 *
 * The console is a person's page, so its evidence has to be the page itself:
 * every case drives the real console server from the packed tarball and takes a
 * screenshot of it in a real browser, plus a device screenshot where the action
 * changed the phone.
 *
 * Usage:
 *   unset HDC_SERVER_PORT
 *   npx tsx scripts/acceptance-console.ts --targets <id>[,<id>...]
 *
 * Writes `docs/acceptance/console-0.1.0/`. Devices appear only as 8-character
 * tags.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, tagOf } from "uitest-sdk";
import { AppManager } from "uitest-sdk/drivers";
import { capturePage } from "./screenshot.mjs";
import {
  assertCapturable,
  assertShadeClosed,
  captureOrFail,
  gitHead,
  isHistoryListInFront,
} from "./acceptance.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRODUCT = "console";
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "packages", "console", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const OUT = process.env.UITEST_ACCEPTANCE_DIR ?? join(ROOT, "docs", "acceptance", `${PRODUCT}-${VERSION}`);
const SHOTS = join(OUT, "screenshots");
const LOGS = join(OUT, "logs");
const WORK = join(ROOT, ".work-bench", "accept-console");

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

/** The phone CLI, installed from its own tarball: the agent half of the loop. */
let phoneBin = "";

/** Runs the phone CLI. The console's inbox is answered by a real agent asking. */
function phone(args: string[], stateDir: string, device: string) {
  const r = spawnSync(process.execPath, [phoneBin, ...args, "--device", device, "--state-dir", stateDir], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  let data: Record<string, unknown> | undefined;
  const last = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (last?.startsWith("{")) {
    try {
      data = (JSON.parse(last) as { data?: Record<string, unknown> }).data;
    } catch {
      data = undefined;
    }
  }
  return { code: r.status ?? -1, out, data };
}

interface Ctx {
  url: string;
  port: number;
  tag: string;
  device: string;
  stateDir: string;
  log(line: string): Promise<void>;
}

async function makeCtx(url: string, port: number, tag: string, device: string, stateDir: string): Promise<Ctx> {
  const logPath = join(LOGS, `console-${tag}.log`);
  return {
    url,
    port,
    tag,
    device,
    stateDir,
    async log(line) {
      await writeFile(logPath, `${line}\n`, { flag: "a" });
    },
  };
}

/**
 * Puts the calculator's history list in front, with a row on it.
 *
 * The console's inbox needs a step the policy actually flags, and on a
 * calculator the only one is the history's delete key ("delete" matches the
 * deletes rule). A freshly installed calculator has no history, so the run
 * makes one: 7, 8, equals, then the history button.
 *
 * The calculator reopens wherever it was left, so the list may already be in
 * front — from the person using the phone, or from an earlier acceptance run
 * that ended on it. Both states are handled: a non-empty list is the goal, and
 * an empty one goes back to the keypad to be seeded.
 */
async function stage(device: string): Promise<void> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "stage"), task: "stage", lease: false });
  try {
    // The console photographs the browser page, and the page contains the raw
    // mirror frame. A locked phone or an open shade would be published as a
    // "mirror" screenshot, so the same guards the core acceptance uses run
    // before anything is staged or captured.
    await assertCapturable(session.device.hypium);
    await assertShadeClosed(session.device.hypium);
    const apps = new AppManager(session.device.hdc);
    const onListWithRows = isHistoryListInFront;

    for (let i = 0; i < 5; i++) {
      await apps.launch("calculator").catch(() => undefined);
      await sleep(1200);
      let screen = await session.observe.layout();
      if (onListWithRows(screen.elements)) return;

      // An empty list is still the list: go back to the keypad to seed it.
      if (screen.elements.some((e) => e.label === "history record delete")) {
        await session.act.key("back").catch(() => undefined);
        await sleep(600);
        screen = await session.observe.layout();
      }

      const go = screen.elements.find((e) => e.label === "history record go");
      if (go) {
        await session.act.tap({ ref: go.ref }).catch(() => undefined);
        await sleep(800);
        if (onListWithRows((await session.observe.layout()).elements)) return;
        await session.act.key("back").catch(() => undefined);
        await sleep(600);
        screen = await session.observe.layout();
      }

      // Seed a calculation so the list has a row to show and to delete.
      for (const label of ["7", "8", "keyCode 18"]) {
        const key = screen.elements.find((e) => e.clickable && e.label === label);
        if (key) await session.act.tap({ ref: key.ref }).catch(() => undefined);
      }
      await sleep(600);
    }
    throw new Error("could not stage a calculator history row");
  } finally {
    await session.close();
  }
}

/**
 * Re-runs the guards and puts the staged surface back in front.
 *
 * Called before every capture, not once at the start. A console run spends
 * minutes in a browser while the phone is a real phone: it sleeps, and waking
 * it shows the lock screen or the launcher. The 0.1.1 run checked at staging
 * and then spent its last four cases on a locked phone — the mirror went black
 * and the replay found nothing to tap, both reported as console defects.
 *
 * `stage` already does exactly this work and is idempotent (a non-empty list in
 * front is its success condition), so this is the same function under a name
 * that says why it is being called again.
 */
async function recheckSurface(device: string): Promise<void> {
  await stage(device);
}

/** Polls a page expression until it is true; throws when it never becomes so. */
async function waitUntil(
  evaluate: (expression: string) => Promise<unknown>,
  expression: string,
  what: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The page's own control for the console panel, driven through the DOM. */
const CLICK_HOLD = `(function(){ var b=document.getElementById("hold"); b.click(); return b.textContent; })()`;
/** What the button reads: the label is the page's only statement of lease state. */
const HOLD_LABEL = `document.getElementById("hold").textContent`;
/**
 * A decoded frame, not merely a canvas.
 *
 * The page creates the canvas and `window.uitestViewer` before the first frame
 * arrives; a shot taken then is a black rectangle under a case named "mirror".
 * The fps counter is no use here — the device's encoder only sends frames when
 * the screen changes, so a static phone reads 0 fps while showing a live
 * picture. The canvas's own pixels are the honest signal.
 */
const FRAME_READY = `(function () {
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
/** A decoded frame plus the node table: the page every later case assumes. */
const PAGE_READY = `${FRAME_READY} && document.querySelectorAll("#list .row").length > 0`;

/** Starts the console from the installed tarball, as a separate process. */
async function startConsoleProcess(
  device: string,
  stateDir: string,
  extra: string[] = [],
): Promise<{ child: import("node:child_process").ChildProcess; url: string; port: number }> {
  const bin = join(WORK, "pkg", "node_modules", "uitest-console", "dist", "bin.js");
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [bin, "--device", device, "--state-dir", stateDir, "--port", "0", "--no-open", ...extra],
    // stdin stays open so stopping is a graceful close, not a kill: on Windows
    // `kill()` terminates without running the console's cleanup, leaving the
    // device lease and the hdc port forward behind.
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let out = "";
  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`console never printed its URL: ${out}`)), 60_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearTimeout(timer);
        res(m[1]!);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => rej(new Error(`console exited ${code}: ${out}`)));
  });
  const port = Number(new URL(url).port);
  return { child, url, port };
}

/**
 * Stops a console process the run started, and only that one.
 *
 * Closing stdin is the graceful path: the console then closes the page and
 * lets the device go, which removes its port forward. On Windows `kill()`
 * skips all of that, and each skipped cleanup left an `fport` entry behind —
 * twenty of them filled 8012..8031 and the next run could not open a tunnel.
 * A kill is the fallback for a console that ignores the close.
 */
async function stopConsole(child: import("node:child_process").ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.stdin?.end();
  const exited = await new Promise<boolean>((res) => {
    const timer = setTimeout(() => res(false), 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      res(true);
    });
  });
  if (!exited) child.kill();
}

/**
 * One device's console cases.
 *
 * Order matters: the mirror and the node table first (a page that never decoded
 * a frame would make every later case a lie), then the inbox loop against a real
 * agent request, then Hold/Resume, then the page's own hygiene.
 */
async function consoleCases(device: string): Promise<{ cases: Case[]; tag: string }> {
  const tag = tagOf(device);
  const stateDir = join(WORK, "state", tag);
  await mkdir(stateDir, { recursive: true });
  await stage(device);
  const { child, url, port } = await startConsoleProcess(device, stateDir);
  const ctx = await makeCtx(url, port, tag, device, stateDir);
  const cases: Case[] = [];
  const add = (
    id: string,
    title: string,
    status: Status,
    detail: string,
    shots: string[],
    kind: "screen" | "log" = shots.length ? "screen" : "log",
  ): void => {
    cases.push({ id, title, device: tag, status, detail, screenshots: shots, kind });
  };

  try {
    await ctx.log(`console ${url}`);

    /**
     * One case, one picture, and a capture that failed is this case's failure.
     *
     * The report is worth more with the failure written down than with a stack
     * trace replacing every case after it: a single flaky frame used to end the
     * whole run before any report existed.
     */
    const shot = async (
      id: string,
      title: string,
      file: string,
      opts: { waitFor: string; prepare?: (evaluate: (e: string) => Promise<unknown>) => Promise<string[]> },
      detail: (notes: string[]) => string,
    ): Promise<string[] | null> => {
      // The phone is a real phone: it sleeps during a run that spends minutes
      // in a browser, and it was left on its lock screen for the last four
      // cases of the 0.1.1 run. Every picture here is published, so the lock
      // and shade guards run before each one — and the surface the cases are
      // about is put back in front, because a woken phone shows the launcher.
      const r = await captureOrFail(async () => {
        await recheckSurface(device);
        return capturePage({ url, out: join(SHOTS, file), waitFor: opts.waitFor, ...(opts.prepare ? { prepare: opts.prepare } : {}) });
      });
      if (!r.ok) {
        add(id, title, "fail", `screenshot failed: ${r.reason}`, []);
        return null;
      }
      add(id, title, "pass", detail(r.notes), [file]);
      return r.notes;
    };

    // --- mirror ------------------------------------------------------------
    const mirrorShot = `console-mirror-${tag}.jpg`;
    await shot(
      "console-mirror",
      "镜像：真实浏览器里的一帧",
      mirrorShot,
      { waitFor: FRAME_READY },
      (notes) => `${new URL(url).port} · ${notes.length} notes`,
    );

    // --- node table --------------------------------------------------------
    const inspectShot = `console-inspect-${tag}.jpg`;
    await shot(
      "console-inspect",
      "节点表：元素行",
      inspectShot,
      {
        waitFor: PAGE_READY,
        prepare: async (evaluate) => [`${String(await evaluate('document.querySelectorAll("#list .row").length'))} node rows`],
      },
      (notes) => notes.join(", "),
    );

    // --- the inbox, against a real agent request ---------------------------
    // The calculator history's delete key is what the policy flags, so the
    // request is a real one: an agent tries to delete and is stopped.
    const ask = phone(["tap", "--text", "history record delete", "--json"], stateDir, device);
    await ctx.log(`agent ask → exit ${ask.code}, id ${String(ask.data?.["approvalId"] ?? "none")}`);
    const approvalId = typeof ask.data?.["approvalId"] === "string" ? ask.data["approvalId"] : null;
    const pendingShot = `console-inbox-pending-${tag}.jpg`;
    if (!approvalId) {
      add(
        "console-inbox-pending",
        "收件箱：Agent 的请求出现在页面上",
        "fail",
        `agent ask exit ${ask.code}: ${ask.out.trim().split("\n")[0]}`,
        [],
      );
    } else {
      // The row is what this case is about, so the row is what it waits for.
      // Requiring a decoded video frame as well made the case fail whenever the
      // cast happened to be reconnecting — a fact about the stream, reported as
      // a fact about the inbox.
      let rows = "0";
      const notes = await shot(
        "console-inbox-pending",
        "收件箱：Agent 的请求出现在页面上",
        pendingShot,
        {
          waitFor: `document.querySelectorAll("#approvals-list [data-id]").length > 0`,
          prepare: async (evaluate) => {
            rows = String(await evaluate('document.querySelectorAll("#approvals-list [data-id]").length'));
            return [`${rows} pending`];
          },
        },
        () => `${rows} 行 · id ${approvalId}`,
      );
      if (notes && Number(rows) === 0) {
        // A picture was taken but it shows no row: the case did not hold.
        cases[cases.length - 1]!.status = "fail";
        cases[cases.length - 1]!.detail = `0 rows · id ${approvalId}`;
      }
    }

    // Allow it from the page, then let the agent replay: settled means the
    // decision the person made in the browser is the one the gate honoured.
    if (!approvalId) {
      add("console-inbox-allow", "收件箱：在页面上点允许后 Agent 放行", "fail", "no approval id to answer", []);
    } else {
      const allowedShot = `console-inbox-allowed-${tag}.jpg`;
      let answeredRow = "";
      const captured = await captureOrFail(() =>
        capturePage({
          url,
          out: join(SHOTS, allowedShot),
          waitFor: `document.querySelector('#approvals-list [data-id="${approvalId}"] [data-allow]')`,
          prepare: async (evaluate) => {
            await evaluate(`document.querySelector('#approvals-list [data-id="${approvalId}"] [data-allow]').click()`);
            // The row has to show the answer, or the page is claiming nothing:
            // an inbox that looks identical after Allow is an inbox a person
            // cannot read. The buttons go and the status becomes "allowed".
            await waitUntil(
              evaluate,
              `(function () {
                var row = document.querySelector('#approvals-list [data-id="${approvalId}"]');
                return !!row && !row.querySelector("[data-allow]") && /allowed/.test(row.textContent);
              })()`,
              "the row to show its answer",
            );
            answeredRow = String(
              await evaluate(`document.querySelector('#approvals-list [data-id="${approvalId}"]').textContent`),
            ).trim();
            return [`allow clicked · row → ${answeredRow}`];
          },
        }),
      );
      if (!captured.ok) {
        add(
          "console-inbox-allow",
          "收件箱：在页面上点允许后 Agent 放行",
          "fail",
          `screenshot failed: ${captured.reason}`,
          [],
        );
      } else {
        const replay = phone(
          ["tap", "--text", "history record delete", "--approval-id", approvalId, "--json"],
          stateDir,
          device,
        );
        await ctx.log(`replay after the page's allow → exit ${replay.code}`);
        add(
          "console-inbox-allow",
          "收件箱：在页面上点允许后 Agent 放行",
          replay.code === 0 ? "pass" : "fail",
          `replay exit ${replay.code} (expect 0) · page row: ${answeredRow.slice(0, 80)}`,
          [allowedShot],
        );
      }
    }

    // --- Hold / Resume -----------------------------------------------------
    // The device must be free before this case means anything: waiting for the
    // button to read "Hold" is the check that no hold survived from earlier.
    const heldShot = `console-held-${tag}.jpg`;
    const heldNotes = await shot(
      "console-hold",
      "Hold：页面拿到设备，Agent 停在 lease_held",
      heldShot,
      {
        waitFor: `${FRAME_READY} && document.getElementById("hold").textContent === "Hold"`,
        prepare: async (evaluate) => {
          await evaluate(CLICK_HOLD);
          // The label changes only when the server's acknowledgement comes
          // back. A shot taken before it would show "Hold" under a case named
          // "held".
          await waitUntil(evaluate, `document.getElementById("hold").textContent === "Resume"`, "the held banner");
          return [`hold button → ${String(await evaluate(HOLD_LABEL))}`];
        },
      },
      (notes) => notes.join(", "),
    );
    if (heldNotes) {
      const blocked = phone(["observe", "--json"], stateDir, device);
      const last = cases[cases.length - 1]!;
      last.status = blocked.code === 2 ? "pass" : "fail";
      last.detail = `${heldNotes.join(", ")} · agent observe exit ${blocked.code} (expect 2)`;
    }

    // A fresh tab on a held device must already read "Resume": the button is a
    // toggle, and a tab that opens at "Hold" would take the phone again instead
    // of handing it back. Waiting for the label is the case's real assertion —
    // clicking whatever the button says is how the earlier run missed this.
    const resumedShot = `console-resumed-${tag}.jpg`;
    const resumedNotes = await shot(
      "console-resume",
      "Resume：交回后 Agent 继续",
      resumedShot,
      {
        waitFor: `${FRAME_READY} && document.getElementById("hold").textContent === "Resume"`,
        prepare: async (evaluate) => {
          const before = String(await evaluate(`document.getElementById("hold").textContent`));
          const text = String(await evaluate(CLICK_HOLD));
          await sleep(800);
          return [`button on join → ${before}`, `after click → ${text}`];
        },
      },
      (notes) => notes.join(", "),
    );
    if (resumedNotes) {
      const after = phone(["observe", "--json"], stateDir, device);
      const last = cases[cases.length - 1]!;
      last.status = after.code === 0 ? "pass" : "fail";
      last.detail = `${resumedNotes.join(", ")} · agent observe exit ${after.code} (expect 0)`;
    }

    // --- privacy switch ----------------------------------------------------
    await shot(
      "console-privacy",
      "隐私开关：页面自己的开关",
      `console-privacy-${tag}.jpg`,
      {
        waitFor: PAGE_READY,
        prepare: async (evaluate) => {
          await evaluate(`(function(){
            var el = document.getElementById("privacy");
            el.checked = false; el.dispatchEvent(new Event("change"));
            if (el.checked) throw new Error("the privacy switch did not turn off");
            el.checked = true; el.dispatchEvent(new Event("change"));
            return el.checked;
          })()`);
          return ["privacy on->off->on"];
        },
      },
      (notes) => notes.join(", "),
    );

    // --- the page is self-contained ----------------------------------------
    await shot(
      "console-selfcontained",
      "页面不引用外部资源",
      `console-selfcontained-${tag}.jpg`,
      {
        waitFor: PAGE_READY,
        prepare: async (evaluate) => {
          const urls = (await evaluate(
            `Array.from(document.querySelectorAll("script[src],link[href],img[src]")).map(function(e){return e.src||e.href;})`,
          )) as string[];
          const outside = (urls ?? []).filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`) && !u.startsWith("data:"));
          if (outside.length > 0) throw new Error(`page loads from outside: ${outside.join(", ")}`);
          return [`${(urls ?? []).length} local resources`];
        },
      },
      (notes) => notes.join(", "),
    );

    // --- the Origin check is core's, and it still holds --------------------
    const origin = await originCases(port, ctx);
    add("console-origin", "来源校验沿用库的实现", origin.ok ? "pass" : "fail", origin.detail, []);
  } finally {
    await stopConsole(child);
  }
  return { cases, tag };
}

/** A WebSocket handshake with the headers the caller chooses. */
async function handshake(port: number, opts: { origin?: string; host?: string }): Promise<number | null> {
  const { createConnection } = await import("node:net");
  return new Promise((res) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buf = "";
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      res(status);
    };
    socket.setTimeout(4000, () => finish(null));
    socket.on("error", () => finish(statusOf(buf)));
    socket.on("close", () => finish(statusOf(buf)));
    socket.on("connect", () => {
      const lines = [
        "GET /live HTTP/1.1",
        `Host: ${opts.host ?? `127.0.0.1:${port}`}`,
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
      if (buf.includes("\r\n")) finish(statusOf(buf));
    });
  });
}

function statusOf(buf: string): number | null {
  const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
  return m ? Number(m[1]) : null;
}

async function originCases(port: number, ctx: Ctx): Promise<{ ok: boolean; detail: string }> {
  const checks: Array<{ name: string; expect: number; origin?: string; host?: string }> = [
    { name: "own origin", expect: 101, origin: `http://127.0.0.1:${port}` },
    { name: "another site", expect: 403, origin: "https://evil.example" },
    { name: "null origin", expect: 403, origin: "null" },
    { name: "DNS rebinding", expect: 403, origin: "http://attacker.example:7042", host: "attacker.example:7042" },
  ];
  let ok = true;
  const parts: string[] = [];
  for (const c of checks) {
    const got = await handshake(port, c);
    if (got !== c.expect) ok = false;
    parts.push(`${c.name}=${got ?? "none"}`);
    await ctx.log(`origin ${c.name}: ${got ?? "none"} (expect ${c.expect})`);
  }
  return { ok, detail: parts.join(" · ") };
}

function renderMarkdown(report: Report): string {
  const rows = report.cases
    .map(
      (c) =>
        `| \`${c.id}\` | ${c.device ?? ""} | ${c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "SKIP"} | ${c.detail} |`,
    )
    .join("\n");
  return `# uitest-console ${report.version} 验收报告

> 本文件由 \`scripts/acceptance-console.ts\` 生成，请勿手改。生成时间：${report.date}，提交 \`${report.commit}\`。

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

async function main(): Promise<number> {
  const targets = parseTargets();
  if (targets.length === 0) {
    process.stderr.write("usage: npx tsx scripts/acceptance-console.ts --targets <id>[,<id>...]\n");
    return 2;
  }
  for (const d of [OUT, WORK]) await mkdir(d, { recursive: true });
  // One run at a time: the scratch install is shared, and a second run's
  // cleanup deletes the first one's `node_modules` out from under it.
  const lock = join(WORK, "run.lock");
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 3 * 60 * 60 * 1000) {
    process.stderr.write(`another console acceptance run is using ${WORK}; wait for it or delete ${lock}\n`);
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
  // The scratch state carries leases, approvals and traces. A hold left by an
  // earlier run makes the next run start with the device already taken, which
  // is how a Hold case passed while proving nothing.
  await rm(join(WORK, "state"), { recursive: true, force: true });
  for (const d of [OUT, SHOTS, LOGS, WORK]) await mkdir(d, { recursive: true });
  // Both products come from their tarballs: the console drives the phone CLI,
  // and a run against the working tree would not prove what a person installs.
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
  const phoneFile = packOne("uitest-phone");
  const consoleFile = packOne("uitest-console");
  const prefix = join(WORK, "pkg");
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "package.json"), '{"name":"accept-console","private":true,"type":"module"}\n');
  execSync(
    `npm install --no-audit --no-fund --prefix "${prefix}" "${join(packDir, coreFile)}" "${join(packDir, phoneFile)}" "${join(packDir, consoleFile)}"`,
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
  );
  phoneBin = join(prefix, "node_modules", "uitest-phone", "dist", "bin.js");
  const consoleBin = join(prefix, "node_modules", "uitest-console", "dist", "bin.js");
  if (!existsSync(phoneBin) || !existsSync(consoleBin)) throw new Error("the installed packages are missing their bins");

  const version = spawnSync(process.execPath, [consoleBin, "--version"], { encoding: "utf8" });
  const devices: Report["devices"] = [];
  const cases: Case[] = [];
  cases.push({
    id: "package",
    title: "npm 包安装与版本",
    device: "host",
    status: (version.stdout ?? "").includes(`uitest-console ${VERSION}`) ? "pass" : "fail",
    detail: `${consoleFile} · ${(version.stdout ?? "").trim() || `exit ${version.status}`}`,
    screenshots: [],
    kind: "log",
  });

  for (const device of targets) {
    const info = await probeDevice(device);
    devices.push(info);
    process.stdout.write(`=== ${info.tag} ===\n`);
    const r = await consoleCases(device);
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
    // The run's own evidence is not a modification to the code: a first
    // run at a new version would otherwise stamp itself `+dirty`.
    commit: gitHead({ exclude: [relative(ROOT, OUT)] }),
    devices,
    cases,
    summary,
    rerun: [
      "unset HDC_SERVER_PORT",
      "npx tsx scripts/acceptance-console.ts --targets <id>[,<id>]",
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
