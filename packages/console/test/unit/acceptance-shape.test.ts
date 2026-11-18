import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// The console report comes from `scripts/acceptance-console.ts`, which drives
// the real page in headless Chrome. Its whole value is the pictures: takeover
// and the approval inbox have no CLI output to quote.
const REPORT = new URL("../../../../docs/acceptance/console-0.1.0/report.json", import.meta.url);

interface Case {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  screenshots: string[];
  kind?: "screen" | "log";
  device?: string;
}

function load() {
  return JSON.parse(readFileSync(REPORT, "utf8")) as {
    product: string;
    version: string;
    date: string;
    commit: string;
    devices: { tag: string; model: string; resolution: string }[];
    cases: Case[];
    summary: { passed: number; failed: number; skipped: number };
    rerun: string[];
    issues: string[];
  };
}

describe("console acceptance report", () => {
  it("is the 0.1.0 console report", () => {
    expect(existsSync(REPORT)).toBe(true);
    const report = load();
    expect(report.product).toBe("console");
    expect(report.version).toBe("0.1.0");
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("covers the mirror, inspect, inbox, hold and privacy flows", () => {
    const ids = load().cases.map((c) => c.id);

    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of [
      "console-mirror",
      "console-inspect",
      "console-inbox-pending",
      "console-inbox-allow",
      "console-hold",
      "console-resume",
      "console-privacy",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("has at least six browser screenshots", () => {
    const pictures = load().cases.reduce((n, c) => n + c.screenshots.length, 0);
    expect(pictures).toBeGreaterThanOrEqual(6);
  });

  it("gives every non-skip case something to show", () => {
    const report = load();
    for (const c of report.cases) {
      if (c.status === "skip") continue;
      if (c.kind === "log") {
        expect(c.detail.trim().length, `${c.id} has no result text`).toBeGreaterThan(0);
        continue;
      }
      expect(c.screenshots.length, `${c.id} (${c.title}) has no screenshot`).toBeGreaterThan(0);
    }
  });

  it("never carries a device serial", () => {
    expect(readFileSync(REPORT, "utf8")).not.toMatch(/\b(?:FMR|9CN|MLR)\d{6,}/);
  });

  it("counts what it lists", () => {
    const { cases, summary } = load();
    expect(summary.passed).toBe(cases.filter((c) => c.status === "pass").length);
    expect(summary.failed).toBe(cases.filter((c) => c.status === "fail").length);
    expect(summary.skipped).toBe(cases.filter((c) => c.status === "skip").length);
  });

  // A browser screenshot is the whole evidence for a console case. One left in
  // the folder by an earlier run is not: the report names files, so it would be
  // published under a passing case while showing a page this run never opened.
  it("publishes no picture that this run did not take", () => {
    const report = load();
    const dir = new URL("../../../../docs/acceptance/console-0.1.0/screenshots/", import.meta.url);
    const onDisk = new Set(readdirSync(dir));

    for (const c of report.cases) {
      for (const shot of c.screenshots) {
        expect(onDisk.has(shot), `${c.id} names ${shot}, which is not on disk`).toBe(true);
      }
    }
    const named = new Set(report.cases.flatMap((c) => c.screenshots));
    const orphans = [...onDisk].filter((f) => f.endsWith(".jpg") && !named.has(f));
    expect(orphans, `screenshots left over from an earlier run: ${orphans.join(", ")}`).toEqual([]);
  });
});
