import type { Rect } from "../model.js";
import type { ElementRole, Screen } from "./screen.js";
import { Screenshot } from "./shot.js";
import type { Rgb } from "./shot.js";

/** One screen element as the inspector presents it. */
export interface InspectNode {
  /** 1-based number drawn on the image; matches the panel's row. */
  index: number;
  /** The handle `tap --ref` accepts, from the same screen build. */
  ref: number;
  role: ElementRole;
  label: string;
  rect: Rect;
  center: { x: number; y: number };
  state: string[];
  clickable: boolean;
  input: boolean;
  scrollable: boolean;
  focused: boolean;
  /** Pixels for this element were covered before anything was drawn. */
  masked: boolean;
}

export interface Inspection {
  nodes: InspectNode[];
  /** Redacted, then boxed and numbered: the image a caller looks at. */
  annotated: Screenshot;
  /** Redacted but unmarked: the base layer for the HTML panel overlay. */
  plain: Screenshot;
}

/**
 * Stable role colours. Both the image chip and the panel border use these, so
 * two runs of the same screen look the same and the legend stays meaningful.
 */
export const ROLE_COLORS: Record<string, Rgb> = {
  text: [33, 150, 243],
  button: [76, 175, 80],
  input: [255, 152, 0],
  list: [156, 39, 176],
  toggle: [0, 188, 212],
  checkbox: [0, 188, 212],
  radio: [0, 188, 212],
  slider: [255, 235, 59],
  tabs: [121, 85, 72],
  nav: [96, 125, 139],
};

const OTHER: Rgb = [233, 30, 99];
const MASKED: Rgb = [244, 67, 54];

export function colorFor(role: string): Rgb {
  return ROLE_COLORS[role] ?? OTHER;
}

/**
 * Builds the inspector view from a screen read and the frame captured with it.
 *
 * The screen is the authority for geometry and labels; the frame is only the
 * backdrop. A masked element is covered in the pixels first — box outlines and
 * numbers never replace redaction, they are drawn on top of it.
 */
export function inspectScreen(screen: Screen, shot: Screenshot): Inspection {
  const plain = shot.redact(screen.elements.filter((e) => e.masked).map((e) => e.rect));
  const nodes: InspectNode[] = screen.elements.map((e, i) => ({
    index: i + 1,
    ref: e.ref,
    role: e.role,
    label: e.label,
    rect: e.rect,
    center: e.center,
    state: [...e.state],
    clickable: e.clickable,
    input: e.input,
    scrollable: e.scrollable,
    focused: e.focused,
    masked: e.masked === true,
  }));
  const annotated = plain.mark(
    nodes.map((n) => ({
      rect: n.rect,
      color: n.masked ? MASKED : colorFor(n.role),
      label: n.index,
    })),
  );
  return { nodes, annotated, plain };
}

export interface PanelOptions {
  title?: string;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hex(color: Rgb): string {
  return `#${color.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A self-contained HTML panel: the redacted frame with clickable overlays and
 * the node table beside it. No external assets, no network — the image is a
 * data URI, so the file can be opened anywhere.
 *
 * Every label goes through `escapeHtml`: a screen's text is untrusted input.
 */
export function renderPanel(screen: Screen, inspection: Inspection, opts: PanelOptions = {}): string {
  const title = opts.title?.trim() || `Layout · ${screen.bundle || "screen"}`;
  const displayW = screen.display.width || inspection.plain.width;
  const displayH = screen.display.height || inspection.plain.height;
  const pct = (value: number, total: number) =>
    total > 0 ? `${((value / total) * 100).toFixed(2)}%` : "0%";

  const boxes = inspection.nodes
    .map((n) => {
      const color = hex(n.masked ? MASKED : colorFor(n.role));
      const style =
        `left:${pct(n.rect.x, displayW)};top:${pct(n.rect.y, displayH)};` +
        `width:${pct(n.rect.width, displayW)};height:${pct(n.rect.height, displayH)};` +
        `border-color:${color};color:${color}`;
      return (
        `<div class="box${n.masked ? " masked" : ""}" data-index="${n.index}" style="${style}"` +
        ` title="${escapeHtml(n.role)} ${escapeHtml(n.label)}">${n.index}</div>`
      );
    })
    .join("\n      ");

  const rows = inspection.nodes
    .map((n) => {
      const label = escapeHtml(n.label) || '<span class="dim">(no label)</span>';
      const state = escapeHtml(n.state.join(" "));
      return (
        `<tr data-index="${n.index}">` +
        `<td class="num">${n.index}</td>` +
        `<td class="num">${n.ref}</td>` +
        `<td><code>${escapeHtml(n.role)}</code>${n.masked ? ' <span class="tag masked-tag">masked</span>' : ""}</td>` +
        `<td>${label}</td>` +
        `<td class="num">${n.rect.x},${n.rect.y} ${n.rect.width}×${n.rect.height}</td>` +
        `<td class="dim">${state}</td>` +
        `</tr>`
      );
    })
    .join("\n        ");

  const roles = [...new Set(inspection.nodes.map((n) => n.role))];
  const legend = roles
    .map((role) => `<span class="legend"><i style="background:${hex(colorFor(role))}"></i>${escapeHtml(role)}</span>`)
    .join(" ");

  const image = inspection.plain.data.toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{font:13px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
h1{font-size:18px;margin:0 0 4px}
.meta{color:#8b949e;margin:0 0 16px}
.wrap{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.stage{position:relative;display:inline-block;line-height:0;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#000}
.stage img{display:block;width:min(460px,90vw);height:auto}
.box{position:absolute;box-sizing:border-box;border:2px solid;border-radius:2px;font:700 10px/1 ui-monospace,monospace;text-shadow:0 0 2px #000,0 0 2px #000;opacity:.75;overflow:hidden;cursor:default}
.box.masked{border-style:dashed;background:rgba(244,67,54,.18)}
.box.active{opacity:1;box-shadow:inset 0 0 0 1px #fff}
.side{flex:1;min-width:320px}
.legend{display:inline-flex;align-items:center;gap:4px;margin:0 10px 8px 0;color:#8b949e}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #21262d;vertical-align:top}
th{color:#8b949e;font-weight:600;position:sticky;top:0;background:#0d1117}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
tr{cursor:pointer}
tr.active{background:rgba(31,111,235,.25)}
.dim{color:#8b949e}
.tag{font-size:10px;padding:1px 5px;border-radius:99px;border:1px solid}
.masked-tag{color:#f85149;border-color:#f85149}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(screen.bundle || "unknown bundle")} · display ${displayW}×${displayH} · rotation ${screen.rotation * 90}° · ${inspection.nodes.length} elements</p>
<div class="wrap">
  <div class="stage">
    <img src="data:image/jpeg;base64,${image}" alt="device screen with the layout boxes drawn in HTML">
      ${boxes}
  </div>
  <div class="side">
    <p>${legend}</p>
    <table>
      <thead><tr><th>#</th><th>ref</th><th>role</th><th>label</th><th>bounds</th><th>state</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</div>
<script>
const mark = (index, on) => document.querySelectorAll('[data-index="' + index + '"]').forEach((el) => el.classList.toggle('active', on));
document.querySelectorAll('[data-index]').forEach((el) => {
  el.addEventListener('mouseenter', () => mark(el.dataset.index, true));
  el.addEventListener('mouseleave', () => mark(el.dataset.index, false));
  el.addEventListener('click', () => mark(el.dataset.index, true));
});
</script>
</body>
</html>
`;
}
