import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgv } from "uitest-sdk/commands";
import { Approvals } from "uitest-sdk/govern";
import type { ApprovalScope, PendingApproval } from "uitest-sdk/govern";

/**
 * `uitest-phone approvals list|allow|deny` — the person's side of the gate.
 *
 * This is deliberately *not* one of the agent commands: it never opens a
 * device, and an agent that already holds the id must not be able to answer
 * its own request. The command writes the same decision files the console
 * writes, so either channel can answer a step the policy flagged.
 */

const USAGE = `usage: uitest-phone approvals <list|allow|deny> [options]

  list [--json] [--tag <tag>] [--state-dir dir]
      Approvals waiting for a person, newest state directory first.

  allow <id> [--scope once|task|always] [--reason text] [--yes]
      Answers yes. Without --yes an interactive terminal must confirm.

  deny <id> [--reason text]
      Answers no. The reason is shown to the agent as approval_denied.

Global: --state-dir <dir> (default .uitest-phone), --tag <device-hash>.
Approvals expire 60 s after the agent asks; an expired id is refused.
This command is for a person. Agents must stop at approval_pending and ask.`;

interface StoreAtTag {
  tag: string;
  store: Approvals;
}

/** Tags are directory names under approvals/, never free-form input. */
const TAG = /^[0-9a-f]{8,64}$/;

function stateDirOf(stateDir: string | undefined): string {
  return stateDir ?? ".uitest-phone";
}

/** Every device directory that has approvals, or one named by --tag. */
function stores(stateDir: string, tag: unknown): StoreAtTag[] {
  if (typeof tag === "string") {
    if (!TAG.test(tag)) throw new Error(`invalid --tag "${tag}": expected a device hash`);
    return [{ tag, store: new Approvals({ dir: join(stateDir, "approvals", tag) }) }];
  }
  let names: string[] = [];
  try {
    names = readdirSync(join(stateDir, "approvals"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && TAG.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No state directory yet is an empty list, not an error.
  }
  return names.map((name) => ({
    tag: name,
    store: new Approvals({ dir: join(stateDir, "approvals", name) }),
  }));
}

/** The tag whose directory knows this id; ambiguous ids need --tag. */
function storeForId(stateDir: string, tag: unknown, id: string): StoreAtTag {
  const candidates = stores(stateDir, tag).filter(({ store }) => store.status(id) !== null);
  if (candidates.length === 0) {
    throw new Error(`approval_refused · unknown approval id ${id}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `approval_refused · ${id} exists under several devices (${candidates
        .map((c) => c.tag)
        .join(", ")}); pass --tag`,
    );
  }
  return candidates[0]!;
}

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}` : `${s}s`;
}

interface ListRow extends PendingApproval {
  tag: string;
  ageMs: number;
  expiresInMs: number;
}

function listRows(stateDir: string, tag: unknown): ListRow[] {
  const now = Date.now();
  return stores(stateDir, tag).flatMap(({ tag: name, store }) =>
    store.pending().map((entry) => ({
      ...entry,
      tag: name,
      ageMs: Math.max(0, now - entry.createdAt),
      expiresInMs: Math.max(0, entry.expiresAt - now),
    })),
  );
}

async function confirm(id: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`allow ${id}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function fail(text: string, code = 1): number {
  process.stderr.write(`${text}\n`);
  return code;
}

function scopeOf(value: string | boolean | string[] | undefined): ApprovalScope | undefined {
  if (value === undefined) return undefined;
  if (value === "once" || value === "task" || value === "always") return value;
  throw new Error(`invalid --scope: expected once, task or always — got "${String(value)}"`);
}

export async function approvalsMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const sub = parsed.command;
  if (parsed.help || !sub) {
    process.stdout.write(`${USAGE}\n`);
    return parsed.help ? 0 : 2;
  }
  if (sub !== "list" && sub !== "allow" && sub !== "deny") {
    return fail(`unknown approvals command "${sub}"\n\n${USAGE}`, 2);
  }

  const stateDir = stateDirOf(parsed.options.stateDir);
  const tag = parsed.args["tag"];
  const id = parsed.positionals[0];
  const reason = typeof parsed.args["reason"] === "string" ? parsed.args["reason"].trim() : undefined;

  try {
    if (sub === "list") {
      const rows = listRows(stateDir, tag);
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(rows)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        process.stdout.write("no pending approvals\n");
        return 0;
      }
      const lines = rows.map((row) => {
        const where = `${row.bundle || "unknown"}${row.task ? ` · task ${row.task}` : ""}`;
        const rule = row.rule ?? "-";
        return `${row.id}  ${row.command}  ${where}  rule ${rule}  ${row.status}  age ${seconds(
          row.ageMs,
        )}  expires in ${seconds(row.expiresInMs)}  device ${row.tag}`;
      });
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }

    if (!id) {
      return fail(`error: approvals ${sub} needs an approval id\n\n${USAGE}`, 2);
    }

    if (sub === "allow" && parsed.args["yes"] !== true) {
      if (!process.stdin.isTTY) {
        return fail("approval_refused · --yes is required when no terminal is attached", 2);
      }
      if (!(await confirm(id))) {
        return fail("approval_refused · no answer; the approval is still pending", 2);
      }
    }

    const { store } = storeForId(stateDir, tag, id);
    const decision = sub === "allow" ? "allow" : "deny";
    const result = store.decide(id, decision, {
      by: "cli",
      ...(sub === "allow" ? { scope: scopeOf(parsed.args["scope"]) } : {}),
      ...(reason ? { reason } : {}),
    });

    if (result.kind === (sub === "allow" ? "allowed" : "denied")) {
      process.stdout.write(`${sub === "allow" ? "allowed" : "denied"} ${id}\n`);
      return 0;
    }
    // A conflict is not a refusal: the opposite answer is already on disk and
    // the agent's replay will follow it. Saying "denied" here would tell a
    // person their deny took effect when it did not.
    if (result.kind === "conflict") {
      return fail(`approval_conflict · ${result.reason ?? "already decided"}`, 2);
    }
    return fail(`approval_refused · ${result.reason ?? result.kind}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 1);
  }
}
