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

  /**
   * The spec's cases are about what a person gets, not about the arguments a
   * daemon was given. `max-size` used to check only `-scale`, and `no-control`
   * only that the key row was hidden — neither proved the picture was the
   * right size, or that an injected gesture was actually refused.
   */
  it("measures the decoded frame for max-size", () => {
    const text = source();
    expect(text).toMatch(/max-size[\s\S]{0,2500}querySelector\('canvas'\)/);
    expect(text).toContain("frameWidth");
    expect(text).toContain("withinBound");
  });

  it("proves injected input is refused for no-control", () => {
    const text = source();
    expect(text).toMatch(/no-control[\s\S]{0,3000}PointerEvent/);
    expect(text).toContain("left the display unchanged");
  });

  /**
   * The report is published. A CLI error quotes the absolute path of the lock
   * file it could not take, and the first mirror run put
   * `E:\CodeE\...\leases\` on the site.
   */
  it("scrubs this machine's absolute paths out of every case detail", () => {
    const text = source();
    expect(text).toContain("const scrub = (text: string): string =>");
    expect(text).toContain("detail: scrub(detail)");
  });
});
