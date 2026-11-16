// Site behaviour: a copy button on the install command and a typing demo.
// Both are progressive enhancements — the page reads fine without them.

const COPY_LABEL = "复制";
const COPIED_LABEL = "已复制";
const TYPE_MS = 18;

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // Clipboard API needs a secure context; file:// does not get one.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
}

function initCopyButton() {
  const btn = document.getElementById("copy-install");
  const code = btn?.parentElement?.querySelector("code");
  if (!btn || !code) return;

  btn.addEventListener("click", async () => {
    try {
      await copyText(code.textContent.trim());
      btn.textContent = COPIED_LABEL;
    } catch {
      btn.textContent = "复制失败";
    }
    setTimeout(() => {
      btn.textContent = COPY_LABEL;
    }, 2000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeLines(lines, texts) {
  for (let i = 0; i < lines.length; i++) {
    for (let j = 1; j <= texts[i].length; j++) {
      lines[i].textContent = texts[i].slice(0, j);
      await sleep(TYPE_MS);
    }
  }
}

function initReveal() {
  const sections = [...document.querySelectorAll(".reveal")];
  if (!sections.length) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  // Only hide what JS is about to reveal; without JS the page is fully visible.
  document.documentElement.classList.add("js-reveal");

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.08 },
  );
  sections.forEach((section) => observer.observe(section));
}

function initTyping() {
  const lines = [...document.querySelectorAll(".term-line")];
  if (!lines.length) return;

  // Reduced motion, or no observer: leave the complete text in place.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  // Each terminal types when it comes into view. Grouping by .term matters
  // now that the page has more than one: a single shared queue would start
  // the off-screen terminal while the visitor is still reading the first.
  const groups = new Map();
  for (const line of lines) {
    const term = line.closest(".term");
    if (!term) continue;
    if (!groups.has(term)) groups.set(term, []);
    groups.get(term).push(line);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const group = groups.get(entry.target);
        observer.unobserve(entry.target);
        if (!group) continue;
        const texts = group.map((line) => line.textContent);
        group.forEach((line) => (line.textContent = ""));
        typeLines(group, texts);
      }
    },
    { threshold: 0.35 },
  );
  for (const term of groups.keys()) observer.observe(term);
}

/**
 * Steps the highlight pairs on each showcase screenshot.
 *
 * The overlay's rectangles were measured from the real page (row in the node
 * table, box on the phone), so this only has to turn them on in order. Each
 * figure is its own cycle and starts when it scrolls into view; without JS,
 * or with reduced motion, the first step simply stays lit.
 */
const STEP_MS = 2000;

function initShowcase() {
  const figures = [...document.querySelectorAll("[data-shot]")];
  if (!figures.length) return;

  const cycles = figures.map((fig) => {
    const rows = [...fig.querySelectorAll(".hl-row")];
    const boxes = [...fig.querySelectorAll(".hl-box")];
    const labels = [...fig.querySelectorAll(".shot-step span")];
    return { fig, rows, boxes, labels, index: 0, timer: null };
  });

  const paint = (cycle) => {
    const i = cycle.index;
    cycle.rows.forEach((el, n) => el.classList.toggle("is-on", n === i));
    cycle.boxes.forEach((el, n) => el.classList.toggle("is-on", n === i));
    cycle.labels.forEach((el, n) => el.classList.toggle("is-on", n === i));
  };

  const start = (cycle) => {
    if (cycle.timer) return;
    cycle.timer = setInterval(() => {
      cycle.index = (cycle.index + 1) % Math.max(cycle.rows.length, 1);
      paint(cycle);
    }, STEP_MS);
  };

  for (const cycle of cycles) paint(cycle);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) {
    cycles.forEach(start);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cycle = cycles.find((c) => c.fig === entry.target);
        if (!cycle) continue;
        if (entry.isIntersecting) start(cycle);
        else if (cycle.timer) {
          clearInterval(cycle.timer);
          cycle.timer = null;
        }
      }
    },
    { threshold: 0.35 },
  );
  for (const cycle of cycles) observer.observe(cycle.fig);
}

document.addEventListener("DOMContentLoaded", () => {
  // A motion-independent marker that the script actually ran; check-site.mjs
  // asserts it in a headless browser, because a plain text check cannot.
  document.documentElement.classList.add("js-ready");
  initCopyButton();
  initReveal();
  initTyping();
  initShowcase();
});
