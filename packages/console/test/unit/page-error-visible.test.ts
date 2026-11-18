import { describe, expect, it } from "vitest";
import { CONSOLE_HTML, CONSOLE_SCRIPT } from "../../src/page.js";

/**
 * A message the person needs to read, in a page that redraws itself.
 *
 * The inbox re-renders on every poll — twice a second — and the server sends
 * the fresh list right after it sends an error. An error written into
 * `#approvals-list` is therefore erased within the same tick it arrives, and a
 * person who clicks Deny on an id an agent already allowed sees the row simply
 * come back: the silent refresh the conflict message was added to end.
 */
describe("console page: an error the person has to read", () => {
  it("writes errors somewhere the approvals list does not overwrite", () => {
    // The error handler must not target the list that `renderApprovals`
    // replaces wholesale.
    const handler = CONSOLE_SCRIPT.slice(
      CONSOLE_SCRIPT.indexOf("viewer.on('console:error'"),
      CONSOLE_SCRIPT.indexOf("viewer.on('console:error'") + 400,
    );
    expect(handler).not.toMatch(/approvalsEl\.innerHTML/);
    expect(handler).not.toMatch(/approvalsEl\.insertAdjacentHTML/);
  });

  it("has a dedicated element for it, outside the approvals list", () => {
    expect(CONSOLE_HTML).toMatch(/id="console-error"/);
    // `renderApprovals` replaces the contents of `#approvals-list`, so the
    // error has to be a sibling of it, not a child.
    const errorAt = CONSOLE_HTML.indexOf('id="console-error"');
    const listAt = CONSOLE_HTML.indexOf('id="approvals-list"');
    expect(errorAt).toBeGreaterThan(-1);
    expect(errorAt).toBeLessThan(listAt);
  });

  it("clears the notice when the person tries again", () => {
    // Otherwise the old reason sits there through the next decision and reads
    // as the answer to it.
    const click = CONSOLE_SCRIPT.slice(CONSOLE_SCRIPT.indexOf("approvalsEl.addEventListener"));
    expect(click).toMatch(/clearError\(\);/);
  });
});
