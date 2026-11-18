import { describe, expect, it } from "vitest";
import { renderReportPage, renderHubPage } from "../../../../scripts/gen-acceptance-pages.mjs";

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
});
