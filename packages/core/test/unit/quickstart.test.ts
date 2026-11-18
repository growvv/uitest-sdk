import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = new URL("../../examples/quickstart.mjs", import.meta.url);

/**
 * The quickstart is the first thing a person runs, and a ✓ is a claim.
 *
 * `act.tap` returns a status rather than throwing: `settled` means the step
 * happened, and `not_found` means nothing on screen matched. The script printed
 * a ✓ either way, so a reader whose phone was on the launcher — no calculator,
 * no keypad, nothing labelled "7" — was told the tap worked and would go on to
 * build on a step that never ran.
 */
describe("quickstart", () => {
  const source = readFileSync(SRC, "utf8");

  it("checks the status before claiming the tap worked", () => {
    // The tap's result has to be read, and the ✓ has to depend on it.
    expect(source).toMatch(/const\s+\w*[Tt]ap\w*\s*=\s*await session\.act\.tap/);
    expect(source).toMatch(/tap\w*\.status/);
  });

  it("checks the screenshot's status too", () => {
    // A locked phone writes no file; `screenshot()` returns a path anyway.
    expect(source).toMatch(/shot\.result\.status|\.result\s*&&/);
  });

  it("says what to do when the target is not there, instead of failing silently", () => {
    // A person who ran this against the wrong screen needs one sentence, not
    // a stack trace and not a green check.
    expect(source).toMatch(/not_found|launch|calculator/i);
  });
});
