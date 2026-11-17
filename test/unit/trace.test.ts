import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TraceRecorder, deviceTag } from "../../src/trace.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "uitest-trace-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("TraceRecorder", () => {
  it("writes one JSON line per step", async () => {
    await withDir(async (dir) => {
      const trace = new TraceRecorder({ dir, task: "check wlan" });
      trace.step({ command: "observe", status: "settled", text: "screen" });
      trace.step({ command: "tap", args: { ref: 3 }, status: "settled", text: "ok" });
      await trace.flush();
      const lines = (await readFile(trace.file!, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!);
      expect(first).toMatchObject({ step: 1, command: "observe", status: "settled" });
      expect(JSON.parse(lines[1]!)).toMatchObject({ step: 2, command: "tap" });
    });
  });

  it("never writes the raw device serial", async () => {
    await withDir(async (dir) => {
      const serial = "0123456789ABCDEF";
      const trace = new TraceRecorder({ dir, task: "t", deviceId: serial });
      trace.step({ command: "observe", status: "settled", text: `device ${serial} says hi` });
      await trace.flush();
      const text = await readFile(trace.file!, "utf8");
      expect(text).not.toContain(serial);
      expect(text).toContain(deviceTag(serial));
    });
  });

  it("links a screenshot relative to the report, so the link opens", async () => {
    await withDir(async (dir) => {
      const shot = join(dir, "shots", "001-observe.jpg");
      const trace = new TraceRecorder({ dir: join(dir, "traces"), task: "t" });
      trace.step({ command: "observe", status: "settled", text: "screen", shot });
      const html = await readFile(await trace.report("t"), "utf8");
      // The report lives in traces/, so the shot is one level up — and a
      // browser needs forward slashes, not the host's separator.
      expect(html).toContain('href="../shots/001-observe.jpg"');
      expect(html).not.toContain(dir.replace(/\\/g, "\\\\"));
    });
  });

  it("links a relative screenshot path relative to the report too", async () => {
    // Under the working directory, so the path really is relative and on the
    // same drive as the trace — the case the CLI produces.
    const dir = await mkdtemp(join(process.cwd(), ".tmp-trace-"));
    try {
      // The CLI passes `<state-dir>/shots/x.jpg`: relative to the working
      // directory, not to the trace directory.
      const shot = relative(process.cwd(), join(dir, "shots", "001-observe.jpg"));
      const trace = new TraceRecorder({ dir: join(dir, "traces"), task: "t" });
      trace.step({ command: "observe", status: "settled", text: "screen", shot });
      const html = await readFile(await trace.report("t"), "utf8");
      expect(html).toContain('href="../shots/001-observe.jpg"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the screenshot path with its step", async () => {
    await withDir(async (dir) => {
      const trace = new TraceRecorder({ dir, task: "t" });
      const step = trace.step({ command: "tap", status: "settled", text: "ok", shot: "/x/1.jpg" });
      expect(step.shot).toBe("/x/1.jpg");
      await trace.flush();
      expect(JSON.parse((await readFile(trace.file!, "utf8")).trim())).toMatchObject({
        shot: "/x/1.jpg",
      });
    });
  });

  it("returns an in-memory copy for a report", async () => {
    await withDir(async (dir) => {
      const trace = new TraceRecorder({ dir, task: "t" });
      trace.step({ command: "a", status: "settled", text: "1" });
      trace.step({ command: "b", status: "blocked", text: "2" });
      expect(trace.records()).toHaveLength(2);
      expect(trace.records()[1]!.status).toBe("blocked");
      // Let the constructor's file write land before the directory is removed.
      await trace.flush();
    });
  });

  it("writes an HTML report from the recorded steps", async () => {
    await withDir(async (dir) => {
      const trace = new TraceRecorder({ dir, task: "wlan check" });
      trace.step({ command: "tap", status: "settled", text: 'row "WLAN"' });
      const report = await trace.report("wlan check");
      const html = await readFile(report, "utf8");
      expect(html).toContain("wlan check");
      expect(html).toContain("tap");
      expect(html).toContain("settled");
      expect(html).toContain("&quot;WLAN&quot;");
    });
  });

  it("escapes HTML in step text", async () => {
    await withDir(async (dir) => {
      const trace = new TraceRecorder({ dir, task: "t" });
      trace.step({ command: "type", status: "settled", text: "<script>alert(1)</script>" });
      const html = await readFile(await trace.report("t"), "utf8");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  it("survives a directory that is removed mid-run", async () => {
    await withDir(async (dir) => {
      const trace = new TraceRecorder({ dir, task: "t" });
      trace.step({ command: "a", status: "settled", text: "1" });
      await trace.flush();
      expect(trace.errors()).toEqual([]);
    });
  });

  it("reports every step the task wrote, not just this process's", async () => {
    await withDir(async (dir) => {
      // The CLI runs one command per process, so each command writes its own
      // file. A report built from memory alone would be empty.
      const first = new TraceRecorder({ dir, task: "wlan check" });
      first.step({ command: "observe", status: "settled", text: "screen one" });
      await first.flush();
      const second = new TraceRecorder({ dir, task: "wlan check" });
      second.step({ command: "tap", status: "settled", text: "row WLAN" });
      await second.flush();

      const reporter = new TraceRecorder({ dir, task: "report" });
      const out = await reporter.taskReport({ task: "wlan check", title: "wlan check" });
      expect(out.steps).toBe(2);
      const html = await readFile(out.path, "utf8");
      expect(html).toContain("screen one");
      expect(html).toContain("row WLAN");
      expect(html).toContain("steps 2");
      // Numbered across the whole task, not once per file.
      expect(html).toContain("<td>1</td>");
      expect(html).toContain("<td>2</td>");
    });
  });

  it("leaves another task's steps out of the report", async () => {
    await withDir(async (dir) => {
      const other = new TraceRecorder({ dir, task: "other" });
      other.step({ command: "tap", status: "settled", text: "not mine" });
      await other.flush();
      const mine = new TraceRecorder({ dir, task: "mine" });
      mine.step({ command: "observe", status: "settled", text: "mine one" });
      await mine.flush();

      const out = await new TraceRecorder({ dir, task: "report" }).taskReport({ task: "mine" });
      const html = await readFile(out.path, "utf8");
      expect(html).toContain("mine one");
      expect(html).not.toContain("not mine");
    });
  });

  it("reports the most recent run when no task is named", async () => {
    await withDir(async (dir) => {
      const older = new TraceRecorder({ dir, task: "older" });
      older.step({ command: "observe", status: "settled", text: "old step" });
      await older.flush();
      // Trace file names carry a millisecond timestamp, so two runs need
      // distinct ones to have a defined order.
      await new Promise((r) => setTimeout(r, 5));
      const newer = new TraceRecorder({ dir, task: "newer" });
      newer.step({ command: "tap", status: "settled", text: "new step" });
      await newer.flush();

      const out = await new TraceRecorder({ dir, task: "report" }).taskReport({ task: null });
      expect(out.task).toBe("newer");
      const html = await readFile(out.path, "utf8");
      expect(html).toContain("new step");
      expect(html).not.toContain("old step");
    });
  });

  it("covers the latest run when a task name was used twice", async () => {
    await withDir(async (dir) => {
      // Two runs of one task, hours apart: a report means the run just done,
      // not every time that name was ever used.
      const write = async (name: string, at: string, text: string) => {
        const line = { at, step: 1, task: "wlan check", command: "tap", status: "settled", text };
        await writeFile(join(dir, name), `${JSON.stringify(line)}\n`);
      };
      await write("2026-01-01T09-00-00-000Z-wlan-check.jsonl", "2026-01-01T09:00:00.000Z", "morning");
      await write("2026-01-01T09-00-30-000Z-wlan-check.jsonl", "2026-01-01T09:00:30.000Z", "morning 2");
      await write("2026-01-01T14-00-00-000Z-wlan-check.jsonl", "2026-01-01T14:00:00.000Z", "afternoon");
      await write("2026-01-01T14-00-20-000Z-wlan-check.jsonl", "2026-01-01T14:00:20.000Z", "afternoon 2");

      const out = await new TraceRecorder({ dir, task: "report" }).taskReport({ task: "wlan check" });
      expect(out.steps).toBe(2);
      const html = await readFile(out.path, "utf8");
      expect(html).toContain("afternoon");
      expect(html).not.toContain("morning");
    });
  });

  it("falls back to the newest task and says which one it covered", async () => {
    await withDir(async (dir) => {
      const ran = new TraceRecorder({ dir, task: "wlan check" });
      ran.step({ command: "tap", status: "settled", text: "toggled" });
      await ran.flush();
      // `report` with no --task runs under the task name "report", which
      // recorded nothing; the person means the run they just did.
      const out = await new TraceRecorder({ dir, task: "report" }).taskReport({ task: "report" });
      expect(out.task).toBe("wlan check");
      expect(out.steps).toBe(1);
      expect(await readFile(out.path, "utf8")).toContain("toggled");
    });
  });

  it("says so when a task recorded nothing", async () => {
    await withDir(async (dir) => {
      const out = await new TraceRecorder({ dir, task: "report" }).taskReport({ task: "never ran" });
      expect(out.steps).toBe(0);
      const html = await readFile(out.path, "utf8");
      expect(html).toContain("steps 0");
    });
  });
});

describe("deviceTag", () => {
  it("is a stable 8-character hash", () => {
    expect(deviceTag("ABC123")).toMatch(/^[0-9a-f]{8}$/);
    expect(deviceTag("ABC123")).toBe(deviceTag("ABC123"));
    expect(deviceTag("ABC123")).not.toBe(deviceTag("ABC124"));
  });

  it("is a placeholder when no device is known", () => {
    expect(deviceTag(null)).toBe("nodevice");
  });
});
