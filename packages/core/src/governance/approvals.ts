import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StepIdentity {
  command: string;
  args: Record<string, unknown>;
  /** Signature of what the step will act on, so a moved target is caught. */
  signature: string;
}

export type ApprovalDecision = "allow" | "deny";
export type ApprovalStatus = "pending" | "allowed" | "denied";

export interface PendingApproval extends StepIdentity {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** The policy rule that asked, when the approval came from the gate. */
  rule?: string;
  bundle?: string;
  task?: string;
  status: ApprovalStatus;
}

/**
 * How long a person's answer lasts.
 *
 * `once` is the exact step. `task` is the same rule, app and task name until
 * the person takes the phone back (`resume`). `always` is the same rule and
 * app for every task using this state dir, until the grants file is deleted.
 */
export type ApprovalScope = "once" | "task" | "always";
export type RememberScope = Exclude<ApprovalScope, "once">;

export interface Grant {
  rule: string;
  /** The app the grant was given in; an empty string means unknown. */
  bundle: string;
  /** The task a `task` grant is bound to; null for `always`. */
  task: string | null;
  scope: RememberScope;
  createdAt: number;
}

export type DecisionResult = {
  /**
   * `conflict` means an answer was already given and it was the opposite one:
   * nothing was written. It is separate from `denied` because "denied" reads
   * as "the person refused" — a caller that reports a conflict as a refusal
   * tells a person their deny took effect when the agent's replay will still
   * proceed.
   */
  kind: "allowed" | "denied" | "conflict" | "unknown" | "expired" | "already-used";
  reason?: string;
};

export type ConsumeResult =
  | { kind: "approved"; rule?: string; scope?: ApprovalScope }
  | { kind: "pending"; reason: string }
  | { kind: "denied"; reason: string }
  | { kind: "stale"; reason: string };

export interface ApprovalOptions {
  /** Directory holding one set of files per approval id. */
  dir: string;
  /** How long a person has to answer, in ms. Defaults to 60 s. */
  ttlMs?: number;
  /** Clock override, for tests. */
  now?: () => number;
}

interface StoredRequest extends StepIdentity {
  id: string;
  createdAt: number;
  expiresAt: number;
  rule?: string;
  bundle?: string;
  task?: string;
}

interface StoredDecision {
  decision: ApprovalDecision;
  at: number;
  by?: "cli" | "console";
  reason?: string;
  scope?: ApprovalScope;
}

/**
 * The part of a step a person approved: what it does, not where it lands. The
 * target signature is compared separately so a moved target is reported as
 * stale rather than as a different action.
 */
function stepHash(step: StepIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: step.command, args: step.args }))
    .digest("hex");
}

/** An id becomes a filename, so anything else must never reach the disk. */
function safeId(id: unknown): string | null {
  const text = String(id ?? "");
  return /^[0-9a-f]{8,64}$/.test(text) ? text : null;
}

/**
 * One-time approvals for steps a policy flagged, answered by a person.
 *
 * An approval is bound to the exact step — command, arguments and the target's
 * signature — so a person approving "delete item 3" cannot have that approval
 * reused for a different item, or for the same button after the list moved.
 * Ids are single-use and expire.
 *
 * The request and the decision are separate files. An agent that holds the id
 * can ask again with it, but cannot answer: only a person-side channel (the
 * `approvals` CLI or the console) writes the allow/deny file. That is what
 * makes the gate fail closed even though the agent can read the directory.
 */
export class Approvals {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ApprovalOptions) {
    this.dir = opts.dir;
    this.ttlMs = Math.max(1, opts.ttlMs ?? 60_000);
    this.now = opts.now ?? Date.now;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      // The first request reports the real error; a status read must not throw.
    }
  }

  /** Records a step awaiting a person, and returns the id to show them. */
  request(
    step: StepIdentity,
    rule?: string,
    context: { bundle?: string; task?: string } = {},
  ): PendingApproval {
    const at = this.now();
    const id = randomBytes(6).toString("hex");
    const entry: StoredRequest = {
      ...step,
      id,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      ...(rule ? { rule } : {}),
      ...(context.bundle ? { bundle: context.bundle } : {}),
      ...(context.task ? { task: context.task } : {}),
    };
    this.writeJson(join(this.dir, `${id}.json`), entry);
    return { ...entry, status: "pending" };
  }

  /** Approvals a person has not answered yet, plus answered ones not yet used. */
  pending(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const id of this.ids()) {
      const request = this.readRequest(id);
      if (!request) continue;
      if (this.now() > request.expiresAt) continue;
      if (existsSync(join(this.dir, `${id}.used`))) continue;
      out.push({ ...request, status: this.status(id)?.status ?? "pending" });
    }
    return out;
  }

  /** One approval and where it stands, or null when the id is unknown. */
  status(id: string): PendingApproval | null {
    const safe = safeId(id);
    if (!safe) return null;
    const request = this.readRequest(safe);
    if (!request) return null;
    return { ...request, status: this.decisionOf(safe) ?? "pending" };
  }

  /**
   * The person's answer. First writer wins: a second answer cannot flip one
   * already given, and an id that is unknown, expired or used is refused.
   */
  decide(
    id: string,
    decision: ApprovalDecision,
    opts: { by?: "cli" | "console"; scope?: ApprovalScope; reason?: string } = {},
  ): DecisionResult {
    const safe = safeId(id);
    if (!safe) return { kind: "unknown", reason: "unknown approval id" };
    const request = this.readRequest(safe);
    if (!request) return { kind: "unknown", reason: "unknown approval id" };
    if (this.now() > request.expiresAt) {
      return { kind: "expired", reason: "approval expired" };
    }
    if (existsSync(join(this.dir, `${safe}.used`))) {
      return { kind: "already-used", reason: "approval already used" };
    }

    const target = join(this.dir, `${safe}.${decision === "allow" ? "allow" : "deny"}`);
    const opposite = join(this.dir, `${safe}.${decision === "allow" ? "deny" : "allow"}`);
    if (existsSync(opposite)) {
      const onDisk = this.decisionOf(safe);
      return {
        kind: "conflict",
        reason: onDisk === "allowed" ? "already allowed; the replay will proceed" : "already denied",
      };
    }
    if (existsSync(target)) return this.decisionResult(safe, decision);

    const stored: StoredDecision = {
      decision,
      at: this.now(),
      ...(opts.by ? { by: opts.by } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
    };
    try {
      writeFileSync(target, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
    } catch {
      // Lost the race to the opposite writer: report the answer on disk.
      return this.decisionResult(safe, decision);
    }
    return this.decisionResult(safe, decision);
  }

  /**
   * Checks an id against the step it is being used for. A mismatch leaves the
   * approval intact — the person approved this id, and the caller may have
   * simply retried with the right step.
   */
  consume(
    id: string,
    step: StepIdentity,
    opts: { scope?: ApprovalScope } = {},
  ): ConsumeResult {
    const safe = safeId(id);
    if (!safe) return { kind: "denied", reason: "unknown or expired approval id" };
    const request = this.readRequest(safe);
    if (!request) return { kind: "denied", reason: "unknown or expired approval id" };
    if (existsSync(join(this.dir, `${safe}.used`))) {
      return { kind: "denied", reason: "approval id already used" };
    }
    if (this.now() > request.expiresAt) {
      return { kind: "denied", reason: "approval expired" };
    }
    if (existsSync(join(this.dir, `${safe}.deny`))) {
      const denied = this.readDecision(safe, "deny");
      return { kind: "denied", reason: denied?.reason ?? "denied by a person" };
    }
    if (!existsSync(join(this.dir, `${safe}.allow`))) {
      return { kind: "pending", reason: "waiting for a person" };
    }
    const allowed = this.readDecision(safe, "allow");
    if (stepHash(request) !== stepHash(step)) {
      return { kind: "denied", reason: "approval does not match this exact action" };
    }
    if (request.signature !== step.signature) {
      return { kind: "stale", reason: "the screen changed while the approval waited" };
    }
    // A grant needs a rule to be remembered by. Checked before burning the id,
    // so the person's allow still covers one plain replay.
    if (opts.scope && opts.scope !== "once" && !request.rule) {
      return { kind: "denied", reason: "this approval carries no policy rule to remember" };
    }
    try {
      writeFileSync(join(this.dir, `${safe}.used`), JSON.stringify({ at: this.now() }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      return { kind: "denied", reason: "approval id already used" };
    }
    return {
      kind: "approved",
      ...(request.rule ? { rule: request.rule } : {}),
      ...(allowed?.scope ? { scope: allowed.scope } : {}),
    };
  }

  // ------------------------------------------------------------ persistence

  /** Ids currently on disk; a partial or unreadable file is skipped. */
  private ids(): string[] {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    for (const name of readDirSafe(this.dir)) {
      const m = /^([0-9a-f]{8,64})\.json$/.exec(name);
      if (m) out.push(m[1]!);
    }
    return out;
  }

  private readRequest(id: string): StoredRequest | null {
    const raw = readJsonSafe(join(this.dir, `${id}.json`));
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<StoredRequest>;
    if (
      typeof r.command !== "string" ||
      typeof r.signature !== "string" ||
      typeof r.createdAt !== "number" ||
      typeof r.expiresAt !== "number" ||
      !r.args ||
      typeof r.args !== "object"
    ) {
      return null;
    }
    return { ...(r as StoredRequest), id };
  }

  private readDecision(id: string, which: ApprovalDecision): StoredDecision | null {
    const raw = readJsonSafe(join(this.dir, `${id}.${which}`));
    if (!raw || typeof raw !== "object") return null;
    const d = raw as Partial<StoredDecision>;
    return d.decision === which ? (d as StoredDecision) : null;
  }

  /** The decision on disk, if any. The deny file wins a corrupt double write. */
  private decisionOf(id: string): ApprovalStatus | null {
    if (existsSync(join(this.dir, `${id}.deny`))) return "denied";
    if (existsSync(join(this.dir, `${id}.allow`))) return "allowed";
    return null;
  }

  private decisionResult(id: string, decision: ApprovalDecision): DecisionResult {
    const actual = this.decisionOf(id);
    if (actual === (decision === "allow" ? "allowed" : "denied")) {
      return { kind: decision === "allow" ? "allowed" : "denied" };
    }
    return { kind: "denied", reason: "already decided" };
  }

  private writeJson(path: string, value: unknown): void {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    } catch {
      // An id that could not be written is an id nobody can use; the step has
      // already been gated, so failing here would only hide the pending answer.
    }
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Approvals a person chose to remember.
 *
 * A grant is narrower than the rule name suggests: it applies to one policy
 * rule *and* the app it was granted in, so approving "delete" in the gallery
 * is not a licence to delete in the bank app. `task` grants also need the same
 * task name; `always` grants cover every task that uses this state dir, and
 * live until the grants file is deleted.
 *
 * A grant is never consulted for `blocked` decisions: credentials, read-only
 * and the app allow-list are not approvals, and no grant can unlock them.
 */
export class Grants {
  private entries: Grant[];
  private readonly now: () => number;
  private readonly path: string | null;
  private saved = "";

  constructor(opts: { path?: string; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.path = opts.path ?? null;
    this.entries = [];
    if (this.path) {
      this.read();
      this.saved = JSON.stringify(this.snapshot());
    }
  }

  /** Grants persist across the CLI's one-command-per-process runs. */
  static async open(path: string, opts: { now?: () => number } = {}): Promise<Grants> {
    await mkdir(dirname(path), { recursive: true });
    return new Grants({ ...opts, path });
  }

  add(grant: Omit<Grant, "createdAt">): void {
    if (this.path) this.read();
    const exists = this.entries.some(
      (g) =>
        g.rule === grant.rule &&
        g.bundle === grant.bundle &&
        g.scope === grant.scope &&
        g.task === grant.task,
    );
    if (exists) return;
    this.entries.push({ ...grant, createdAt: this.now() });
    this.write();
  }

  /** The first grant that covers this action, or null. */
  permits(query: { rule: string; bundle: string; task: string }): Grant | null {
    if (this.path) this.read();
    return (
      this.entries.find(
        (g) =>
          g.rule === query.rule &&
          g.bundle === query.bundle &&
          (g.scope === "always" || g.task === query.task),
      ) ?? null
    );
  }

  list(): Grant[] {
    if (this.path) this.read();
    return this.entries.map((g) => ({ ...g }));
  }

  /** Drops task grants (all of them, or one task's) after a person takes over. */
  clearTask(task?: string): number {
    if (this.path) this.read();
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (g) => g.scope !== "task" || (task !== undefined && g.task !== task),
    );
    const removed = before - this.entries.length;
    if (removed > 0) this.write();
    return removed;
  }

  clear(): void {
    this.entries = [];
    this.write();
  }

  private read(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { grants?: Grant[] };
      if (!Array.isArray(parsed?.grants)) return;
      this.entries = parsed.grants.filter(
        (g): g is Grant =>
          !!g &&
          typeof g.rule === "string" &&
          typeof g.bundle === "string" &&
          (g.scope === "task" || g.scope === "always"),
      );
    } catch {
      // A corrupt grants file falls back to "nothing remembered", which asks
      // more often rather than allowing more. That is the safe direction.
    }
  }

  private snapshot(): { grants: Grant[] } {
    return { grants: this.entries };
  }

  private write(): void {
    if (!this.path) return;
    const now = JSON.stringify(this.snapshot());
    if (now === this.saved) return;
    this.saved = now;
    // Same reasoning as Approvals.write: a grant that is still buffered when
    // the process exits is a grant the person will be asked for again.
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, now);
    } catch {
      /* failing to remember must not fail the approved step */
    }
  }
}
