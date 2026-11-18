import { describe, expect, it } from "vitest";
import {
  renderReportPage,
  renderHubPage,
  unacceptedVersions,
  misplacedReports,
} from "../../../../scripts/gen-acceptance-pages.mjs";

const fixture = {
  product: "core" as const,
  version: "0.10.0",
  date: "2026-11-18",
  commit: "abc1234",
  devices: [{ tag: "7544d645", model: "tablet", resolution: "1600x2560" }],
  cases: [
    {
      id: "c1",
      title: "connect",
      status: "pass" as const,
      detail: "ok",
      screenshots: ["connect-7544d645.jpg"],
    },
    // The generator refuses a page with fewer than two pictures, so the
    // fixture carries the minimum a real report has.
    {
      id: "c2",
      title: "layout",
      status: "pass" as const,
      detail: "ok",
      screenshots: ["layout-7544d645.jpg"],
    },
  ],
  summary: { passed: 2, failed: 0, skipped: 0 },
  rerun: ["npx tsx scripts/acceptance-core.ts"],
  issues: [],
};

describe("acceptance page generator", () => {
  it("fails when a case has no screenshot", () => {
    expect(() =>
      renderReportPage({ ...fixture, cases: [{ ...fixture.cases[0]!, screenshots: [] }] }),
    ).toThrow(/screenshot/);
  });

  it("escapes product text in the page", () => {
    // Replaces one case rather than the list: the generator needs its two
    // pictures, and escaping is about the text, not the count.
    const html = renderReportPage({
      ...fixture,
      cases: [{ ...fixture.cases[0]!, title: "<script>x</script>" }, fixture.cases[1]!],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  it("names the product, version and every case status", () => {
    const html = renderReportPage(fixture);
    expect(html).toContain("uitest-sdk");
    expect(html).toContain("0.10.0");
    expect(html).toContain("pass");
    expect(html).toContain("abc1234");
    expect(html).toContain('href="acceptance.html"');
  });

  it("refuses a report that claims a pass with no evidence", () => {
    expect(() => renderReportPage({ ...fixture, cases: [] })).toThrow(/case/);
  });

  it("lists every report and the legacy page in the hub", () => {
    const html = renderHubPage([
      { product: "core", version: "0.10.0", href: "acceptance-core-0.10.0.html", summary: { passed: 3, failed: 0, skipped: 0 }, date: "2026-11-18" },
      { product: "phone", version: "0.10.0", href: "acceptance-phone-0.10.0.html", summary: { passed: 21, failed: 0, skipped: 0 }, date: "2026-11-18" },
    ]);
    expect(html).toContain("acceptance-core-0.10.0.html");
    expect(html).toContain("acceptance-phone-0.10.0.html");
    expect(html).toContain("acceptance-0.9.4.html");
    expect(html).toContain("21/21");
  });

  // The site's behaviour lives in main.js, and check-site proves it ran by
  // looking for the `js-ready` class it sets on <html>. A generated page that
  // omits the script tag is a page whose nav and copy button never run — and
  // the site check fails on it, so the generator owes the tag on every page.
  it("loads the site script on every page it writes", () => {
    expect(renderReportPage(fixture)).toContain('<script src="main.js" defer></script>');
    expect(renderHubPage([])).toContain('<script src="main.js" defer></script>');
  });

  it("writes rerun commands without nesting code elements", () => {
    const html = renderReportPage(fixture);
    expect(html).not.toContain("<code><code>");
  });

  /**
   * A product at a version nobody accepted is a release failure.
   *
   * `main()` printed a `note:` for it and still exited 0. Its own header says
   * a missing report fails the site check, and `check-site.mjs` does — but a
   * person running the generator directly, which every acceptance script's
   * rerun list tells them to do, was told the run succeeded.
   */
  it("names every product whose current version has no report", () => {
    const missing = unacceptedVersions(
      { core: "0.11.0", phone: "0.10.2", console: "0.1.2", mirror: "0.1.0" },
      [{ product: "core", version: "0.11.0" }, { product: "phone", version: "0.10.2" }],
    );
    expect(missing).toEqual([
      { product: "console", version: "0.1.2" },
      { product: "mirror", version: "0.1.0" },
    ]);
  });

  it("names none when every current version has a report", () => {
    expect(
      unacceptedVersions(
        { core: "0.11.0" },
        [{ product: "core", version: "0.11.0" }, { product: "core", version: "0.10.0" }],
      ),
    ).toEqual([]);
  });

  /**
   * Historic reports are the record, not an error.
   *
   * The generator compared *every* report's version with today's
   * `package.json`, so once a product moved on, every earlier report counted as
   * a failure and the script exited 1 on a perfectly healthy tree. That made
   * the exit code useless — including the missing-report check, which is the
   * one that matters. The invariant is that a report matches its own directory
   * (`core-0.10.0` holds a 0.10.0 report); comparing with today's version is
   * `check-site.mjs`'s job, and only for the current version.
   */
  it("flags a report whose version does not match its own directory", () => {
    expect(
      misplacedReports([
        { dir: "core-0.11.0", product: "core", version: "0.10.0" },
        { dir: "phone-0.10.2", product: "phone", version: "0.10.2" },
      ]),
    ).toEqual([{ dir: "core-0.11.0", expected: "core-0.10.0" }]);
  });

  it("does not flag a report merely because the package has moved on", () => {
    expect(
      misplacedReports([{ dir: "core-0.10.0", product: "core", version: "0.10.0" }]),
    ).toEqual([]);
  });
});
