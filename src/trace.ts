import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** A stable, non-reversible device identifier. The raw serial never leaves the host. */
export function deviceTag(deviceId: string | null | undefined): string {
  if (!deviceId) return "-";
  return createHash("sha1").update(String(deviceId)).digest("hex").slice(0, 8);
}

export interface TraceEntry {
  command: string;
  args?: unknown;
  status: string;
  text: string;
  /** Screenshot saved for this step, when tracing is on. */
  shot?: string | null;
  [extra: string]: unknown;
}

export interface TraceRecord extends TraceEntry {
  at: string;
  step: number;
}

export interface TraceOptions {
  /** Directory for the trace file and report. */
  dir: string;
  /** Short task name, used in the file name and the report title. */
  task: string;
  /** Raw device serial; only its hash is ever written. */
  deviceId?: string | null;
}

/** What `taskReport` wrote, and what it covered. */
export interface TaskReportResult {
  path: string;
  /** The task the report covers. Empty when nothing was ever recorded. */
  task: string;
  steps: number;
  /** How many trace files the steps were gathered from. */
  files: number;
}

let lastStampAt = 0;
let stampSeq = 0;

/**
 * A file-name-safe timestamp, unique within this process.
 *
 * Two recorders can be created in the same millisecond (a task's second
 * command, or a report right after a step); without the sequence the second
 * one would truncate the first one's file.
 */
function stamp(): string {
  const now = Date.now();
  stampSeq = now === lastStampAt ? stampSeq + 1 : 0;
  lastStampAt = now;
  const iso = new Date(now).toISOString().replace(/[:.]/g, "-");
  // Padded so file names still sort chronologically within one millisecond.
  return `${iso}-${String(stampSeq).padStart(3, "0")}`;
}

function safeName(value: string): string {
  return String(value).replace(/[^A-Za-z0-9一-鿿_-]+/g, "-").slice(0, 40) || "task";
}

/**
 * A pause longer than this starts a new run of the same task name.
 *
 * Commands in one task run are seconds apart; a person coming back to the same
 * task hours later means a new run, and a report should cover the one just
 * finished rather than every time that name was ever used. Long enough that an
 * agent waiting on a person mid-task does not get split.
 */
const RUN_GAP_MS = 30 * 60_000;

/** The trailing group of files whose records are less than `RUN_GAP_MS` apart. */
function latestRun<T extends { at: string; records: TraceRecord[] }>(files: T[]): T[] {
  if (files.length === 0) return [];
  let start = files.length - 1;
  while (start > 0) {
    const previous = files[start - 1]!.records[files[start - 1]!.records.length - 1]!;
    const current = files[start]!.records[0]!;
    const gap = Date.parse(String(current.at)) - Date.parse(String(previous.at));
    if (!(gap <= RUN_GAP_MS)) break;
    start -= 1;
  }
  return files.slice(start);
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Records every step as one JSON line, with the screenshot that belongs to it.
 *
 * The trace is evidence for a person reviewing what an agent did: it must
 * survive a crash (append as we go), must not contain the device serial (only
 * an 8-character hash), and must be readable without this SDK.
 */
export class TraceRecorder {
  readonly file: string | null;
  readonly tag: string;
  private readonly records_: TraceRecord[] = [];
  private readonly failures: string[] = [];
  private readonly serial: string | null;
  private stepCount = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: TraceOptions) {
    this.tag = deviceTag(opts.deviceId);
    // Held only to scrub it out of every field a caller passes in.
    this.serial = opts.deviceId ? String(opts.deviceId) : null;
    this.file = opts.dir ? join(opts.dir, `${stamp()}-${safeName(opts.task)}.jsonl`) : null;
    if (this.file) {
      this.queue = mkdir(opts.dir, { recursive: true })
        .then(() => writeFile(this.file!, ""))
        .catch((e: unknown) => this.note(e));
    }
  }

  /** Records a step and returns the record, including the step number. */
  step(entry: TraceEntry): TraceRecord {
    this.stepCount += 1;
    const raw: TraceRecord = {
      at: new Date().toISOString(),
      step: this.stepCount,
      // The file name is sanitised (`wlan check` → `wlan-check`); the record
      // keeps the name the person typed so a report can print it back.
      task: this.opts.task,
      ...entry,
      text: String(entry.text ?? "").slice(0, 2000),
    };
    // The serial is scrubbed from every field, not just the ones we build. A
    // JSON-key rewrite would miss a serial embedded in an error message; a
    // scrub of the serialised record reaches nested args too.
    let line = JSON.stringify(raw);
    if (this.serial) line = line.split(this.serial).join(this.tag);
    const record = JSON.parse(line) as TraceRecord;
    this.records_.push(record);
    if (this.file) {
      this.queue = this.queue.then(() => appendFile(this.file!, `${line}\n`)).catch((e: unknown) => {
        this.note(e);
      });
    }
    return record;
  }

  records(): TraceRecord[] {
    return [...this.records_];
  }

  /** Waits for every queued write to land. */
  async flush(): Promise<void> {
    await this.queue;
  }

  errors(): string[] {
    return [...this.failures];
  }

  /**
   * A report over every trace file this task wrote.
   *
   * The CLI runs one command per process, so a task's steps are spread across
   * one file per command; a report built from this process alone would hold
   * only the `report` step itself. With no task, the most recent task that
   * recorded at least one step is used — never the empty file this very
   * process just created.
   */
  async taskReport(opts: { task?: string | null; title?: string } = {}): Promise<TaskReportResult> {
    await this.flush();
    if (!this.file) {
      // No directory to read from; this process's memory is all there is.
      const title = opts.title ?? opts.task ?? this.opts.task;
      const path = await this.writeReport(this.records_, title);
      return { path, task: this.opts.task, steps: this.records_.length, files: 0 };
    }

    const files = await this.scan();
    let chosen = opts.task ? latestRun(files.filter((f) => f.task === opts.task)) : [];
    if (chosen.length === 0) {
      // `report` with no `--task` runs under the task name "report", which by
      // definition recorded nothing before this step. Falling back to the
      // newest task is what a person asking for "the report" means; the
      // result names the task it actually covered.
      const newest = files[files.length - 1];
      chosen = newest ? latestRun(files.filter((f) => f.task === newest.task)) : [];
    }

    const records = chosen.flatMap((r) => r.records);
    // Files are chronological, and so is `at`; renumber across files because
    // each one restarted at step 1.
    records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const steps = records.map((r, i) => ({ ...r, step: i + 1 }));
    const task = chosen[0]?.task ?? "";
    const path = await this.writeReport(steps, opts.title ?? (task || this.opts.task));
    return { path, task, steps: steps.length, files: chosen.length };
  }

  /**
   * Every trace file in this recorder's directory, oldest first.
   *
   * The task comes from the records, not the file name: the name is sanitised
   * for the filesystem and an older file may predate the field. A file with no
   * readable step is skipped — that is a command that wrote nothing yet,
   * including the `report` process itself, and it must not count as a run.
   */
  private async scan(): Promise<{ path: string; task: string; at: string; records: TraceRecord[] }[]> {
    if (!this.opts.dir) return [];
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return [];
    }
    const found: { path: string; task: string; at: string; records: TraceRecord[] }[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.opts.dir, name);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const records: TraceRecord[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as TraceRecord);
        } catch {
          // A half-written line from a killed command is skipped, not fatal.
        }
      }
      if (records.length === 0) continue;
      const first = records[0]!;
      // The file name is `<timestamp>-<task>.jsonl`; the timestamp has a
      // variable number of dash-separated fields, so match it from the front.
      const fromName = /^\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-\d+)?-(.*)\.jsonl$/.exec(name)?.[1];
      found.push({
        path,
        task: String(first.task ?? fromName ?? name),
        at: String(first.at ?? ""),
        records,
      });
    }
    found.sort((a, b) => a.at.localeCompare(b.at));
    return found;
  }

  /**
   * A self-contained HTML report of this process's steps: header, one row per
   * step, and a link to each screenshot. Deliberately no external assets so it
   * opens offline. Prefer `taskReport` when a task spans several processes.
   */
  async report(title = this.opts.task): Promise<string> {
    await this.flush();
    return this.writeReport(this.records_, title);
  }

  private async writeReport(records: TraceRecord[], title: string): Promise<string> {
    const html = this.renderHtml(records, title);
    const path = join(this.opts.dir, `${stamp()}-${safeName(title)}.html`);
    await mkdir(this.opts.dir, { recursive: true });
    await writeFile(path, html);
    return path;
  }

  /**
   * A screenshot as a link the browser can follow from the report.
   *
   * The trace stores the absolute path the command was given. Linking it
   * verbatim produces a link that opens nothing — a browser treats an absolute
   * filesystem path as a URL, and the host separator is wrong on the other
   * platform anyway. Relative to the report's own directory, with forward
   * slashes, the report keeps working wherever the state directory is moved.
   */
  private shotHref(shot: string): string {
    // Resolve against the working directory first: a caller's relative path is
    // relative to where the command ran, not to the trace directory.
    const absolute = isAbsolute(shot) ? shot : resolve(shot);
    return relative(this.opts.dir, absolute).split(/[\\/]/).join("/");
  }

  private renderHtml(records: TraceRecord[], title: string): string {
    const rows = records
      .map(
        (r) => `<tr class="status-${escapeHtml(r.status)}">
  <td>${r.step}</td>
  <td><code>${escapeHtml(r.command)}</code></td>
  <td>${escapeHtml(r.status)}</td>
  <td><pre>${escapeHtml(r.text)}</pre></td>
  <td>${r.shot ? `<a href="${escapeHtml(this.shotHref(r.shot))}">shot</a>` : ""}</td>
</tr>`,
      )
      .join("\n");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#222}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}
pre{margin:0;white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace}
.status-settled td:nth-child(3){color:#0a7d32}
.status-blocked td:nth-child(3),.status-approval_denied td:nth-child(3){color:#a11}
.status-uncertain td:nth-child(3),.status-approval_pending td:nth-child(3){color:#a60}
.meta{color:#666;margin-bottom:1rem}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">started ${escapeHtml(records[0]?.at ?? "")} · steps ${records.length} · device ${this.tag}</p>
<table>
<thead><tr><th>#</th><th>command</th><th>status</th><th>detail</th><th>shot</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
  }

  private note(error: unknown): void {
    this.failures.push(error instanceof Error ? error.message : String(error));
  }
}
