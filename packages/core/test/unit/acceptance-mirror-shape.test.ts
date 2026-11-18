import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The mirror report comes from `scripts/acceptance-mirror.ts`. Its value is the
// same as the console's: pictures of the real window, plus the device's own
// screen for the cases where a gesture should have changed it.
const SRC = new URL("../../../../scripts/acceptance-mirror.ts", import.meta.url);

function source(): string {
  return readFileSync(SRC, "utf8");
}

describe("mirror acceptance runner", () => {
  it("declares every case the plan names", () => {
    const text = source();
    for (const id of [
      "window",
      "click",
      "keyboard",
      "scroll",
      "keys",
      "record",
      "max-size",
      "no-control",
      "lease",
    ]) {
      expect(text, id).toContain(`"${id}"`);
    }
  });

  // The three products are accepted one after another in one sitting, so a run
  // that excluded only its own directory would stamp the next report `+dirty`.
  it("excludes the whole evidence tree from the commit stamp", () => {
    expect(source()).toContain("gitHead({ exclude: [relative(ROOT, EVIDENCE)] })");
  });

  // A device serial in a report is published to the site. The tag is the only
  // identifier that may appear.
  it("names devices only by tag", () => {
    expect(source()).toContain("tagOf(");
    expect(source()).not.toMatch(/docs\/acceptance\/mirror-[^"]*\/[^"]*serial/);
  });

  it("writes into the mirror's own evidence directory", () => {
    expect(source()).toContain('const PRODUCT = "mirror"');
    expect(source()).toContain("`${PRODUCT}-${VERSION}`");
  });
});
