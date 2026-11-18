import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The API page is generated, and a generated sample can still be wrong.
 *
 * `gen-api-page.mjs` builds the page from one import block and many small
 * sample blocks. When `Gesture` moved out of the root import, the samples kept
 * using `new Gesture()` and nothing put it back — the page shipped code that
 * fails to compile with "Cannot find name 'Gesture'". The doc-import test only
 * scans markdown files, so the site's HTML was never checked.
 */
describe("the generated API page", () => {
  const html = readFileSync(new URL("../../../../site/api.html", import.meta.url), "utf8");

  it("imports every capitalized name its samples construct", () => {
    // The page's imports are the first `<pre>`; every later block assumes them.
    const firstPre = html.slice(html.indexOf("<pre><code>"), html.indexOf("</code></pre>"));
    const imported = new Set<string>();
    for (const m of firstPre.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
      for (const name of m[1]!.split(",")) imported.add(name.trim());
    }
    expect(imported.has("Device")).toBe(true);

    // Names the page constructs with `new X(`. Everything else on the page is
    // either imported or a local the sample declares.
    const used = new Set<string>();
    for (const m of html.matchAll(/new\s+([A-Z][\w$]*)\s*\(/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(0);

    const missing = [...used].filter((n) => !imported.has(n));
    expect(missing, `constructed but never imported: ${missing.join(", ")}`).toEqual([]);
  });
});
