import { createHash } from "node:crypto";
import type { Rect, UiNode } from "../model.js";
import type { FileRefStore, RefTable } from "../refs.js";

/** Upper bound on remembered signatures; the current screen is never evicted. */
const MAX_REFS = 4000;

export type ElementRole =
  | "text"
  | "button"
  | "input"
  | "list"
  | "toggle"
  | "checkbox"
  | "radio"
  | "slider"
  | "tabs"
  | "nav"
  | (string & {});

export interface ScreenElement {
  /** Session-scoped handle. Stable while role, label, place, description and hint hold. */
  ref: number;
  role: ElementRole;
  label: string;
  rect: Rect;
  /** centerX,centerY — what a coordinate action should aim at. */
  center: { x: number; y: number };
  state: string[];
  clickable: boolean;
  input: boolean;
  scrollable: boolean;
  focused: boolean;
  /** Internal identity, also used for approval binding. */
  signature: string;
  node: UiNode;
}

export interface Screen {
  header: string;
  bundle: string;
  display: { width: number; height: number };
  rotation: number;
  elements: ScreenElement[];
  lines: string[];
  /** Content hash over header + rendered lines. */
  hash: string;
  /** Signatures present on this screen; the builder drops stale refs with them. */
  signatures: Set<string>;
  /** The raw tree, for callers that need attributes the screen model hides. */
  tree: UiNode;
  at: number;
}

export interface ScreenContext {
  display: { width: number; height: number };
  rotation: number;
}

export interface Diff {
  mode: "full" | "diff";
  text: string;
  added: ScreenElement[];
  removed: ScreenElement[];
  changed: ScreenElement[];
}

const ROLE = new Map<string, ElementRole>([
  ["Text", "text"],
  ["Button", "button"],
  ["TextInput", "input"],
  ["TextField", "input"],
  ["Search", "input"],
  ["SearchField", "input"],
  ["RichEditor", "input"],
  ["List", "list"],
  ["Grid", "list"],
  ["Scroll", "list"],
  ["Swiper", "list"],
  ["Toggle", "toggle"],
  ["Switch", "toggle"],
  ["Checkbox", "checkbox"],
  ["Radio", "radio"],
  ["Slider", "slider"],
  ["TabBar", "tabs"],
  ["NavigationBar", "nav"],
]);

const STRUCTURAL = new Set([
  "windowscene",
  "stack",
  "root",
  "column",
  "row",
  "relativecontainer",
  "uiextensioncomponent",
  "component",
  "container",
  "flex",
  "gridrow",
  "gridcol",
  "scroll",
  "swiper",
  "sidebar",
  "navigation",
  "page",
  "stage",
]);

export function parseBounds(raw: string | undefined): Rect | null {
  if (!raw) return null;
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(raw).trim());
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x: x1!, y: y1!, width: Math.max(0, x2! - x1!), height: Math.max(0, y2! - y1!) };
}

function attr(node: UiNode, key: string): string {
  const v = node.attributes?.[key];
  return v === undefined || v === null ? "" : String(v);
}

function isTrue(node: UiNode, key: string): boolean {
  return attr(node, key).toLowerCase() === "true";
}

function roleOf(node: UiNode): ElementRole {
  const type = attr(node, "type");
  const mapped = ROLE.get(type);
  if (mapped) return mapped;
  if (isTrue(node, "scrollable")) return "list";
  if (isTrue(node, "clickable") || isTrue(node, "longClickable")) return "button";
  if (type) return type.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase() || "element";
  return "element";
}

function descendantTexts(node: UiNode, out: string[] = [], limit = 3): string[] {
  for (const child of node.children ?? []) {
    if (out.length >= limit) break;
    const t = attr(child, "text").trim();
    if (t && !out.includes(t)) out.push(t);
    descendantTexts(child, out, limit);
  }
  return out;
}

function idLabel(node: UiNode): string {
  const id = attr(node, "id");
  if (!id) return "";
  return id.replace(/^id_/i, "").replace(/[_-]+/g, " ").trim();
}

function labelOf(node: UiNode, role: ElementRole): string {
  let label = (attr(node, "text") || attr(node, "description") || attr(node, "hint")).trim();
  if (
    !label &&
    (role === "button" || role === "list" || role === "toggle" || role === "checkbox" || role === "radio" || role === "slider")
  ) {
    label = descendantTexts(node).join(" ").trim();
  }
  if (!label && (role === "button" || role === "input" || role === "toggle" || role === "checkbox" || role === "radio")) {
    label = idLabel(node);
  }
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}

function stateOf(node: UiNode): string[] {
  const out: string[] = [];
  if (isTrue(node, "focused")) out.push("focused");
  if (attr(node, "enabled").toLowerCase() === "false") out.push("disabled");
  if (isTrue(node, "checked")) out.push("checked");
  if (isTrue(node, "selected")) out.push("selected");
  if (isTrue(node, "scrollable")) out.push("scrollable");
  if (isTrue(node, "password")) out.push("password");
  const inputType = attr(node, "textInputType") || attr(node, "inputType");
  if (/password/i.test(inputType)) out.push("password");
  return out;
}

function signatureOf(node: UiNode, role: ElementRole, label: string, rect: Rect): string {
  return `${role}|${label}|${rect.x},${rect.y},${rect.width},${rect.height}|${attr(node, "description")}|${attr(node, "hint")}`;
}

function display(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lineFor(element: ScreenElement): string {
  const quoted = element.label ? ` "${element.label.replace(/"/g, '\\"')}"` : "";
  const stateText = element.state.length ? ` ${element.state.join(" ")}` : "";
  return `[${element.ref}] ${element.role}${quoted} @${element.center.x},${element.center.y}${stateText}`;
}

function findBundle(node: UiNode): string {
  const own = attr(node, "bundleName");
  if (own) return own;
  for (const child of node.children ?? []) {
    const found = findBundle(child);
    if (found) return found;
  }
  return "";
}

/**
 * Turns a raw layout tree into the agent-facing screen: one entry per
 * actionable or informative node, each with a ref that survives rerenders.
 *
 * Refs are allocated per signature and never reused: a signature that leaves
 * the screen keeps its number, so the same element coming back gets the same
 * ref, and a number can never come to mean a different element. A ref that is
 * not on the current screen simply does not resolve.
 *
 * A store makes the table outlive the process. The CLI runs one command per
 * invocation, so without it every command would number elements from 1 again
 * and a ref printed by `observe` could silently address another element in the
 * next `tap`.
 */
export class ScreenBuilder {
  private readonly refBySignature = new Map<string, number>();
  private nextRef = 1;
  /** What is on disk, so an unchanged table is not rewritten. */
  private saved = "";
  /** Signatures seen in the most recent build, spared from pruning. */
  private lastSignatures = new Set<string>();

  constructor(private readonly store: FileRefStore | null = null) {
    const table = store?.load();
    if (table) {
      for (const [signature, ref] of Object.entries(table.refs)) {
        this.refBySignature.set(signature, ref);
      }
      const highest = Math.max(0, ...Object.values(table.refs));
      this.nextRef = Math.max(table.next, highest + 1);
    }
    this.saved = this.store ? JSON.stringify(this.table()) : "";
  }

  /** Writes the table when it changed; returns whether anything was written. */
  async persist(): Promise<boolean> {
    if (!this.store) return false;
    this.prune();
    const now = JSON.stringify(this.table());
    if (now === this.saved) return false;
    await this.store.save(this.table());
    this.saved = now;
    return true;
  }

  private table(): RefTable {
    return { next: this.nextRef, refs: Object.fromEntries(this.refBySignature) };
  }

  /**
   * Keeps the table bounded. Refs are never reused, so the table can only grow;
   * a long session that visits thousands of screens would otherwise carry every
   * screen it ever saw. Old entries go first, and anything on the current screen
   * is never evicted.
   */
  private prune(): void {
    let excess = this.refBySignature.size - MAX_REFS;
    if (excess <= 0) return;
    for (const signature of [...this.refBySignature.keys()]) {
      if (excess <= 0) break;
      if (this.lastSignatures.has(signature)) continue;
      this.refBySignature.delete(signature);
      excess--;
    }
  }

  reset(): void {
    this.refBySignature.clear();
    this.nextRef = 1;
  }

  build(tree: UiNode, ctx: ScreenContext): Screen {
    const candidates: ScreenElement[] = [];
    const seen = new Set<number>();
    const signatures = new Set<string>();

    const walk = (node: UiNode, ancestors: Array<{ clickable: boolean; label: string }>): void => {
      let nextAncestors = ancestors;
      const rect = parseBounds(attr(node, "bounds"));
      if (rect && rect.width > 0 && rect.height > 0) {
        const role = roleOf(node);
        const label = labelOf(node, role);
        const clickable = isTrue(node, "clickable") || isTrue(node, "longClickable");
        const input = role === "input";
        const scrollable = isTrue(node, "scrollable");
        const focused = isTrue(node, "focused");
        const hasText = Boolean(attr(node, "text").trim());
        const structural = STRUCTURAL.has(role);
        const insideLabeledClickable = ancestors.some((a) => a.clickable && a.label);
        const topBar = rect.y < 90 && rect.height < 140 && !input;
        const centerY = rect.y + rect.height / 2;
        const bottomBar =
          ctx.display.height > 0 &&
          centerY > ctx.display.height - 70 &&
          !input &&
          !scrollable &&
          (role === "button" || role === "text");
        const interactive =
          role === "toggle" ||
          role === "checkbox" ||
          role === "radio" ||
          role === "slider" ||
          role === "tabs" ||
          role === "nav";
        const interesting =
          !topBar &&
          !bottomBar &&
          !structural &&
          (input ||
            scrollable ||
            interactive ||
            (clickable && (label || rect.width * rect.height > 600)) ||
            (hasText && !insideLabeledClickable));

        if (interesting) {
          const signature = signatureOf(node, role, label, rect);
          signatures.add(signature);
          let ref = this.refBySignature.get(signature);
          if (ref === undefined) {
            ref = this.nextRef++;
            this.refBySignature.set(signature, ref);
          }
          if (!seen.has(ref)) {
            seen.add(ref);
            candidates.push({
              ref,
              role,
              label,
              rect,
              center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
              state: stateOf(node),
              clickable,
              input,
              scrollable,
              focused,
              signature,
              node,
            });
          }
          nextAncestors = [...ancestors, { clickable, label }];
        } else if (structural) {
          nextAncestors = [...ancestors, { clickable, label }];
        }
      }
      for (const child of node.children ?? []) walk(child, nextAncestors);
    };
    walk(tree, []);

    // A clickable container that only repeats a deeper clickable's label is
    // noise: keep the control the agent can actually aim at.
    const kept = candidates.filter((c) => {
      if (c.role !== "button" || attr(c.node, "text").trim()) return true;
      const area = c.rect.width * c.rect.height;
      return !candidates.some(
        (d) =>
          d !== c &&
          (d.clickable || d.input) &&
          d.label &&
          c.label.includes(d.label) &&
          d.rect.x >= c.rect.x &&
          d.rect.y >= c.rect.y &&
          d.rect.x + d.rect.width <= c.rect.x + c.rect.width &&
          d.rect.y + d.rect.height <= c.rect.y + c.rect.height &&
          d.rect.width * d.rect.height < area,
      );
    });

    this.lastSignatures = signatures;

    kept.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.ref - b.ref);

    const focus = kept.find((c) => c.focused);
    const bundle = attr(tree, "bundleName") || findBundle(tree) || "unknown";
    const displayKey = `${ctx.display.width}x${ctx.display.height}@${ctx.rotation}`;
    const header = `screen ${displayKey.split("@")[0]} · app: ${bundle} · rotation ${ctx.rotation * 90}°${
      focus ? ` · focus [${focus.ref}]` : ""
    }`;
    const lines = kept.map(lineFor);
    const hash = createHash("sha1").update(header).update("\n").update(lines.join("\n")).digest("hex");

    return {
      header,
      bundle,
      display: { ...ctx.display },
      rotation: ctx.rotation,
      elements: kept,
      lines,
      hash,
      signatures,
      tree,
      at: Date.now(),
    };
  }
}

export function renderFull(screen: Screen): string {
  const body = screen.lines.length ? screen.lines.join("\n") : "(no elements)";
  return `${screen.header}\n${body}`;
}

export function renderDiff(previous: Screen | null, next: Screen): Diff {
  if (!previous) return { mode: "full", text: renderFull(next), added: [], removed: [], changed: [] };
  const displayKey = (s: Screen) => `${s.display.width}x${s.display.height}@${s.rotation}`;
  if (previous.bundle !== next.bundle || displayKey(previous) !== displayKey(next)) {
    return { mode: "full", text: renderFull(next), added: [], removed: [], changed: [] };
  }
  const before = new Map(previous.elements.map((e) => [e.ref, e]));
  const after = new Map(next.elements.map((e) => [e.ref, e]));
  const added: ScreenElement[] = [];
  const removed: ScreenElement[] = [];
  const changed: ScreenElement[] = [];
  for (const [ref, element] of after) {
    const old = before.get(ref);
    if (!old) added.push(element);
    else if (lineFor(old) !== lineFor(element)) changed.push(element);
  }
  for (const [ref, element] of before) if (!after.has(ref)) removed.push(element);

  const changes = added.length + removed.length + changed.length;
  if (changes === 0) {
    return { mode: "diff", text: `${next.header}\nno change`, added, removed, changed };
  }
  if (changes > Math.max(12, next.lines.length * 0.5)) {
    return { mode: "full", text: renderFull(next), added, removed, changed };
  }
  const body = [
    ...added.map((e) => `+ ${lineFor(e)}`),
    ...removed.map((e) => `- ${lineFor(e)}`),
    ...changed.map((e) => `~ ${lineFor(e)}`),
  ];
  return { mode: "diff", text: `${next.header}\n${body.join("\n")}`, added, removed, changed };
}

/** Every element whose rect covers the point, shallowest first. */
export function nodesUnder(screen: Screen, x: number, y: number): ScreenElement[] {
  return screen.elements.filter(
    (e) => x >= e.rect.x && x < e.rect.x + e.rect.width && y >= e.rect.y && y < e.rect.y + e.rect.height,
  );
}

export function findElement(screen: Screen, ref: number): ScreenElement | null {
  return screen.elements.find((e) => e.ref === ref) ?? null;
}

/**
 * Case-insensitive substring search. An exact label wins over a container whose
 * joined label merely contains the needle ("Item two" vs a list labelled
 * "Item one Item two"), then the shortest label, then anything that is not a
 * scroll container.
 */
export function findText(screen: Screen, text: string): ScreenElement | null {
  const needle = display(text).toLowerCase();
  if (!needle) return null;
  const matches = screen.elements.filter((e) => display(e.label).toLowerCase().includes(needle));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => {
    const exact = Number(display(b.label).toLowerCase() === needle) - Number(display(a.label).toLowerCase() === needle);
    if (exact !== 0) return exact;
    const container = Number(a.scrollable) - Number(b.scrollable);
    if (container !== 0) return container;
    return a.label.length - b.label.length;
  })[0]!;
}

export function findTexts(screen: Screen, text: string): ScreenElement[] {
  const needle = display(text).toLowerCase();
  if (!needle) return [];
  return screen.elements.filter((e) => display(e.label).toLowerCase().includes(needle));
}

export function textOf(screen: Screen): string {
  return screen.elements.map((e) => display(e.label)).filter(Boolean).join("\n");
}

export { lineFor };
