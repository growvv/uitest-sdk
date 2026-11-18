import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = new URL("../../../../scripts/acceptance-phone.ts", import.meta.url);

/**
 * The MCP case must let the child close its own session.
 *
 * `uitest-phone mcp` holds the device lease for the life of the process and
 * releases it in `session.close()`. Killing the child straight after
 * `stdin.end()` skips that: the lock file stays behind, and every later case in
 * the run — and every run after it — gets `lease_held`. That is exactly what
 * happened: a killed MCP case wedged the phone for hours, its pid reused by an
 * unrelated console so the liveness check never freed it.
 *
 * So the case ends stdin, waits for the process to exit on its own, and only
 * kills it when it does not.
 */
describe("phone acceptance: the MCP case ends cleanly", () => {
  const source = readFileSync(SRC, "utf8");
  const mcp = source.slice(source.indexOf("async function mcpCase"), source.indexOf("/** Installs the skill"));

  it("waits for the child to exit after stdin closes", () => {
    const endAt = mcp.indexOf("child.stdin.end()");
    // The wait is what gives `session.close()` its chance to release the lease.
    const waitAt = mcp.search(/child\.once\("exit"/);
    expect(endAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(endAt);
  });

  it("kills only after that wait, as the fallback", () => {
    const waitAt = mcp.search(/child\.once\("exit"/);
    const killAt = mcp.lastIndexOf("child.kill()");
    expect(waitAt).toBeGreaterThan(-1);
    expect(killAt).toBeGreaterThan(waitAt);
  });
});

/**
 * A setup helper that cannot get its surface in front must say why.
 *
 * `ensureKeypad` used to throw "the calculator keypad never came to the front"
 * no matter what the commands returned, so a run whose every call failed with
 * `lease_held` was reported as a calculator problem and sent the reader to the
 * wrong place. The CLI's own message is the evidence; keep it in the throw.
 */
describe("phone acceptance: keypad staging reports the real failure", () => {
  const source = readFileSync(SRC, "utf8");
  const keypad = source.slice(
    source.indexOf("async function ensureKeypad"),
    source.indexOf("async function ensureHistory"),
  );

  it("carries the last command's own error text into the thrown message", () => {
    // Not just "the keypad is missing": the CLI already said why (lease_held,
    // no device, a daemon that would not start), and that sentence is what
    // tells the next reader where to look.
    const throwAt = keypad.indexOf("throw new Error(");
    expect(throwAt).toBeGreaterThan(-1);
    expect(keypad.slice(throwAt)).toMatch(/last|probe\.text/);
  });
});
