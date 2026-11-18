import { describe, expect, it } from "vitest";
import { CONSOLE_HTML, CONSOLE_SCRIPT, renderApprovalRow, renderActivityRow } from "../../src/page.js";

describe("console page", () => {
  it("renders approval fields as text, never HTML", () => {
    // A bundle name or a rule is device-side data: an app can label a window
    // with markup, and the inbox must show it, not run it.
    const rendered = renderApprovalRow({
      id: "a1b2c3d4",
      tag: "7544d645",
      command: "tap",
      bundle: "<img src=x onerror=alert(1)>",
      rule: "deletes",
      task: "checkout",
      status: "pending",
      expiresInMs: 60_000,
    });

    expect(rendered).not.toContain("<img");
    expect(rendered).toContain("&lt;img");
    expect(rendered).toContain("deletes");
  });

  it("names the step a person is being asked about", () => {
    const rendered = renderApprovalRow({
      id: "a1b2c3d4",
      tag: "6c585f5b",
      command: "tap",
      bundle: "com.bank.app",
      rule: "payments",
      status: "pending",
      expiresInMs: 42_000,
    });

    expect(rendered).toContain("a1b2c3d4");
    expect(rendered).toContain("com.bank.app");
    expect(rendered).toContain("payments");
    expect(rendered).toContain("42s");
  });

  it("escapes activity text the same way", () => {
    const rendered = renderActivityRow({
      at: "2026-11-18T06:00:00.000Z",
      step: 3,
      command: "tap",
      status: "settled",
      text: '<script>alert(1)</script>',
    });

    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("tap");
  });

  it("offers the inbox, takeover and activity panels", () => {
    for (const id of ["inbox", "hold", "activity", "approvals-list", "activity-list"]) {
      expect(CONSOLE_HTML).toContain(`id="${id}"`);
    }
  });

  it("talks to the page through the viewer bridge, never the socket directly", () => {
    expect(CONSOLE_SCRIPT).toContain("window.uitestViewer");
    expect(CONSOLE_SCRIPT).toContain("console:approvals:list");
    expect(CONSOLE_SCRIPT).toContain("console:approvals:decide");
    expect(CONSOLE_SCRIPT).toContain("console:hold");
    expect(CONSOLE_SCRIPT).toContain("console:resume");
    expect(CONSOLE_SCRIPT).toContain("console:activity");
  });

  it("builds every row with textContent or escaping, never raw innerHTML", () => {
    // The script renders server data. `innerHTML` with a template is the one
    // line that turns a phone's screen into script in this page.
    expect(CONSOLE_SCRIPT).not.toMatch(/innerHTML\s*=\s*[^'"`]*`/);
    expect(CONSOLE_SCRIPT).toContain("textContent");
  });

  it("shows an answered approval as answered, not as still waiting", () => {
    // After Allow, the row stayed exactly as it was: Allow/Deny buttons, and a
    // countdown to an expiry that no longer applies. A person reading the page
    // could not tell their answer had landed.
    const allowed = renderApprovalRow({
      id: "a1b2c3d4",
      tag: "7544d645",
      command: "tap",
      bundle: "com.demo",
      rule: "deletes",
      status: "allowed",
      expiresInMs: 42_000,
    });
    expect(allowed).toContain("allowed");
    expect(allowed).not.toContain("data-allow");
    expect(allowed).not.toContain("expires in");

    const denied = renderApprovalRow({
      id: "a1b2c3d4",
      tag: "7544d645",
      command: "tap",
      status: "denied",
      expiresInMs: 42_000,
    });
    expect(denied).toContain("denied");
    expect(denied).not.toContain("data-deny");
  });

  it("lays its rows out as blocks, not as the viewer's flex rows", () => {
    // The viewer defines a global `.row { display: flex }` for its node table.
    // The console's rows are three stacked divs (head, meta, actions); under
    // flex they sit side by side and the meta text is squeezed to one
    // character — which is exactly what an acceptance screenshot showed.
    expect(CONSOLE_HTML).toMatch(/#console-panel \.row\s*\{[^}]*display:\s*block/);
  });

  it("polls the inbox while idle", () => {
    expect(CONSOLE_SCRIPT).toContain("setInterval");
    expect(CONSOLE_SCRIPT).toMatch(/2000|2_000/);
  });
});
