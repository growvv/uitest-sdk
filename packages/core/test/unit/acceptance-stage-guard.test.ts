import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = new URL("../../../../scripts/acceptance-phone.ts", import.meta.url);

/**
 * A guard that refuses to photograph the phone must not also leave it held.
 *
 * `stageCalculator` opens a session (which starts the device daemon and an
 * `hdc fport`), then runs the lock-screen and notification-shade guards. Both
 * are designed to throw: a PIN-locked phone, a shade that will not close. When
 * one fires, the session has to be closed — otherwise the daemon and the port
 * forward stay on the device and the whole run aborts before a report exists,
 * which is the worst of both: no evidence and a phone still in use.
 */
describe("phone acceptance: staging guards", () => {
  const source = readFileSync(SRC, "utf8");
  const stage = source.slice(
    source.indexOf("async function stageCalculator"),
    source.indexOf("/** Each of the 21 commands"),
  );

  it("closes the session when a guard refuses the phone", () => {
    // The guards run before the returned `restore`, so the function itself has
    // to own the failure path.
    const guardAt = stage.indexOf("assertCapturable");
    const tryAt = stage.indexOf("try {");
    expect(guardAt).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(guardAt);
  });

  it("closes the session on the failure path and rethrows", () => {
    // Not a `finally`: the success path hands back `restore`, which closes the
    // session when the run is done. Closing on the way out would kill the
    // session the cases are about to use.
    const catchAt = stage.indexOf("} catch (e) {");
    expect(catchAt).toBeGreaterThan(-1);
    const tail = stage.slice(catchAt);
    expect(tail).toMatch(/session\.close\(\)/);
    expect(tail).toMatch(/throw e;/);
  });
});
