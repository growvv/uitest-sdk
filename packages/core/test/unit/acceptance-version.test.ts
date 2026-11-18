import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url);
const SCRIPTS = ["acceptance-core.ts", "acceptance-phone.ts", "acceptance-console.ts"];

/**
 * An acceptance report is named after the version it proved.
 *
 * These three scripts once carried `const VERSION = "0.10.0"` literally. After
 * a version bump the runner still wrote into `docs/acceptance/<product>-0.10.0/`,
 * so a 0.10.1 run overwrote the committed 0.10.0 evidence and the page kept
 * claiming a version nobody had accepted. The version now comes from the
 * package manifest, which is the only place a release bumps.
 */
describe("acceptance runners", () => {
  it.each(SCRIPTS)("%s reads its version from package.json", (name) => {
    const text = readFileSync(new URL(`scripts/${name}`, ROOT), "utf8");
    expect(text).not.toMatch(/const VERSION = "\d+\.\d+\.\d+"/);
    expect(text).toMatch(/readFileSync\(|createRequire|package\.json/);
  });
});
