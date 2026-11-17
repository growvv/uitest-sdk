import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLayers } from "../../../../scripts/check-layers.mjs";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "uitest-layers-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  return root;
}

describe("checkLayers", () => {
  it("reports a core import of a product package", () => {
    const root = tree({
      "packages/core/src/bad.ts": 'import "uitest-phone";\n',
    });
    expect(checkLayers(root)).toContain("packages/core/src/bad.ts imports uitest-phone");
  });

  it("accepts a product importing a core subpath", () => {
    const root = tree({
      "packages/phone/src/good.ts":
        'import { connect } from "uitest-sdk";\n' +
        'import { COMMANDS } from "uitest-sdk/commands";\n',
    });
    expect(checkLayers(root)).toEqual([]);
  });

  it("reports one product importing another", () => {
    const root = tree({
      "packages/console/src/bad.ts": 'import { x } from "uitest-mirror";\n',
    });
    expect(checkLayers(root)).toContain("packages/console/src/bad.ts imports uitest-mirror");
  });

  it("reports a deep import into the SDK source or build output", () => {
    const root = tree({
      "packages/phone/src/bad.ts":
        'import { x } from "uitest-sdk/dist/driver/device.js";\n',
    });
    expect(checkLayers(root)).toContain(
      "packages/phone/src/bad.ts deep-imports uitest-sdk/dist/driver/device.js",
    );
  });

  it("reports product source inside the core package", () => {
    const root = tree({
      "packages/core/src/bin.ts": "export {};\n",
      "packages/core/src/mcp.ts": "export {};\n",
    });
    expect(checkLayers(root)).toEqual([
      "packages/core/src/bin.ts is product code in core",
      "packages/core/src/mcp.ts is product code in core",
    ]);
  });

  it("reports a product dependency on another product", () => {
    const root = tree({
      "packages/console/package.json": JSON.stringify({
        name: "uitest-console",
        dependencies: { "uitest-sdk": "0.10.0", "uitest-phone": "0.10.0" },
      }),
    });
    expect(checkLayers(root)).toContain("packages/console/package.json depends on uitest-phone");
  });

  it("accepts a missing packages tree, so it can run before the split", () => {
    const root = mkdtempSync(join(tmpdir(), "uitest-layers-"));
    expect(checkLayers(root)).toEqual([]);
  });
});
