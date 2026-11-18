import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = new URL("../../../../scripts/screenshot.mjs", import.meta.url);

/**
 * A capture that times out is the case that most needs a picture.
 *
 * The predicate is the assertion ("a frame is on the canvas"), so when it never
 * comes true the useful evidence is what the page did show: a black canvas, a
 * "reconnecting" overlay, an error banner.
 *
 * It must not be published. The acceptance runner writes its pictures into
 * `docs/acceptance/<product>-<version>/screenshots/`, which is committed and on
 * the website, and every other capture there goes through the lock-screen and
 * notification-shade guards first. A timeout shot is taken with no guard
 * because the page it needs to show is exactly the one that failed — and on the
 * console's 0.1.1 run the phone had locked itself, so the first version of this
 * feature wrote a lock screen into the published directory. It belongs in the
 * git-ignored scratch directory, named in the message so it can still be read.
 */
describe("capturePage on a timeout", () => {
  const source = readFileSync(SRC, "utf8");
  const fromCheck = source.slice(source.lastIndexOf("if (!ready)"));
  const beforeThrow = fromCheck.slice(0, fromCheck.indexOf("throw new Error(`page never satisfied"));

  it("saves the page before reporting that the predicate never held", () => {
    expect(fromCheck).toContain("page never satisfied");
    expect(beforeThrow).toMatch(/captureScreenshot/);
  });

  it("names the file it saved, so a report can point at it", () => {
    expect(fromCheck.slice(fromCheck.indexOf("page never satisfied"))).toMatch(/what the page showed/);
  });

  it("writes it outside the directory the report publishes", () => {
    // `.work-bench` is git-ignored; the published directory is not. The failure
    // shot is taken with no lock-screen guard, so it cannot go where the
    // guarded ones go.
    expect(beforeThrow).toMatch(/\.work-bench/);
    expect(beforeThrow).not.toMatch(/target\.replace\(/);
  });
});
