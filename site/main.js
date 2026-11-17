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

/**
 * Plays the takeover demo: five real screenshots from one phone session.
 *
 * The frames were captured with this project driving the device — feed,
 * search results for 「鸿蒙」, an article, the image viewer, and the viewer
 * after a two-finger zoom — so the animation only points at what the pictures
 * already show. Coordinates are percentages of the same 608×1144 captures.
 * Without JS, or with reduced motion, the first frame and first step stay lit.
 */
const CONTROL_STEPS = [
  // cursor x%, cursor y%, wait before acting, how long the step stays up
  { x: 26, y: 6.4, act: 1200, hold: 4200 },
  { x: 50, y: 27, act: 900, hold: 3200 },
  { x: 50, y: 62, act: 900, hold: 3000 },
  { x: 50, y: 45, act: 800, hold: 4600 },
];
const CONTROL_TYPE = "鸿蒙";
const CONTROL_TYPE_MS = 260;

function initControl() {
  const demo = document.querySelector("[data-control-demo]");
  if (!demo) return;
  const phone = demo.querySelector(".control-phone");
  const frames = [...demo.querySelectorAll(".control-frame")];
  const steps = [...demo.querySelectorAll(".control-steps li")];
  const cursor = demo.querySelector(".control-cursor");
  const ripple = demo.querySelector(".control-ripple");
  const keys = demo.querySelector(".control-keys");
  const keysText = demo.querySelector(".control-keys-text");
  if (!phone || frames.length !== 5 || !cursor || !ripple || !keys || !keysText) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A step lights its own row; the frame is chosen by the phase, because two
  // steps share the article (reading it, then opening its image).
  const showStep = (i) => steps.forEach((el, n) => el.classList.toggle("is-on", n === i));
  const showFrame = (i) => frames.forEach((el, n) => el.classList.toggle("is-on", n === i));

  const clearMotion = () => {
    frames.forEach((el) => el.classList.remove("is-scrolled"));
    phone.classList.remove("is-pinch");
  };

  const moveCursor = (x, y) => {
    cursor.style.left = x + "%";
    cursor.style.top = y + "%";
  };

  const pulse = () => {
    ripple.style.left = cursor.style.left;
    ripple.style.top = cursor.style.top;
    ripple.classList.remove("is-on");
    void ripple.offsetWidth;
    ripple.classList.add("is-on");
  };

  // Every beat of a step goes through `later`, which keeps the timer's id.
  //
  // A step is a chain of nested timeouts — move, pulse, type, swap frame — and
  // an id that is never kept cannot be cancelled. stop() used to clear only the
  // outer tick, so scrolling the demo out of view mid-step left the chain
  // running, and scrolling back in started a second one. The two then moved the
  // cursor and swapped frames under each other, showing beats of a step that
  // was no longer on screen.
  const beats = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      beats.delete(id);
      fn();
    }, ms);
    beats.add(id);
    return id;
  };
  const clearBeats = () => {
    for (const id of beats) clearTimeout(id);
    beats.clear();
  };

  const play = (index) => {
    const step = CONTROL_STEPS[index];
    clearMotion();
    showStep(index);

    if (index === 0) {
      // Feed: tap the search field, type into the device's caret, and the
      // results page comes up — the frame the next step taps on.
      showFrame(0);
      cursor.classList.add("is-live");
      moveCursor(78, 86);
      later(() => {
        moveCursor(step.x, step.y);
        later(() => {
          pulse();
          later(() => {
            keys.classList.add("is-on");
            keysText.textContent = "待输入";
            let n = 0;
            const type = () => {
              keysText.textContent = CONTROL_TYPE.slice(0, ++n);
              if (n < CONTROL_TYPE.length) {
                later(type, CONTROL_TYPE_MS);
              } else {
                later(() => {
                  keys.classList.remove("is-on");
                  keysText.textContent = "待输入";
                  showFrame(1);
                }, 700);
              }
            };
            later(type, 220);
          }, 380);
        }, 800);
      }, 200);
      return;
    }

    if (index === 1) {
      // Results: tap the first card.
      showFrame(1);
      moveCursor(50, 60);
      later(() => {
        moveCursor(step.x, step.y);
        later(() => {
          pulse();
          later(() => showFrame(2), 380);
        }, 700);
      }, 150);
      return;
    }

    if (index === 2) {
      // Article: hold and drag upward; the picture slides with the finger.
      showFrame(2);
      moveCursor(50, 78);
      later(() => {
        frames[2].classList.add("is-scrolled");
        later(() => frames[2].classList.remove("is-scrolled"), 1200);
      }, step.act);
      return;
    }

    // The article's image opens the viewer, and two fingers spread on it.
    showFrame(2);
    moveCursor(50, 55);
    later(() => {
      pulse();
      later(() => {
        showFrame(3);
        later(() => {
          phone.classList.add("is-pinch");
          later(() => {
            phone.classList.remove("is-pinch");
            showFrame(4);
          }, 1500);
        }, 500);
      }, 420);
    }, step.act);
  };

  if (reduced) {
    showStep(0);
    showFrame(0);
    return;
  }

  let index = 0;
  let timer = null;
  const start = () => {
    if (timer) return;
    const tick = () => {
      play(index);
      timer = setTimeout(() => {
        index = (index + 1) % CONTROL_STEPS.length;
        tick();
      }, CONTROL_STEPS[index].hold);
    };
    tick();
  };
  const stop = () => {
    // The chain, not just the tick: a step half-played is still several beats
    // in flight, and each would paint over the frame the demo resets to.
    clearBeats();
    if (timer) clearTimeout(timer);
    timer = null;
    clearMotion();
    keys.classList.remove("is-on");
    keysText.textContent = "待输入";
  };

  if (!("IntersectionObserver" in window)) {
    start();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) start();
        else stop();
      }
    },
    { threshold: 0.25 },
  );
  observer.observe(demo);
}

document.addEventListener("DOMContentLoaded", () => {
  // A motion-independent marker that the script actually ran; check-site.mjs
  // asserts it in a headless browser, because a plain text check cannot.
  document.documentElement.classList.add("js-ready");
  initCopyButton();
  initReveal();
  initTyping();
  initShowcase();
  initControl();
});
