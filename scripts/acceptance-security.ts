/**
 * Wire-level acceptance for the live page's Origin check (0.9.3).
 *
 * The unit tests call `originAllowed` directly. This runs the real shipped
 * wiring — `startLive` on a real device, the real HTTP server, real TCP — and
 * records what the server actually answers for each kind of caller:
 *
 *   1. the page's own origin            → 101
 *   2. another site's origin            → 403
 *   3. `Origin: null` (file://, iframe) → 403
 *   4. DNS rebinding (domain Host)      → 403
 *   5. a different port on loopback     → 403
 *   6. no Origin at all (native client) → 101
 *   7. the wrong path                   → 404
 *
 * Usage:
 *   npx tsx scripts/acceptance-security.ts --target <device id>[,<id>...]
 *
 * Writes `docs/acceptance/security/report.md` and a log per device. Devices are
 * named by their 8-character tag, never by serial.
 */
import { createConnection, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLive, liveOptions } from "../src/live/cli.js";
import { handshakeStatus } from "../src/cast/ws.js";
import { tagOf } from "../src/session.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.UITEST_ACCEPTANCE_DIR
  ? resolve(process.env.UITEST_ACCEPTANCE_DIR, "security")
  : join(ROOT, "docs/acceptance/security");

interface Attempt {
  name: string;
  expect: number;
  got: number | null;
  head: string;
  ms: number;
}

/** A WebSocket handshake with the headers the caller chooses. */
function handshake(
  port: number,
  opts: { origin?: string; host?: string; path?: string },
): Promise<{ status: number | null; head: string; ms: number }> {
  const path = opts.path ?? "/live";
  const host = opts.host ?? `127.0.0.1:${port}`;
  const started = performance.now();
  return new Promise((resolveAttempt) => {
    const socket: Socket = createConnection({ host: "127.0.0.1", port });
    let buf = "";
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      const ms = Math.round(performance.now() - started);
      socket.destroy();
      resolveAttempt({ status, head: buf.split("\r\n")[0] ?? "", ms });
    };
    socket.setTimeout(5000, () => finish(handshakeStatus(buf)));
    socket.on("error", () => finish(handshakeStatus(buf)));
    socket.on("close", () => finish(handshakeStatus(buf)));
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
      if (buf.includes("\r\n")) finish(handshakeStatus(buf));
    });
  });
}

async function runTarget(target: string): Promise<{ tag: string; attempts: Attempt[] }> {
  const tag = tagOf(target);
  const run = await startLive(
    { deviceId: target },
    { ...liveOptions({}), httpPort: 0, open: false, layout: false },
    { stateDir: join(ROOT, ".work-bench/accept/state"), task: "security-acceptance" },
  );
  const port = run.server.port;
  try {
    const cases: Array<{ name: string; expect: number } & Parameters<typeof handshake>[1]> = [
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
    const attempts: Attempt[] = [];
    for (const c of cases) {
      const r = await handshake(port, c);
      attempts.push({ name: c.name, expect: c.expect, got: r.status, head: r.head, ms: r.ms });
    }
    return { tag, attempts };
  } finally {
    await run.close();
  }
}

function render(results: Array<{ tag: string; attempts: Attempt[] }>, startedAt: string): string {
  const tags = results.map((r) => r.tag);
  const pass = (a: Attempt) => a.got === a.expect;
  const allOk = results.every((r) => r.attempts.every(pass));
  const names = results[0]?.attempts.map((a) => a.name) ?? [];
  const lines: string[] = [];
  lines.push("# live 投屏页来源校验验收报告");
  lines.push("");
  lines.push(`> 本文件由 \`scripts/acceptance-security.ts\` 生成，请勿手改。生成时间：${startedAt}`);
  lines.push("");
  lines.push(
    `- 结果：**${allOk ? "全部通过" : "有失败项"}** · ${results.length} 台设备 × ${names.length} 个握手`,
  );
  lines.push(
    "- 每一行都是一次真实的 TCP 连接 + WebSocket 握手：服务端是 \`startLive\` 起的那一个，不是模拟。",
  );
  lines.push("");
  lines.push(`| 握手 | 期望 | ${tags.join(" | ")} |`);
  lines.push(`|---|---|${tags.map(() => "---").join("|")}|`);
  for (const name of names) {
    const cells = results.map((r) => {
      const a = r.attempts.find((x) => x.name === name)!;
      return `${pass(a) ? "✅" : "❌"} ${a.got ?? "无响应"}（${a.ms} ms）`;
    });
    const expect = results[0]!.attempts.find((x) => x.name === name)!.expect;
    lines.push(`| ${name} | ${expect} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## 响应行原文");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.tag}`);
    lines.push("");
    lines.push("```");
    for (const a of r.attempts) lines.push(`${a.name}: ${a.head || "(连接被直接关闭，无响应行)"}`);
    lines.push("```");
    lines.push("");
  }
  lines.push("## 怎么读这张表");
  lines.push("");
  lines.push("- `101` 是握手成功；`403` 是拒绝升级，帧、布局、客户端 id 一个字节都不会发出去。");
  lines.push("- 第 1 行是页面自己的来源：浏览器从服务端打印的地址打开页面时，发出的就是这个 `Origin`。");
  lines.push(
    "- 第 2~5 行是攻击面：任意网站、沙箱 iframe / `file://`、DNS rebinding、同机另一个端口。四者都必须被拒绝，否则任何你打开的网页都能接管手机。",
  );
  lines.push(
    "- 第 6 行放行的是没有 `Origin` 的程序化客户端：它不是浏览器，不受页面约束，本来就能自己跑 `hdc`。",
  );
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<number> {
  const i = process.argv.indexOf("--targets");
  const raw = i >= 0 ? process.argv[i + 1] : process.env.UITEST_TARGETS;
  const targets = (raw ?? "").split(",").filter(Boolean);
  if (targets.length === 0) {
    process.stderr.write("usage: npx tsx scripts/acceptance-security.ts --targets <id>[,<id>...]\n");
    return 2;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const results: Array<{ tag: string; attempts: Attempt[] }> = [];
  for (const target of targets) {
    process.stdout.write(`=== ${tagOf(target)} ===\n`);
    try {
      const r = await runTarget(target);
      results.push(r);
      for (const a of r.attempts) {
        process.stdout.write(
          `  ${a.got === a.expect ? "PASS" : "FAIL"} ${a.name}: ${a.got ?? "no response"} ` +
            `(expected ${a.expect}, ${a.ms} ms)\n`,
        );
      }
    } catch (e) {
      process.stdout.write(`  FAILED to start: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  const report = render(results, startedAt);
  await writeFile(join(OUT_DIR, "report.md"), report, "utf8");
  const failed = results.flatMap((r) => r.attempts).filter((a) => a.got !== a.expect).length;
  process.stdout.write(`report: ${join(OUT_DIR, "report.md")}\nfail ${failed}\n`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
