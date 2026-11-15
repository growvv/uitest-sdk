#!/usr/bin/env node
/**
 * Device acceptance for `uitest_handoff` — the agent-initiated takeover.
 *
 * Runs a real `uitest-phone mcp` session against the attached device and checks
 * the whole loop: the tool is advertised, the handoff writes a person's lease
 * with its reason, the same session stops with `lease_held`, `resume` releases,
 * and the same session continues. No device id is printed; the lease is named
 * by its hashed tag.
 *
 * Usage: node scripts/acceptance-handoff.mjs [--state-dir <dir>]
 * Prerequisite: npm run build (the script runs dist/bin.js). One device attached.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BIN = join(ROOT, "dist", "bin.js");
const REASON = "Acceptance: unlock the phone, then open Settings";

if (!existsSync(BIN)) {
  console.error("dist/bin.js is missing; run `npm run build` first");
  process.exit(1);
}

const argv = process.argv.slice(2);
let stateDir;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--state-dir") stateDir = argv[++i];
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("usage: node scripts/acceptance-handoff.mjs [--state-dir <dir>]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(1);
  }
}
const temporary = !stateDir;
stateDir ??= mkdtempSync(join(tmpdir(), "uitest-handoff-acceptance-"));

const child = spawn(process.execPath, [BIN, "mcp", "--state-dir", stateDir], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const waiters = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const fn = msg.id !== undefined ? waiters.get(msg.id) : undefined;
    if (fn) {
      waiters.delete(msg.id);
      fn(msg);
    }
  }
});

function request(id, method, params, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`no reply to ${method} within ${timeoutMs} ms`));
    }, timeoutMs);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
    );
  });
}

function assert(condition, what) {
  if (!condition) throw new Error(`FAIL: ${what}`);
  console.log(`ok · ${what}`);
}

function tool(id, name, args) {
  return request(id, "tools/call", { name, arguments: args });
}

function payload(resp) {
  const content = resp.result?.content ?? [];
  const text = content.map((c) => c.text).join("\n");
  const json = content.find((c) => c.text.trim().startsWith("{"));
  return { text, data: json ? JSON.parse(json.text) : {} };
}

function resume() {
  // stderr ignored: the finally-cleanup may run after the session has already
  // reacquired the device, and "held by task mcp" is the correct refusal then.
  return execFileSync(process.execPath, [BIN, "resume", "--state-dir", stateDir], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "acceptance-handoff", version: "0" },
  });
  assert(init.result?.serverInfo?.name === "uitest-phone", "MCP handshake");

  const listed = await request(2, "tools/list");
  const handoffTool = listed.result.tools.find((t) => t.name === "uitest_handoff");
  assert(Boolean(handoffTool), "tools/list exposes uitest_handoff");
  assert(
    JSON.stringify(handoffTool.inputSchema.required) === '["reason"]',
    "uitest_handoff requires reason",
  );

  const before = payload(await tool(3, "uitest_status", {}));
  assert(before.data.status === "settled", `the session owns the device first (got ${before.data.status})`);

  const handed = await tool(4, "uitest_handoff", { reason: REASON });
  const h = payload(handed);
  assert(h.data.status === "handoff", `handoff status is handoff (got ${h.data.status})`);
  assert(handed.result.isError === true, "handoff is an MCP error result (stop, do not retry)");
  assert(h.text.includes(REASON), "the reason is in the agent-facing text");

  const locks = readdirSync(join(stateDir, "leases")).filter((f) => f.endsWith(".lock"));
  assert(locks.length === 1, "exactly one lease holds the device");
  const lease = JSON.parse(readFileSync(join(stateDir, "leases", locks[0]), "utf8"));
  assert(lease.task === "held by a person", "lease task is \"held by a person\"");
  assert(lease.hold === true, "lease is marked as a person's hold");
  assert(lease.reason === REASON, "lease records the reason");
  console.log(`lease tag: ${locks[0].replace(/\.lock$/, "")}`);

  const stopped = payload(await tool(5, "uitest_status", {}));
  assert(stopped.data.status === "lease_held", `same session stops with lease_held (got ${stopped.data.status})`);
  assert(stopped.text.includes("A person is using the phone"), "agent is told a person has the phone");
  assert(stopped.text.includes(REASON), "lease_held repeats the reason");

  assert(resume().includes("released"), "resume hands the phone back");

  const back = payload(await tool(6, "uitest_status", {}));
  assert(back.data.status === "settled", `same session continues after resume (got ${back.data.status})`);

  console.log("handoff acceptance ok");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  // Never leave a person's lease behind, even when an assertion failed.
  try {
    resume();
  } catch {
    /* already free */
  }
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  if (temporary && !process.exitCode) rmSync(stateDir, { recursive: true, force: true });
  else if (stateDir) console.error(`state kept at ${stateDir}`);
}
