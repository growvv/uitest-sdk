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

export function initCopyButton() {
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

export function initReveal() {
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

export function initTyping() {
  const lines = [...document.querySelectorAll(".term-line")];
  if (!lines.length) return;

  // Reduced motion, or no observer: leave the complete text in place.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  const texts = lines.map((line) => line.textContent);
  let started = false;

  const observer = new IntersectionObserver(
    (entries) => {
      if (started || !entries.some((entry) => entry.isIntersecting)) return;
      started = true;
      observer.disconnect();
      lines.forEach((line) => (line.textContent = ""));
      typeLines(lines, texts);
    },
    { threshold: 0.35 },
  );
  observer.observe(lines[0].closest(".term") ?? lines[0]);
}

document.addEventListener("DOMContentLoaded", () => {
  initCopyButton();
  initReveal();
  initTyping();
});
