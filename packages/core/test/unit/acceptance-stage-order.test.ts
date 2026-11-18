import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../../../scripts/acceptance-console.ts", import.meta.url);

/**
 * Staging must not disturb a surface that is already right.
 *
 * `stage` runs before every console capture, and its job is to leave the
 * calculator's history list in front. It launched the calculator first and only
 * then looked at the screen — so on a phone that was already showing the list it
 * restarted the app anyway. That is a visible surface change immediately before
 * a screenshot whose predicate is "a live frame is on the canvas", and on the
 * 0.1.1 run the mirror was still `STARTING` when the capture timed out.
 *
 * Looking before launching is both cheaper and the thing the function means:
 * the list is already there, so there is nothing to stage.
 */
describe("console acceptance: staging", () => {
  const source = readFileSync(SRC, "utf8");
  const stage = source.slice(source.indexOf("async function stage("), source.indexOf("async function recheckSurface"));

  it("looks at the screen before launching anything", () => {
    const firstLayout = stage.indexOf("observe.layout()");
    const firstLaunch = stage.indexOf("apps.launch");
    expect(firstLayout).toBeGreaterThan(-1);
    expect(firstLaunch).toBeGreaterThan(-1);
    expect(firstLayout).toBeLessThan(firstLaunch);
  });

  it("leaves immediately when the list is already in front", () => {
    // The early return has to come before the launch loop, or "already
    // staged" still costs a restart.
    const launchAt = stage.indexOf("apps.launch");
    const earlyReturn = stage.indexOf("if (onListWithRows((await session.observe.layout()).elements)) return;");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(launchAt);
  });
});
