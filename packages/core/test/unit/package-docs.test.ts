import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The core package's outward-facing documents have to agree with the code.
 *
 * Every check here exists because one of them had already drifted: the docs
 * listed 7 of the 13 error classes, the site still advertised a feature 0.9.0
 * had shipped, and the tarball carried Huawei-signed binaries under a bare MIT
 * licence with no notice at all. These assertions are what keeps them honest
 * without a person re-reading them each release.
 *
 * The package root and the repository root are different now: documents ship
 * with the package, while the site and the acceptance record stay in the repo.
 */

const CORE = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const readCore = (rel: string) => readFileSync(join(CORE, rel), "utf8");
const readRoot = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const errorsSource = readCore("src/transport/errors.ts");
const apiDoc = readCore("docs/api.md");

/** Every `export class XError` in the source, in declaration order. */
function errorClassNames(): string[] {
  return [...errorsSource.matchAll(/^export class (\w+Error)\b/gm)].map((m) => m[1]!);
}

function corePackage(): { version: string; files: string[]; dependencies?: Record<string, string>; bin?: unknown } {
  return JSON.parse(readCore("package.json"));
}

describe("docs/api.md · error table", () => {
  it("documents every error class the package exports", () => {
    const names = errorClassNames();
    expect(names.length).toBeGreaterThan(10);
    const missing = names.filter((name) => !apiDoc.includes(name));
    expect(missing, `docs/api.md does not mention: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("CHANGELOG.md", () => {
  it("exists at the package root", () => {
    expect(existsSync(join(CORE, "CHANGELOG.md"))).toBe(true);
  });

  it("has an entry for the version in package.json", () => {
    // A release that bumps the version and forgets the changelog ships a
    // package whose npm page shows no record of what changed.
    expect(readCore("CHANGELOG.md")).toContain(corePackage().version);
  });

  it("ships inside the published tarball", () => {
    expect(corePackage().files).toContain("CHANGELOG.md");
  });
});

describe("NOTICE", () => {
  it("exists and names the bundled binaries", () => {
    expect(existsSync(join(CORE, "NOTICE"))).toBe(true);
    const notice = readCore("NOTICE");
    for (const name of ["agent.so", "libscreen_casting.z.so"]) {
      expect(notice).toContain(name);
    }
    // MIT covers this repository's source. Saying so is the whole point: the
    // bundled extensions are Huawei's signed builds, and the licence does not
    // reach them.
    expect(notice).toMatch(/MIT/);
  });

  it("ships inside the published tarball", () => {
    expect(corePackage().files).toContain("NOTICE");
  });

  it("lists the same versions as assets/manifest.json", () => {
    const manifest = JSON.parse(readCore("assets/manifest.json")) as Record<
      string,
      Record<string, { version: string }>
    >;
    const notice = readCore("NOTICE");
    for (const abi of Object.keys(manifest)) {
      for (const [file, meta] of Object.entries(manifest[abi]!)) {
        expect(notice, `${abi}/${file} version`).toContain(meta.version);
      }
    }
  });

  it("states a checksum that matches the file it ships", () => {
    // The NOTICE's whole value is that a reader can check what they got. A
    // stale md5 would tell them the download is corrupt when it is not.
    const manifest = JSON.parse(readCore("assets/manifest.json")) as Record<
      string,
      Record<string, { size: number; md5: string }>
    >;
    const notice = readCore("NOTICE");
    for (const abi of Object.keys(manifest)) {
      for (const [file, meta] of Object.entries(manifest[abi]!)) {
        const bytes = readFileSync(join(CORE, "assets", abi, file));
        expect(bytes.length, `${abi}/${file} size`).toBe(meta.size);
        const md5 = createHash("md5").update(bytes).digest("hex");
        expect(md5, `${abi}/${file} md5 in manifest`).toBe(meta.md5);
        expect(notice, `${abi}/${file} md5 in NOTICE`).toContain(meta.md5);
      }
    }
  });
});

describe("site roadmap", () => {
  // `live` takeover shipped in 0.9.0 and the site kept listing it as planned.
  // A public page promising work that already exists is a false statement,
  // and it survived a release because nothing checked the section's content.
  it("does not list the live takeover as still planned", () => {
    const changelog = readRoot("site/changelog.html");
    const section = /<section[^>]*id="roadmap"[^>]*>([\s\S]*?)<\/section>/.exec(changelog)?.[1] ?? "";
    expect(section).not.toBe("");
    expect(section).not.toContain("页的点击交互");
    expect(section).not.toContain("画布上点一下等于在设备上点一下");
  });
});

describe("README acceptance figures", () => {
  // The README is the package's front door on npm and GitHub. Its acceptance
  // date and screenshot timing had both gone stale while the report they cite
  // was regenerated twice.
  const report = () => readRoot("docs/acceptance/report.md");

  it("cites the date of the report it points at", () => {
    const readme = readCore("README.md");
    const generated = /生成时间：(\d{4}-\d{2}-\d{2})/.exec(report())?.[1];
    expect(generated).toBeTruthy();
    expect(readme).toContain(generated!);
  });

  it("does not quote a screenshot timing the report contradicts", () => {
    // The report is the measurement of record. A range whose upper bound is
    // below the measured value tells a reader the SDK is faster than it is.
    const measured = /`captureScreen` \| ✅ (\d+) ms/.exec(report())?.[1];
    expect(measured).toBeTruthy();
    const readme = readCore("README.md");
    const claim = /\| 整屏截图 \| `agent\.captureScreen\(\)` \| \*\*(\d+)~(\d+) ms\*\* \|/.exec(readme);
    expect(claim, "README no longer states a captureScreen range").toBeTruthy();
    const high = Number(claim![2]);
    expect(high).toBeGreaterThanOrEqual(Number(measured));
  });

  it("quotes a range docs/api.md's captureScreen line agrees with", () => {
    const lines = apiDoc.split("\n").filter((l) => l.includes("dev.agent.captureScreen()"));
    expect(lines.length).toBeGreaterThan(0);
    const ranges = lines.flatMap((l) =>
      [...l.matchAll(/(\d+)[–~-](\d+) ms/g)].map((m) => [Number(m[1]), Number(m[2])] as const),
    );
    expect(ranges.length, `no captureScreen line states a timing: ${lines.join(" | ")}`).toBeGreaterThan(0);
    const measured = Number(/`captureScreen` \| ✅ (\d+) ms/.exec(report())?.[1]);
    for (const [low, high] of ranges) {
      expect(high).toBeGreaterThanOrEqual(measured);
      expect(low).toBeLessThanOrEqual(measured);
    }
  });

  it("keeps every published screenshot range wide enough for the current report", () => {
    // The bench table and the capability table are a few hundred lines apart
    // and come from different runs, so they legitimately differ. What they may
    // not do is exclude the latest measurement — that is how "107–193 ms"
    // survived two regenerated reports.
    const site = readRoot("site/index.html");
    const measured = Number(/`captureScreen` \| ✅ (\d+) ms/.exec(report())?.[1]);
    const ranges = [...site.matchAll(/整屏截图[^\n]*?(\d+)–(\d+) ms/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    expect(ranges.length).toBeGreaterThan(1);
    for (const [low, high] of ranges) {
      expect(low, `a range starting at ${low} ms excludes the report's ${measured} ms`).toBeLessThanOrEqual(measured);
      expect(high, `a range ending at ${high} ms excludes the report's ${measured} ms`).toBeGreaterThanOrEqual(measured);
    }
  });

  it("keeps the UI-tree node count wide enough for the current report", () => {
    // Same table, same failure mode: the count moves with whatever screen the
    // acceptance run lands on, and the README's range was written for a lighter
    // page than the one the report now measures.
    const measured = Number(/`captureLayout` \| ✅ (\d+) nodes/.exec(report())?.[1]);
    expect(measured).toBeGreaterThan(0);
    const claim = /^\| UI 树 \| `agent\.captureLayout\(\)` \| ~(\d+)~(\d+) 节点 \|$/m.exec(readCore("README.md"));
    expect(claim, "README no longer states a captureLayout node range").toBeTruthy();
    expect(Number(claim![1])).toBeLessThanOrEqual(measured);
    expect(Number(claim![2])).toBeGreaterThanOrEqual(measured);
  });
});

describe("SECURITY.md", () => {
  it("exists at the package root and says how to report a vulnerability", () => {
    // A security policy nobody can find is the same as no policy: npm links
    // this file from the package page, and a reporter looks for the word
    // "report" before anything else.
    expect(existsSync(join(CORE, "SECURITY.md"))).toBe(true);
    expect(readCore("SECURITY.md")).toMatch(/security\/advisories/);
  });

  it("states the Origin rule the server actually implements", () => {
    // The doc's value is that it describes this code. If the rule in
    // `origin.ts` changes and the doc does not, the doc starts promising a
    // protection the server no longer gives.
    const doc = readCore("SECURITY.md");
    expect(doc).toContain("Origin");
    expect(doc).toContain("403");
    // Both halves of the allow-list: the port must match, and a loopback-bound
    // server must be dialled by a loopback name (that is the rebinding guard).
    expect(doc.toLowerCase()).toContain("dns rebinding");
    expect(readCore("src/viewer/origin.ts")).toContain("isAddressLiteral");
  });

  it("does not promise a protection it disclaims", () => {
    // A doc that says "no runtime dependencies" while package.json has four is
    // worse than silence. Pin the claim to the manifest.
    const doc = readCore("SECURITY.md");
    const deps = Object.keys(corePackage().dependencies ?? {});
    if (doc.includes("没有运行时依赖")) {
      expect(deps, "SECURITY.md says there are no runtime dependencies").toEqual([]);
    }
    // Whatever it does say, every real dependency has to be named.
    for (const dep of deps) expect(doc).toContain(dep);
  });

  it("ships inside the published tarball", () => {
    expect(corePackage().files).toContain("SECURITY.md");
  });

  it("is linked from the README", () => {
    expect(readCore("README.md")).toContain("SECURITY.md");
  });
});

describe("package split", () => {
  // 0.10.0 moved the CLI, the MCP server, the skill and the browser page out
  // of the library. A core README that still tells a reader `npx uitest-sdk
  // mcp` sends them to a package with no bin at all, and the reader has no way
  // to tell the doc is stale.
  const coreReadme = readCore("README.md");
  const phoneReadme = readFileSync(join(ROOT, "packages", "phone", "README.md"), "utf8");
  const consoleReadme = readFileSync(join(ROOT, "packages", "console", "README.md"), "utf8");

  it("does not present the CLI, MCP or live page as the library's own", () => {
    for (const gone of [
      "npx uitest-sdk mcp",
      "npx uitest-sdk install-skill",
      "npx uitest-sdk live",
      "npx uitest-sdk connect",
      "npm install -g uitest-sdk",
    ]) {
      expect(coreReadme, `core README still advertises "${gone}"`).not.toContain(gone);
      expect(apiDoc, `docs/api.md still advertises "${gone}"`).not.toContain(gone);
    }
  });

  it("names the two products a reader should install instead", () => {
    expect(coreReadme).toContain("uitest-phone");
    expect(coreReadme).toContain("uitest-console");
  });

  it("documents the session categories and the subpaths", () => {
    for (const name of ["observe", "act", "wait", "cast", "view", "govern"]) {
      expect(apiDoc, `docs/api.md does not document the ${name} namespace`).toContain(name);
    }
    expect(apiDoc).toContain("connect(");
    for (const subpath of ["uitest-sdk/commands", "uitest-sdk/cast", "uitest-sdk/viewer", "uitest-sdk/govern", "uitest-sdk/drivers"]) {
      expect(apiDoc, `docs/api.md does not link ${subpath}`).toContain(subpath);
    }
  });

  it("gives the phone README every command the CLI serves", () => {
    // The README is what npm shows. A command missing here is a command a
    // reader will never discover, and the count in the prose would be wrong.
    for (const name of [
      "observe", "tap", "type", "swipe", "double-click", "drag", "fling",
      "pinch", "key", "wait-for", "read-list", "scroll-until", "launch",
      "apps", "window", "doctor", "screenshot", "inspect", "report", "status",
      "handoff",
    ]) {
      expect(phoneReadme, `phone README does not document ${name}`).toContain(`\`${name}\``);
    }
  });

  it("explains the approvals gate from the person's side", () => {
    // The one rule that makes the gate real: the agent may not answer its own
    // request. The README has to say the command exists and who runs it.
    expect(phoneReadme).toContain("uitest-phone approvals");
    expect(phoneReadme).toMatch(/allow/i);
    expect(phoneReadme).toMatch(/deny/i);
    expect(phoneReadme).toContain("0.9.4");
  });

  it("gives the console README the takeover and the inbox", () => {
    expect(consoleReadme).toContain("uitest-console");
    expect(consoleReadme).toMatch(/Hold/);
    expect(consoleReadme).toMatch(/Resume/);
    expect(consoleReadme).toMatch(/inbox/i);
    expect(consoleReadme).toContain("127.0.0.1");
  });

  it("has a repository README that maps the packages and the commands", () => {
    // The root used to be the package. It is now the monorepo, and a visitor
    // arriving from GitHub needs to know which directory ships which npm name.
    const readme = readRoot("README.md");
    for (const name of ["packages/core", "packages/phone", "packages/console"]) {
      expect(readme, `root README does not map ${name}`).toContain(name);
    }
    for (const command of ["npm test", "node scripts/check-site.mjs", "node scripts/check-layers.mjs"]) {
      expect(readme, `root README does not document ${command}`).toContain(command);
    }
  });
});

describe("npm tarball", () => {
  it("is the core library: no bin, no MCP, no skill, no product source", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: CORE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const paths = pack!.files.map((f) => f.path);
    expect(paths).toContain("NOTICE");
    expect(paths).toContain("CHANGELOG.md");
    expect(paths).toContain("SECURITY.md");
    expect(corePackage().bin).toBeUndefined();
    for (const forbidden of [
      "dist/bin.js",
      "dist/mcp.js",
      "dist/mcp-register.js",
      "dist/cli-main.js",
      "dist/connect.js",
      "dist/install-skill.js",
      "dist/live/cli.js",
    ]) {
      expect(paths, `${forbidden} must not ship in core`).not.toContain(forbidden);
    }
    expect(paths.some((p) => p.startsWith("assets/skill"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
  }, 120_000);
});
