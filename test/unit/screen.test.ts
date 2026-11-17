import { describe, it, expect } from "vitest";
import { ScreenBuilder, renderDiff, renderFull, findText, nodesUnder } from "../../src/agent/screen.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (attributes: Record<string, string>, children: UiNode[] = []): UiNode => ({
  attributes,
  children,
});

function exampleTree(): UiNode {
  return node({ bundleName: "com.example.app" }, [
    // Status bar: filtered.
    node({ type: "Text", text: "9:41", bounds: "[0,0][200,40]" }),
    node({ type: "Text", text: "Home", bounds: "[20,100][300,180]" }),
    // Clickable container wrapping a clickable control with the same label:
    // the inner control wins.
    node({ type: "Button", clickable: "true", bounds: "[0,200][400,300]" }, [
      node({ type: "Button", text: "Open", clickable: "true", bounds: "[20,210][200,290]" }),
    ]),
    // Unlabelled button falls back to its id.
    node({ type: "Button", clickable: "true", id: "id_history_record_go", bounds: "[0,300][400,400]" }),
    // Structural node: not rendered, children kept.
    node({ type: "Column", bounds: "[0,400][400,500]" }, [
      node({ type: "Text", text: "Visible child", bounds: "[20,420][300,480]" }),
    ]),
    // Toggle with a resource-id label.
    node({
      type: "Toggle",
      id: "Setting.Wlan.WlanConfig.WlanSwitch.result",
      bounds: "[300,500][380,560]",
      checked: "true",
    }),
    // Scrollable list.
    node({ type: "List", scrollable: "true", bounds: "[0,600][400,1100]" }, [
      node({ type: "Button", text: "Item one", clickable: "true", bounds: "[0,600][400,700]" }),
      node({ type: "Button", text: "Item two", clickable: "true", bounds: "[0,700][400,800]" }),
    ]),
    // Bottom navigation: filtered.
    node({ type: "Button", text: "Back", clickable: "true", bounds: "[0,1140][100,1200]" }),
  ]);
}

const display = { width: 400, height: 1200 };

describe("ScreenBuilder", () => {
  it("marks the system lock screen", () => {
    // The lock screen is an app like any other as far as the layout is
    // concerned; without this marker the agent would read it as a page of
    // content and try to tap things on it.
    const tree = node({ bundleName: "SCBScreenLock13", bounds: "[0,0][400,1200]" }, [
      node({ type: "Button", text: "ScreenLockWidgetView 9:41", clickable: "true", bounds: "[100,200][300,300]" }),
    ]);
    const screen = new ScreenBuilder().build(tree, { display, rotation: 0 });
    expect(screen.locked).toBe(true);
  });

  it("does not mark an ordinary app as locked", () => {
    const screen = new ScreenBuilder().build(exampleTree(), { display, rotation: 0 });
    expect(screen.locked).toBeUndefined();
  });

  it("filters bars and structural noise, keeps meaningful elements", () => {
    const screen = new ScreenBuilder().build(exampleTree(), { display, rotation: 0 });
    const labels = screen.elements.map((e) => e.label);
    expect(labels).not.toContain("9:41");
    expect(labels).not.toContain("Back");
    expect(labels).toContain("Home");
    expect(labels).toContain("Open");
    expect(labels).toContain("Visible child");
    expect(labels).toContain("history record go");
    expect(labels.some((l) => l.includes("WlanSwitch"))).toBe(true);
    expect(labels).toContain("Item one");
    expect(screen.bundle).toBe("com.example.app");
    expect(screen.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("drops a clickable ancestor that only repeats a deeper clickable label", () => {
    const screen = new ScreenBuilder().build(exampleTree(), { display, rotation: 0 });
    const open = screen.elements.filter((e) => e.label === "Open");
    expect(open).toHaveLength(1);
    expect(open[0]!.role).toBe("button");
    expect(open[0]!.rect.width).toBe(180);
  });

  it("keeps refs stable while label and place stay the same", () => {
    const builder = new ScreenBuilder();
    const first = builder.build(exampleTree(), { display, rotation: 0 });
    const home = first.elements.find((e) => e.label === "Home")!;
    const second = builder.build(exampleTree(), { display, rotation: 0 });
    expect(second.elements.find((e) => e.label === "Home")!.ref).toBe(home.ref);
  });

  it("gives a moved element a new ref", () => {
    const builder = new ScreenBuilder();
    const first = builder.build(exampleTree(), { display, rotation: 0 });
    const home = first.elements.find((e) => e.label === "Home")!;
    const moved = exampleTree();
    moved.children![1]!.attributes.bounds = "[20,120][300,200]";
    const second = builder.build(moved, { display, rotation: 0 });
    expect(second.elements.find((e) => e.label === "Home")!.ref).not.toBe(home.ref);
  });

  it("renders and diffs", () => {
    const builder = new ScreenBuilder();
    const first = builder.build(exampleTree(), { display, rotation: 0 });
    expect(renderFull(first)).toContain('[1]');

    const changed = exampleTree();
    changed.children![1]!.attributes.text = "Dashboard";
    const second = builder.build(changed, { display, rotation: 0 });
    const diff = renderDiff(first, second);
    expect(diff.mode).toBe("diff");
    expect(diff.text).toContain('+ ');
    expect(diff.text).toContain("Dashboard");
    expect(diff.text).toContain("- ");
  });

  it("finds text and nodes under a point", () => {
    const screen = new ScreenBuilder().build(exampleTree(), { display, rotation: 0 });
    expect(findText(screen, "item two")?.label).toBe("Item two");
    expect(nodesUnder(screen, 200, 650).map((e) => e.label)).toContain("Item one");
  });

  it("keeps credential values when redaction is turned off", () => {
    // The live inspector's privacy switch is a person's decision about their
    // own phone. With it off the screen model must carry the raw labels, and
    // nothing may still be flagged `masked` — a stale flag would grey out
    // pixels the person explicitly asked to see.
    const tree = node({ bundleName: "com.example.app" }, [
      node({ type: "Text", text: "Your code is 482913", bounds: "[0,100][400,160]" }),
      node({ type: "TextInput", text: "hunter2", password: "true", bounds: "[0,200][400,260]" }),
    ]);
    const screen = new ScreenBuilder(null, { redact: false }).build(tree, { display, rotation: 0 });
    const text = renderFull(screen);
    expect(text).toContain("482913");
    expect(text).toContain("hunter2");
    expect(screen.elements.every((e) => e.masked !== true)).toBe(true);
    expect(findText(screen, "482913")).not.toBeNull();
  });

  it("switches redaction on a live builder without renumbering refs", () => {
    // The live inspector's privacy switch flips while the page is open. Refs
    // are how a person points at a node and then acts on it, so a toggle must
    // not renumber the table under them.
    const tree = node({ bundleName: "com.example.app" }, [
      node({ type: "Text", text: "Home", bounds: "[20,100][300,180]" }),
      node({ type: "TextInput", text: "hunter2", password: "true", bounds: "[0,200][400,260]" }),
    ]);
    const builder = new ScreenBuilder(null, { redact: false });
    const open = builder.build(tree, { display, rotation: 0 });
    const openInput = open.elements.find((e) => e.role === "input")!;
    expect(openInput.label).toBe("hunter2");

    builder.setRedact(true);
    const masked = builder.build(tree, { display, rotation: 0 });
    const maskedInput = masked.elements.find((e) => e.role === "input")!;
    expect(maskedInput.label).toBe("••••••");
    expect(maskedInput.masked).toBe(true);
    expect(maskedInput.ref).toBe(openInput.ref);
    expect(masked.elements.find((e) => e.label === "Home")!.ref).toBe(
      open.elements.find((e) => e.label === "Home")!.ref,
    );
  });

  it("masks one-time codes and password values in the rendered screen", () => {
    const tree = node({ bundleName: "com.example.app" }, [
      node({ type: "Text", text: "Your code is 482913", bounds: "[0,100][400,160]" }),
      node({ type: "TextInput", text: "hunter2", password: "true", bounds: "[0,200][400,260]" }),
      // A credential-worded control keeps its words: the policy still has to
      // classify it, and the word itself is not the secret.
      node({ type: "Button", text: "发送验证码", clickable: "true", bounds: "[0,300][400,360]" }),
    ]);
    const screen = new ScreenBuilder().build(tree, { display, rotation: 0 });
    const text = renderFull(screen);
    expect(text).not.toContain("482913");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("Your code is ••••••");
    expect(text).toContain("发送验证码");
    expect(screen.elements.find((e) => e.label.startsWith("Your code"))?.masked).toBe(true);
    expect(screen.elements.find((e) => e.label === "发送验证码")?.masked).toBeUndefined();
    // A masked label cannot be used as a text target: `tap --text 482913` must
    // not find the code it is not allowed to read.
    expect(findText(screen, "482913")).toBeNull();
  });

  it("masks a bare code under a credential-labelled container", () => {
    const tree = node({ bundleName: "com.example.app" }, [
      node({ type: "Column", text: "Your verification code", bounds: "[0,100][400,400]" }, [
        node({ type: "Text", text: "482913", bounds: "[0,200][400,260]" }),
      ]),
    ]);
    const screen = new ScreenBuilder().build(tree, { display, rotation: 0 });
    expect(renderFull(screen)).not.toContain("482913");
    expect(renderFull(screen)).toContain("••••••");
  });
});
