import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UitestError } from "../../src/transport/errors.js";

/**
 * A failed decision write is not a race.
 *
 * `decide()` writes the person's answer with `wx` and used to treat *every*
 * failure as "somebody else answered first". A read-only directory, a full
 * disk or a permission error was then reported as `denied: already decided`:
 * the person believed their Allow or Deny was recorded, no file was written,
 * and the agent waited out the TTL. Only `EEXIST` means a concurrent writer.
 *
 * `writeFileSync` is made to fail with EACCES here because the real failure is
 * not reproducible portably (chmod does not deny the owner on Windows). The
 * file genuinely does not exist, so `existsSync` still answers honestly and
 * the code reaches the write.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: unknown, data: unknown, opts?: unknown) => {
      if (typeof path === "string" && path.endsWith(".allow")) {
        const err = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (actual.writeFileSync as (...a: unknown[]) => void)(path, data, opts);
    },
  };
});

const { Approvals } = await import("../../src/governance/approvals.js");

const step = { command: "tap", args: { text: "删除" }, signature: "sig-1" };

describe("approval decisions: I/O failures", () => {
  it("surfaces a non-EEXIST write failure instead of reporting a decision that was never written", () => {
    const a = new Approvals({ dir: mkdtempSync(join(tmpdir(), "uitest-appr-io-")) });
    const pending = a.request(step, "deletes", { bundle: "com.demo", task: "t" });

    let thrown: unknown;
    try {
      a.decide(pending.id, "allow", { by: "cli" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UitestError);
    expect((thrown as UitestError).code).toBe("EAPPROVALWRITE");
    // Nothing was recorded: the approval is still waiting, and the person can
    // be told to fix the state directory rather than told they decided.
    expect(a.status(pending.id)?.status).toBe("pending");
  });
});
