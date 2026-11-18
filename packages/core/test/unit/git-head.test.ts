import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitHead } from "../../../../scripts/acceptance.js";

const ROOT = new URL("../../../../", import.meta.url);
const RUNNERS = ["acceptance-core.ts", "acceptance-phone.ts", "acceptance-console.ts"];

/** A one-commit repository, so HEAD has something to name. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "uitest-githead-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "one");
  return dir;
}

describe("gitHead", () => {
  it("names the commit on a clean tree", () => {
    const dir = repo();
    expect(gitHead({ root: dir })).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("says the tree was dirty when a tracked file was edited", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(gitHead({ root: dir })).toMatch(/^[0-9a-f]{7,}\+dirty$/);
  });

  // An acceptance run writes its report and screenshots into a directory that
  // is new whenever the version is new. Counting that as dirt stamps every
  // first run at a new version `+dirty`, which says the code was modified when
  // only the run's own output was — and a reader who sees `+dirty` on every
  // release stops treating it as a signal at all.
  it("ignores the run's own evidence directory", () => {
    const dir = repo();
    mkdirSync(join(dir, "docs", "acceptance", "core-0.10.1", "shots"), { recursive: true });
    writeFileSync(join(dir, "docs", "acceptance", "core-0.10.1", "report.json"), "{}\n");
    expect(gitHead({ root: dir, exclude: ["docs/acceptance/core-0.10.1"] })).toMatch(
      /^[0-9a-f]{7,}$/,
    );
  });

  it("still reports dirt outside the excluded directory", () => {
    const dir = repo();
    mkdirSync(join(dir, "docs", "acceptance", "core-0.10.1"), { recursive: true });
    writeFileSync(join(dir, "docs", "acceptance", "core-0.10.1", "report.json"), "{}\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(gitHead({ root: dir, exclude: ["docs/acceptance/core-0.10.1"] })).toMatch(/\+dirty$/);
  });


  // The runners call git from a subdirectory: the `ROOT` they import for
  // evidence paths is `docs/acceptance`, not the repository. A pathspec is
  // resolved relative to git's cwd, so `docs/acceptance/console-0.1.1` meant
  // `docs/acceptance/docs/acceptance/console-0.1.1` and excluded nothing —
  // every report of 0.10.1 came out `+dirty` on a clean tree.
  it("excludes an evidence directory when git runs from a subdirectory", () => {
    const dir = repo();
    const sub = join(dir, "docs", "acceptance");
    mkdirSync(join(sub, "core-0.10.1"), { recursive: true });
    writeFileSync(join(sub, "core-0.10.1", "report.json"), "{}\n");
    expect(gitHead({ root: sub, exclude: ["docs/acceptance/core-0.10.1"] })).toMatch(
      /^[0-9a-f]{7,}$/,
    );
  });

  it("still reports dirt outside the excluded directory when run from a subdirectory", () => {
    const dir = repo();
    const sub = join(dir, "docs", "acceptance");
    mkdirSync(join(sub, "core-0.10.1"), { recursive: true });
    writeFileSync(join(sub, "core-0.10.1", "report.json"), "{}\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(gitHead({ root: sub, exclude: ["docs/acceptance/core-0.10.1"] })).toMatch(/\+dirty$/);
  });

  // Three runners each had their own copy, and a fix in one would have left
  // the other two stamping `+dirty` on every first run at a new version.
  it.each(RUNNERS)("%s stamps the commit through the shared helper", (name) => {
    const text = readFileSync(new URL(`scripts/${name}`, ROOT), "utf8");
    expect(text).not.toMatch(/function gitHead\(/);
    expect(text).toMatch(/gitHead\(\{ exclude: \[relative\(ROOT, OUT\)\] \}\)/);
  });
});
