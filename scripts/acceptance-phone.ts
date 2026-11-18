/**
 * uitest-phone 0.10.0 acceptance.
 *
 * The phone package is what an agent installs, so this runs the *packed*
 * tarball, not the working tree: `npm pack`, install into a scratch prefix, and
 * drive `node_modules/uitest-phone/dist/bin.js` from there. Every case is a
 * real CLI invocation against a real device; the MCP case is a real stdio
 * session.
 *
 * Usage:
 *   unset HDC_SERVER_PORT
 *   npx tsx scripts/acceptance-phone.ts --targets <id>[,<id>...]
 *
 * Writes `docs/acceptance/phone-0.10.0/`. Devices appear only as 8-character
 * tags.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { tagOf } from "uitest-sdk";
import { connect } from "uitest-sdk";
import { AppManager } from "uitest-sdk/drivers";
import { assertCapturable, assertShadeClosed, gitHead } from "./acceptance.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRODUCT = "phone";
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "packages", "phone", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const OUT = process.env.UITEST_ACCEPTANCE_DIR ?? join(ROOT, "docs", "acceptance", `${PRODUCT}-${VERSION}`);
const SHOTS = join(OUT, "screenshots");
const LOGS = join(OUT, "logs");
const WORK = join(ROOT, ".work-bench", "accept-phone");

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


/** One CLI invocation. Never throws on a non-zero exit: the case decides. */
function cli(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    timeout: 120_000,
  });
  return {
    code: r.status ?? -1,
    out: r.stdout ?? "",
    err: r.stderr ?? "",
    text: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

/** The JSON body of a `--json` run, or null when it did not produce one. */
function jsonOf(r: { out: string }): Record<string, unknown> | null {
  const line = r.out.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface Ctx {
  bin: string;
  tag: string;
  device: string;
  stateDir: string;
  /** Runs the CLI with the device and state dir already attached. */
  run(args: string[], extra?: string[]): ReturnType<typeof cli>;
  /** Saves the CLI's own screenshot of the current screen and returns its name. */
  shot(id: string): Promise<string>;
  log(line: string): Promise<void>;
  notes: string[];
}

async function makeCtx(bin: string, device: string, tag: string): Promise<Ctx> {
  const stateDir = join(WORK, "state", tag);
  await mkdir(stateDir, { recursive: true });
  const logPath = join(LOGS, `cli-${tag}.log`);
  const ctx: Ctx = {
    bin,
    tag,
    device,
    stateDir,
    notes: [],
    run(args, extra = []) {
      const r = cli(bin, [...args, "--device", device, "--state-dir", stateDir, ...extra]);
      void ctx.log(`$ ${args.join(" ")} ${extra.join(" ")}\n  exit ${r.code}\n  ${r.text.trim().split("\n").join("\n  ")}`);
      return r;
    },
    async shot(id) {
      const name = `${id}-${tag}.jpg`;
      const r = cli(bin, ["screenshot", "--out", join(SHOTS, name), "--device", device, "--state-dir", stateDir]);
      if (r.code !== 0 || !existsSync(join(SHOTS, name))) {
        throw new Error(`screenshot failed: ${r.text.trim().slice(0, 200)}`);
      }
      return name;
    },
    async log(line) {
      await writeFile(logPath, `${line}\n`, { flag: "a" });
    },
  };
  return ctx;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Puts the calculator in front: a keypad and a result line, nothing personal. */
async function stageCalculator(device: string): Promise<{ restore(): Promise<void> }> {
  const session = await connect({ deviceId: device, stateDir: join(WORK, "stage"), task: "stage", lease: false });
  const apps = new AppManager(session.device.hdc);
  // Every screenshot this run takes is published. The lock screen and an open
  // notification shade carry messages and bank alerts, so the run refuses to
  // photograph either: the guards close the shade and refuse a PIN-locked phone
  // before the first capture rather than after the images are on disk.
  await assertCapturable(session.device.hypium);
  await assertShadeClosed(session.device.hypium);
  const before = await apps.current().catch(() => null);
  await apps.launch("calculator").catch(() => undefined);
  await sleep(1500);
  return {
    async restore() {
      if (before) await apps.launch(before.bundle, before.ability ? { ability: before.ability } : {}).catch(() => undefined);
      await session.close();
    },
  };
}

/** Each of the 21 commands, one real invocation, with the screen it produced. */
/** The expression the run seeds, so both devices have the same history row. */
const SEEDED_EXPRESSION = "78";

const COMMAND_CASES: Array<{
  id: string;
  title: string;
  args: string[] | ((ctx: Ctx) => string[]);
  kind?: "screen" | "log";
  expect?: number[];
  before?: (ctx: Ctx) => void;
  check?: (r: { code: number; text: string }, ctx: Ctx) => string | null;
}> = [
  { id: "cmd-launch", title: "launch 启动应用", args: ["launch", "--app", "calculator"] },
  { id: "cmd-observe", title: "observe 读屏", args: ["observe"] },
  { id: "cmd-tap", title: "tap 点击", args: ["tap", "--text", "7"] },
  {
    id: "cmd-type",
    title: "type 输入",
    // The calculator has no text field until its display is focused: the
    // keypad is buttons, and `type` correctly reports "a focused input" as
    // not_found. Tap the display first, then type into it.
    before: (ctx) => {
      const observe = ctx.run(["observe"]);
      const ref = /\[(\d+)\] input /.exec(observe.out)?.[1];
      if (!ref) throw new Error("the calculator screen has no input element to type into");
      ctx.run(["tap", "--ref", ref]);
    },
    args: ["type", "--text", "123"],
    check: (r) => (r.text.includes("typed") ? null : "type did not report typed characters"),
  },
  { id: "cmd-swipe", title: "swipe 滑动", args: ["swipe", "--direction", "up"] },
  { id: "cmd-double-click", title: "double-click 双击", args: ["double-click", "--text", "8"] },
  { id: "cmd-drag", title: "drag 拖拽", args: ["drag", "--from", "608,1400", "--to", "608,900"] },
  { id: "cmd-fling", title: "fling 快滑", args: ["fling", "--direction", "up"] },
  { id: "cmd-pinch", title: "pinch 双指缩放", args: ["pinch", "--center", "608,1400", "--from", "200", "--to", "400"] },
  // The three list commands stay on the history screen; `key back` is what
  // leaves it, so it runs after them.
  {
    id: "cmd-wait-for",
    title: "wait-for 等 UI",
    args: ["wait-for", "--text", "历史记录", "--timeout-ms", "3000"],
  },
  { id: "cmd-read-list", title: "read-list 读列表", args: ["read-list"] },
  {
    id: "cmd-scroll-until",
    title: "scroll-until 滚到目标",
    // The target is a row the list actually shows: the calculator's history is
    // whatever the person using the phone left there, and a hard-coded string
    // would be a test of the device's past, not of the command.
    args: (ctx) => {
      const list = ctx.run(["read-list"]);
      // read-list prints its status, then `screens: N · complete: ...`, then the
      // rows; the first line that is neither is a row the list actually shows.
      const first = list.out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line !== "settled" && !line.startsWith("screens:"))[0];
      if (!first) throw new Error("read-list returned no rows to scroll to");
      return ["scroll-until", "--text", first];
    },
  },
  { id: "cmd-key", title: "key 系统按键", args: ["key", "--key", "back"] },
  { id: "cmd-apps", title: "apps 应用管理", args: ["apps", "--current"], kind: "log" },
  { id: "cmd-window", title: "window 窗口", args: ["window"], kind: "log" },
  { id: "cmd-doctor", title: "doctor 自检", args: ["doctor"], kind: "log" },
  {
    id: "cmd-screenshot",
    title: "screenshot 截图",
    args: (ctx) => ["screenshot", "--out", join(SHOTS, `cmd-screenshot-${ctx.tag}.jpg`)],
  },
  {
    id: "cmd-inspect",
    title: "inspect 布局检查",
    args: (ctx) => [
      "inspect",
      "--out",
      join(SHOTS, `cmd-inspect-${ctx.tag}.jpg`),
      "--html",
      join(LOGS, `inspect-${ctx.tag}.html`),
    ],
  },
  { id: "cmd-report", title: "report 步骤报告", args: ["report", "--title", "phone acceptance"], kind: "log" },
  { id: "cmd-status", title: "status 会话状态", args: ["status"], kind: "log" },
];

/**
 * Puts the calculator keypad in front.
 *
 * The calculator reopens wherever it was left — including on a previous run's
 * history list, or on whatever the person using the phone last had — so this
 * presses back until the keypad is the screen. The keypad is the only screen
 * with an input field and a `history record go` button.
 */
async function ensureKeypad(ctx: Ctx): Promise<void> {
  for (let i = 0; i < 4; i++) {
    ctx.run(["launch", "--app", "calculator"]);
    const probe = ctx.run(["observe"]);
    if (probe.out.includes("history record go")) return;
    ctx.run(["key", "--key", "back"]);
    await sleep(600);
  }
  throw new Error("the calculator keypad never came to the front");
}

/**
 * Puts the calculator's history list in front, with at least one row on it.
 *
 * The list is what `read-list` and `scroll-until` need, and the delete key on
 * it is what the approval gate flags — but a freshly installed calculator has
 * no history at all, and the tablet in this run had none until a calculation
 * was made. So the run makes one first: 7, 8, equals.
 */
async function ensureHistory(ctx: Ctx): Promise<void> {
  await ensureKeypad(ctx);
  const probe = ctx.run(["observe"]);
  const go = /\[(\d+)\] button "history record go"/.exec(probe.out)?.[1];
  if (go) {
    ctx.run(["tap", "--ref", go]);
    const list = ctx.run(["observe"]);
    if (!list.out.includes("没有历史记录") && !list.out.includes("No history")) return;
    ctx.run(["key", "--key", "back"]);
    await sleep(500);
  }
  // Seed one calculation, then open the list again.
  ctx.run(["tap", "--text", "7"]);
  ctx.run(["tap", "--text", "8"]);
  ctx.run(["tap", "--text", "keyCode 18"]);
  await sleep(500);
  const again = ctx.run(["observe"]);
  const goAgain = /\[(\d+)\] button "history record go"/.exec(again.out)?.[1];
  if (!goAgain) throw new Error("the calculator keypad lost its history button");
  const opened = ctx.run(["tap", "--ref", goAgain]);
  if (opened.code !== 0) throw new Error(`could not open the calculator history: ${opened.text.trim()}`);
}

/** Runs the 21 commands on one device and returns their cases. */
async function commandCases(ctx: Ctx): Promise<Case[]> {
  const out: Case[] = [];
  await ensureKeypad(ctx);

  for (const c of COMMAND_CASES) {
    const t0 = performance.now();
    const startedAt = Date.now();
    // The three list commands run on the history screen; everything before them
    // runs on the keypad, and `key back` returns to it.
    if (c.id === "cmd-wait-for") await ensureHistory(ctx);
    c.before?.(ctx);
    const args = typeof c.args === "function" ? c.args(ctx) : c.args;
    const r = ctx.run(args);
    const ms = Math.round(performance.now() - t0);
    const ok = c.expect ? c.expect.includes(r.code) : r.code === 0;
    const custom = ok ? (c.check?.(r, ctx) ?? null) : `exit ${r.code}: ${r.text.trim().split("\n")[0]}`;
    const kind = c.kind ?? "screen";
    let shots: string[] = [];
    let detail = (custom ?? r.text.trim().split("\n")[0] ?? "").slice(0, 160);
    if (kind === "screen") {
      const file = join(SHOTS, `${c.id}-${ctx.tag}.jpg`);
      // `screenshot` and `inspect` write their own evidence. The file counts
      // only when this invocation wrote it: a file that was already there is
      // an earlier run's picture, and publishing it would show a screen this
      // run never saw.
      const wrote = existsSync(file) && statSync(file).mtimeMs >= startedAt;
      if (wrote) {
        shots = [`${c.id}-${ctx.tag}.jpg`];
        detail = `${detail} · ${Math.round(statSync(file).size / 1024)} KB`;
      } else {
        shots = [await ctx.shot(c.id)];
        detail = `${detail} · ${ms} ms`;
      }
    }
    out.push({ id: c.id, title: c.title, device: ctx.tag, status: custom ? "fail" : "pass", detail, screenshots: shots, kind, ms });
  }

  // handoff last: it takes the device, so `resume` has to hand it back. On the
  // command line this is the person-facing form (exit 0, "the device is
  // yours"); the agent's own form is the `uitest_handoff` MCP tool, which
  // returns the `handoff` status (exit 2) — the MCP case covers it.
  const handoff = ctx.run(["handoff", "--reason", "acceptance: a person must sign in"]);
  const resume = ctx.run(["resume"]);
  const took = handoff.code === 0 && handoff.text.includes("the device is yours");
  out.push({
    id: "cmd-handoff",
    title: "handoff 交给人 · resume 交回",
    device: ctx.tag,
    status: took && resume.code === 0 ? "pass" : "fail",
    detail: `handoff exit ${handoff.code} · resume exit ${resume.code}`,
    screenshots: [],
    kind: "log",
  });
  return out;
}

/**
 * The approval loop, end to end: ask, replay unanswered, deny, replay, allow,
 * replay, replay again.
 *
 * This is the release's fail-closed guarantee in one sequence, and it is only
 * provable across processes: each CLI invocation is a new process with a new
 * session, so a passing run means the answer really lives on disk and not in a
 * variable.
 */
async function approvalCases(ctx: Ctx): Promise<Case[]> {
  const out: Case[] = [];
  await ensureHistory(ctx);
  const add = (id: string, title: string, status: Status, detail: string, shots: string[] = []): void => {
    out.push({ id, title, device: ctx.tag, status, detail, screenshots: shots, kind: shots.length ? "screen" : "log" });
  };

  const ask = () => {
    const r = ctx.run(["tap", "--text", "history record delete", "--json"]);
    const data = jsonOf(r)?.data as Record<string, unknown> | undefined;
    return { r, id: typeof data?.["approvalId"] === "string" ? data["approvalId"] : null };
  };

  // --- deny path -----------------------------------------------------------
  const first = ask();
  if (first.r.code !== 3 || !first.id) {
    add("approval-pending", "审批：先要人点头", "fail", `expected approval_pending, got exit ${first.r.code}`);
    return out;
  }
  add("approval-pending", "审批：先要人点头", "pass", `approval_pending · id ${first.id} · 60 s`, [await ctx.shot("approval-pending")]);

  const replay1 = ctx.run(["tap", "--text", "history record delete", "--approval-id", first.id, "--json"]);
  add(
    "approval-unanswered",
    "审批：没回答时重放仍等待",
    replay1.code === 3 ? "pass" : "fail",
    `replay without a decision → exit ${replay1.code} (expect 3)`,
  );

  // --- self-approval is impossible ----------------------------------------
  // An agent holds the id and the state dir. The claim is that possessing the
  // id is still not enough, so this checks the disk rather than asserting a
  // sentence: after a replay that was never answered, no decision file may
  // exist *for this id*. A `.allow` here would mean the replay path had
  // written the person's answer itself.
  //
  // Scoped to the id, not the directory: the state dir outlives the run, so a
  // second run at the same version finds the first run's answers on disk and
  // a directory-wide count reports them as self-approval.
  const decisionFor = (id: string) => {
    const dir = join(ctx.stateDir, "approvals", ctx.tag);
    if (!existsSync(dir)) return [] as string[];
    return readdirSync(dir).filter((n) => n === `${id}.allow` || n === `${id}.deny`);
  };
  const beforeAnswer = decisionFor(first.id);
  add(
    "approval-agent-cannot-answer",
    "审批：Agent 拿到 id 也不能自己批准",
    beforeAnswer.length === 0 ? "pass" : "fail",
    `after an unanswered replay the approval ${first.id} holds ${beforeAnswer.length} decision file(s) ` +
      `(expect 0)`,
  );

  const deny = ctx.run(["approvals", "deny", first.id, "--reason", "acceptance: deny path"]);
  add("approval-deny", "审批：人说不", deny.code === 0 ? "pass" : "fail", deny.text.trim().split("\n")[0] ?? "");

  const afterDeny = ctx.run(["tap", "--text", "history record delete", "--approval-id", first.id, "--json"]);
  add(
    "approval-denied-replay",
    "审批：被拒绝后重放被挡",
    afterDeny.code === 4 ? "pass" : "fail",
    `exit ${afterDeny.code} (expect 4) · ${String((jsonOf(afterDeny)?.data as Record<string, unknown> | undefined)?.["reason"] ?? "")}`,
  );

  // --- allow path ----------------------------------------------------------
  const second = ask();
  if (!second.id) {
    add("approval-allow", "审批：人点头后放行", "fail", `no approval id on the second ask (exit ${second.r.code})`);
    return out;
  }
  const allow = ctx.run(["approvals", "allow", second.id, "--yes", "--scope", "once"]);
  const afterAllow = ctx.run(["tap", "--text", "history record delete", "--approval-id", second.id, "--json"]);
  const shots = [await ctx.shot("approval-allowed")];
  add(
    "approval-allow",
    "审批：人点头后放行",
    allow.code === 0 && afterAllow.code === 0 ? "pass" : "fail",
    `allow exit ${allow.code} · replay exit ${afterAllow.code} (expect 0)`,
    shots,
  );
  // The dialog the allow opened is still up; cancel it so the device is left
  // the way it was found.
  ctx.run(["tap", "--text", "取消"]);

  const reuse = ctx.run(["tap", "--text", "history record delete", "--approval-id", second.id, "--json"]);
  add(
    "approval-single-use",
    "审批：一个 id 只能用一次",
    reuse.code === 4 ? "pass" : "fail",
    `replay of the used id → exit ${reuse.code} (expect 4)`,
  );

  // --- self-approval is impossible ----------------------------------------
  // The check above (`approval-unanswered`) proves the replay path returns
  // approval_pending and, via the decision-file count below, that it wrote no
  // answer of its own. It is not repeated here: by this point the person has
  // answered twice, so the directory is no longer empty.
  return out;
}

/** Hold → agent stops → resume → agent continues. */
async function holdCases(ctx: Ctx): Promise<Case[]> {
  const out: Case[] = [];
  const hold = ctx.run(["hold"]);
  const blocked = ctx.run(["observe", "--json"]);
  const resume = ctx.run(["resume"]);
  const after = ctx.run(["observe", "--json"]);
  out.push({
    id: "hold-blocks-agent",
    title: "hold：Agent 命令停在 lease_held",
    device: ctx.tag,
    status: hold.code === 0 && blocked.code === 2 ? "pass" : "fail",
    detail: `hold exit ${hold.code} · observe exit ${blocked.code} (expect 2)`,
    screenshots: [await ctx.shot("hold-blocked")],
    kind: "screen",
  });
  out.push({
    id: "resume-releases",
    title: "resume：交回后 Agent 继续",
    device: ctx.tag,
    status: resume.code === 0 && after.code === 0 ? "pass" : "fail",
    detail: `resume exit ${resume.code} · observe exit ${after.code} (expect 0)`,
    screenshots: [],
    kind: "log",
  });
  return out;
}

/** A real MCP session over stdio: initialize, tools/list, one tools/call. */
async function mcpCase(bin: string, device: string, tag: string): Promise<Case> {
  const child = spawn(process.execPath, [bin, "mcp", "--device", device, "--state-dir", join(WORK, "state", tag)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const rl = createInterface({ input: child.stdout });
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  rl.on("line", (line) => {
    lines.push(line);
    try {
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // Not JSON: a log line on stdout would be a bug, but not this case's.
    }
  });
  let nextId = 1;
  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`${method} timed out`));
        }
      }, 30_000);
    });

  try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acceptance" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await send("tools/list");
    const tools = ((list.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name);
    const call = await send("tools/call", { name: "uitest_observe", arguments: {} });
    const content = (call.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
    const text = content.map((c) => c.text ?? "").join("\n");
    await writeFile(join(LOGS, `mcp-${tag}.log`), lines.join("\n"));
    const ok = tools.length === 21 && text.includes("screen ");
    return {
      id: "mcp",
      title: "MCP：tools/list 与一次 tools/call",
      device: tag,
      status: ok ? "pass" : "fail",
      detail: `${tools.length} 个工具 · uitest_observe → ${text.split("\n")[0]?.slice(0, 60) ?? "no text"}`,
      screenshots: [],
      kind: "log",
    };
  } finally {
    child.stdin.end();
    child.kill();
  }
}

/** Installs the skill into a scratch home; a second install must refuse. */
async function skillCases(bin: string): Promise<Case[]> {
  const home = join(WORK, "skill-home");
  await rm(home, { recursive: true, force: true });
  const dir = join(home, ".claude", "skills", "uitest-phone");
  const first = cli(bin, ["install-skill", "--dir", dir]);
  const skillMd = join(dir, "SKILL.md");
  const marker = join(dir, ".uitest-skill.json");
  const version = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { version?: string }).version : "";
  const again = cli(bin, ["install-skill", "--dir", dir]);
  const force = cli(bin, ["install-skill", "--dir", dir, "--force"]);
  const ok = first.code === 0 && existsSync(skillMd) && version === VERSION && again.code !== 0 && force.code === 0;
  return [
    {
      id: "skill-install",
      title: "Skill 安装、拒绝覆盖、--force 更新",
      device: "host",
      status: ok ? "pass" : "fail",
      detail: `install ${first.code} · marker ${version || "missing"} · 再装 ${again.code}（期望非 0）· --force ${force.code}`,
      screenshots: [],
      kind: "log",
    },
  ];
}

/** `live` is the console's now; the message has to say where it went. */
async function migrationCase(bin: string): Promise<Case> {
  const r = cli(bin, ["live"]);
  const ok = r.code !== 0 && r.err.includes("uitest-console");
  return {
    id: "live-moved",
    title: "live 迁移提示",
    device: "host",
    status: ok ? "pass" : "fail",
    detail: r.err.trim().split("\n")[0] ?? "no message",
    screenshots: [],
    kind: "log",
  };
}

function renderMarkdown(report: Report): string {
  const rows = report.cases
    .map(
      (c) =>
        `| \`${c.id}\` | ${c.device ?? ""} | ${c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "SKIP"} | ${c.detail} |`,
    )
    .join("\n");
  return `# uitest-phone ${report.version} 验收报告

> 本文件由 \`scripts/acceptance-phone.ts\` 生成，请勿手改。生成时间：${report.date}，提交 \`${report.commit}\`。

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
    process.stderr.write("usage: npx tsx scripts/acceptance-phone.ts --targets <id>[,<id>...]\n");
    return 2;
  }
  for (const d of [OUT, SHOTS, LOGS, WORK]) await mkdir(d, { recursive: true });
  // One run at a time: the scratch install is shared, and a second run's
  // cleanup deletes the first one's `node_modules` out from under it.
  const lock = join(WORK, "run.lock");
  if (existsSync(lock)) {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < 3 * 60 * 60 * 1000) {
      process.stderr.write(
        `another acceptance run is using ${WORK} (lock ${Math.round(age / 1000)} s old); ` +
          `wait for it or delete ${lock}\n`,
      );
      return 3;
    }
  }
  await writeFile(lock, String(process.pid));
  try {
    return await run(targets);
  } finally {
    await rm(lock, { force: true });
  }
}

async function run(targets: string[]): Promise<number> {
  for (const f of ["cli-6c585f5b.log", "cli-7544d645.log"]) await rm(join(LOGS, f), { force: true });
  // Every picture in the report must be one this run took. A leftover file is
  // worse than no picture: `commandCases` treats an existing path as evidence
  // the command wrote, so a stale shot would be published under a passing case
  // and describe a screen from an earlier run.
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  // The tarball, not the tree: this is what `npm i -g uitest-phone` installs.
  const packDir = join(WORK, "pack");
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  const packed = execSync(`npm pack --workspace uitest-phone --pack-destination "${packDir}" --json`, {
    cwd: ROOT,
    encoding: "utf8",
  });
  const [{ filename }] = JSON.parse(packed) as Array<{ filename: string }>;
  // The product depends on the library at the version being released, which is
  // not on npm yet during a release run. Install both tarballs together, the
  // way a person installing the pair would.
  const corePacked = execSync(`npm pack --workspace uitest-sdk --pack-destination "${packDir}" --json`, {
    cwd: ROOT,
    encoding: "utf8",
  });
  const [{ filename: coreFile }] = JSON.parse(corePacked) as Array<{ filename: string }>;
  const prefix = join(WORK, "pkg");
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "package.json"), '{"name":"accept-phone","private":true,"type":"module"}\n');
  execSync(
    `npm install --no-audit --no-fund --prefix "${prefix}" "${join(packDir, coreFile)}" "${join(packDir, filename)}"`,
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
  );
  const bin = join(prefix, "node_modules", "uitest-phone", "dist", "bin.js");
  if (!existsSync(bin)) throw new Error(`the installed package has no ${bin}`);

  const version = cli(bin, ["--version"]);
  const tarball = cli(bin, ["--help"]);

  const devices: Report["devices"] = [];
  const cases: Case[] = [];
  cases.push({
    id: "package",
    title: "npm 包安装与版本",
    device: "host",
    status: version.text.includes(`uitest-phone ${VERSION}`) ? "pass" : "fail",
    detail: `${filename} · ${version.text.trim()} · --help ${tarball.code === 0 ? "ok" : `exit ${tarball.code}`}`,
    screenshots: [],
    kind: "log",
  });

  for (const device of targets) {
    const info = await probeDevice(device);
    devices.push(info);
    process.stdout.write(`=== ${info.tag} ===\n`);
    const staged = await stageCalculator(device);
    const ctx = await makeCtx(bin, device, info.tag);
    try {
      for (const c of await commandCases(ctx)) {
        cases.push(c);
        process.stdout.write(`  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} ${c.detail}\n`);
      }
      for (const c of await approvalCases(ctx)) {
        cases.push(c);
        process.stdout.write(`  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} ${c.detail}\n`);
      }
      for (const c of await holdCases(ctx)) {
        cases.push(c);
        process.stdout.write(`  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} ${c.detail}\n`);
      }
      const mcp = await mcpCase(bin, device, info.tag);
      cases.push(mcp);
      process.stdout.write(`  ${mcp.status === "pass" ? "PASS" : "FAIL"} ${mcp.id} ${mcp.detail}\n`);
    } finally {
      await staged.restore();
    }
  }

  for (const c of [...(await skillCases(bin)), await migrationCase(bin)]) {
    cases.push(c);
    process.stdout.write(`  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} ${c.detail}\n`);
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
      "npx tsx scripts/acceptance-phone.ts --targets <id>[,<id>]",
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
