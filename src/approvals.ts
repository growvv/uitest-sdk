import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface StepIdentity {
  command: string;
  args: Record<string, unknown>;
  /** Signature of what the step will act on, so a moved target is caught. */
  signature: string;
}

export interface PendingApproval extends StepIdentity {
  id: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export type ConsumeResult =
  | { kind: "approved" }
  | { kind: "denied"; reason: string }
  | { kind: "stale"; reason: string };

export interface ApprovalOptions {
  /** How long a person has to answer, in ms. */
  ttlMs?: number;
  /** Clock override, for tests. */
  now?: () => number;
}

/** The on-disk shape: ids and their step bindings. */
interface StoredApproval extends StepIdentity {
  id: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
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

/**
 * One-time approvals for steps a policy flagged.
 *
 * An approval is bound to the exact step — command, arguments and the target's
 * signature — so a person approving "delete item 3" cannot have that approval
 * reused for a different item, or for the same button after the list moved.
 * Ids are single-use and expire.
 */
export class Approvals {
  private readonly entries = new Map<string, StoredApproval>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly path: string | null;
  /** Serialised form last read or written, so an unchanged file is not rewritten. */
  private saved = "";

  constructor(opts: ApprovalOptions & { path?: string } = {}) {
    this.ttlMs = Math.max(1, opts.ttlMs ?? 10 * 60_000);
    this.now = opts.now ?? Date.now;
    this.path = opts.path ?? null;
    if (this.path) {
      this.read();
      this.saved = JSON.stringify(this.snapshot());
    }
  }

  /**
   * An approval store that survives the process.
   *
   * The CLI runs one command per invocation, so the id printed by a
   * `approval_pending` command has to be readable by the command that replays
   * the step. An in-memory store would make every approval unfulfillable.
   */
  static async open(path: string, opts: ApprovalOptions = {}): Promise<Approvals> {
    await mkdir(dirname(path), { recursive: true });
    return new Approvals({ ...opts, path });
  }

  /** Records a step awaiting a person, and returns the id to show them. */
  request(step: StepIdentity): PendingApproval {
    const at = this.now();
    const id = randomBytes(6).toString("hex");
    const entry: StoredApproval = {
      ...step,
      id,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      used: false,
    };
    this.entries.set(id, entry);
    this.write();
    return entry;
  }

  /**
   * Checks an id against the step it is being used for. A mismatch leaves the
   * approval intact — the person approved this id, and the caller may have
   * simply retried with the right step.
   */
  consume(id: string, step: StepIdentity): ConsumeResult {
    if (this.path) this.read();
    const entry = this.entries.get(String(id ?? ""));
    if (!entry) return { kind: "denied", reason: "unknown or expired approval id" };
    if (entry.used) return { kind: "denied", reason: "approval id already used" };
    if (this.now() > entry.expiresAt) return { kind: "denied", reason: "approval expired" };
    if (stepHash(entry) !== stepHash(step)) {
      return { kind: "denied", reason: "approval does not match this exact action" };
    }
    if (entry.signature !== step.signature) {
      return { kind: "stale", reason: "the screen changed while the approval waited" };
    }
    entry.used = true;
    this.write();
    return { kind: "approved" };
  }

  /** Approvals a person has not answered yet, for status output. */
  pending(): PendingApproval[] {
    if (this.path) this.read();
    return [...this.entries.values()]
      .filter((e) => !e.used && this.now() <= e.expiresAt)
      .map(({ ...rest }) => rest);
  }

  clear(): void {
    this.entries.clear();
    this.write();
  }

  // ------------------------------------------------------------ persistence

  private read(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as {
        entries?: Record<string, StoredApproval>;
      };
      if (!parsed || typeof parsed.entries !== "object" || !parsed.entries) return;
      this.entries.clear();
      for (const [id, entry] of Object.entries(parsed.entries)) {
        if (entry && typeof entry === "object") this.entries.set(id, entry);
      }
    } catch {
      // A corrupt file must not fail a command that would otherwise work.
    }
  }

  private snapshot(): { entries: Record<string, StoredApproval> } {
    // Expired and used ids are dead weight; keeping them only makes the file
    // grow and invites someone to wonder why an old id is still listed.
    const entries: Record<string, StoredApproval> = {};
    for (const [id, entry] of this.entries) {
      if (entry.used || this.now() > entry.expiresAt) continue;
      entries[id] = entry;
    }
    return { entries };
  }

  private write(): void {
    if (!this.path) return;
    const now = JSON.stringify(this.snapshot());
    if (now === this.saved) return;
    this.saved = now;
    // Synchronous on purpose: the file is a few hundred bytes, and an id that
    // is still buffered when the process exits is an id nobody can use. The
    // write cannot fail a step — losing an approval is the same outcome as
    // writing it and having it expire, and the step has already been gated.
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, now);
    } catch {
      /* see above: an unwritten approval is not a reason to fail the step */
    }
  }
}
