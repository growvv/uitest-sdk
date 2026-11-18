import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = new URL("../../../../scripts/screenshot.mjs", import.meta.url);

/**
 * A capture that times out is the case that most needs a picture.
 *
 * The predicate is the assertion ("a frame is on the canvas"), so when it never
 * comes true the useful evidence is what the page did show: a black canvas, a
 * "reconnecting" overlay, an error banner. The helper used to throw with the
 * expression and take nothing, which turned every such failure into a sentence
 * an operator could not act on — the console's 0.1.1 run reported three
 * "page never satisfied" failures that took a separate probe to explain.
 */
describe("capturePage on a timeout", () => {
  const source = readFileSync(SRC, "utf8");
  // Everything from the readiness check to the end of the function: the timeout
  // path and the success path are both in here, and their order is the claim.
  const fromCheck = source.slice(source.lastIndexOf("if (!ready)"));
  const beforeThrow = fromCheck.slice(0, fromCheck.indexOf("throw new Error(`page never satisfied"));

  it("saves the page before reporting that the predicate never held", () => {
    expect(fromCheck).toContain("page never satisfied");
    expect(beforeThrow).toMatch(/captureScreenshot/);
  });

  it("names the file it saved, so a report can point at it", () => {
    expect(beforeThrow).toMatch(/timeout\.jpg|screenshot/);
    // The message has to carry the name, or the picture is unreachable from
    // the report that quotes the message.
    expect(fromCheck.slice(fromCheck.indexOf("page never satisfied"))).toMatch(/what the page showed/);
  });
});
