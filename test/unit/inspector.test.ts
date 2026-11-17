import { describe, it, expect } from "vitest";
import jpeg from "jpeg-js";
import { ScreenBuilder } from "../../src/agent/screen.js";
import { Screenshot } from "../../src/agent/shot.js";
import { ROLE_COLORS, inspectScreen, renderPanel } from "../../src/agent/inspector.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (attributes: Record<string, string>, children: UiNode[] = []): UiNode => ({
  attributes,
  children,
});

const display = { width: 400, height: 1200 };

/** 200x600 frame for a 400x1200 display: the device's usual factor of 0.5. */
const solidJpeg = () =>
  jpeg.encode({ data: Buffer.alloc(200 * 600 * 4, 0x30), width: 200, height: 600 }, 80).data;

function exampleTree(): UiNode {
  return node({ bundleName: "com.example.app", bounds: "[0,0][400,1200]" }, [
    node({ type: "Button", text: "Save", clickable: "true", bounds: "[50,300][350,400]" }),
    node({ type: "TextInput", text: "hunter2", password: "true", bounds: "[0,200][400,260]" }),
    node({ type: "Text", text: "Order total 42", bounds: "[0,500][400,560]" }),
  ]);
}

async function setup(tree: UiNode = exampleTree()) {
  const screen = new ScreenBuilder().build(tree, { display, rotation: 0 });
  const shot = await Screenshot.from(solidJpeg(), { display, rotation: 0 });
  return { screen, inspection: inspectScreen(screen, shot) };
}

const decode = (buf: Buffer) => jpeg.decode(buf, { useTArray: true });
const px = (decoded: ReturnType<typeof decode>, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4;
  return [decoded.data[i]!, decoded.data[i + 1]!, decoded.data[i + 2]!];
};

describe("inspectScreen", () => {
  it("numbers every element from 1 and carries its ref through", async () => {
    const { screen, inspection } = await setup();
    expect(inspection.nodes).toHaveLength(screen.elements.length);
    expect(inspection.nodes.map((n) => n.index)).toEqual(screen.elements.map((_, i) => i + 1));
    expect(inspection.nodes.map((n) => n.ref)).toEqual(screen.elements.map((e) => e.ref));
    const save = inspection.nodes.find((n) => n.label === "Save")!;
    expect(save.role).toBe("button");
    expect(save.rect).toEqual({ x: 50, y: 300, width: 300, height: 100 });
    expect(save.center).toEqual({ x: 200, y: 350 });
  });

  it("redacts a masked element in the pixels, then boxes it", async () => {
    const { inspection } = await setup();
    const masked = inspection.nodes.find((n) => n.masked);
    expect(masked).toBeDefined();
    const decoded = decode(inspection.annotated.data);
    // Display (200,230) → frame (100,115): the middle of the password field.
    for (const channel of px(decoded, 200, 100, 115)) {
      expect(channel).toBeGreaterThan(110);
      expect(channel).toBeLessThan(150);
    }
  });

  it("keeps a redacted but unmarked frame for the HTML panel", async () => {
    const { inspection } = await setup();
    const decoded = decode(inspection.plain.data);
    // The Save box's top-left is display (50,300) → frame (25,150). The plain
    // frame has no border there; the annotated one does.
    expect(px(decoded, 200, 25, 150)[0]).toBeLessThan(120);
    const marked = decode(inspection.annotated.data);
    expect(px(marked, 200, 25, 150)[1]).toBeGreaterThan(120);
  });

  it("uses a stable colour per role", async () => {
    const { inspection } = await setup();
    expect(ROLE_COLORS.text).toBeDefined();
    expect(ROLE_COLORS.button).toBeDefined();
    expect(ROLE_COLORS.button).not.toEqual(ROLE_COLORS.text);
    expect(inspection.nodes.find((n) => n.label === "Save")!.role).toBe("button");
  });
});

describe("renderPanel", () => {
  it("writes a self-contained panel with one row per node", async () => {
    const { screen, inspection } = await setup();
    const html = renderPanel(screen, inspection);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("data:image/jpeg;base64,");
    // Header row plus one per node.
    expect((html.match(/<tr/g) ?? []).length).toBe(inspection.nodes.length + 1);
    expect(html).toContain('data-index="1"');
    expect(html).toContain("com.example.app");
  });

  it("escapes labels so a screen cannot inject markup", async () => {
    const tree = node({ bundleName: "com.example.app" }, [
      node({ type: "Button", text: '<img src=x onerror="alert(1)">', clickable: "true", bounds: "[100,400][300,500]" }),
    ]);
    const { screen, inspection } = await setup(tree);
    const html = renderPanel(screen, inspection);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img");
  });

  it("marks masked rows in the panel without printing the value", async () => {
    const { screen, inspection } = await setup();
    const html = renderPanel(screen, inspection);
    expect(html).toContain("masked");
    expect(html).not.toContain("hunter2");
  });
});
