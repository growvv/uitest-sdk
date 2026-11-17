import { describe, it, expect } from "vitest";
import {
  RestartBudget,
  assistantCropHeight,
  clientPointFor,
  isSearchEntryNode,
  parseOnly,
  readonlyGuardVerdict,
  shouldRun,
} from "../../scripts/live-walk.js";

/**
 * The pinch scenario's walk can land somewhere that is neither the search
 * results nor an image viewer — a hot-topic module, a video channel, an
 * unrecognised landing page. It answers that by cold-starting Zhihu and
 * searching again (~30 s), which must not be able to repeat forever: a run
 * that never fails never finishes, and its finally-block (the screen-off
 * timeout restore) never runs.
 */
describe("RestartBudget", () => {
  it("allows exactly the number of restarts it was given", () => {
    const budget = new RestartBudget(2);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.take()).toBe(false);
  });

  it("refuses every restart when given none", () => {
    const budget = new RestartBudget(0);
    expect(budget.take()).toBe(false);
  });

  it("reports what it has left, so the failure can say how hard it tried", () => {
    const budget = new RestartBudget(3);
    budget.take();
    expect(budget.left()).toBe(2);
    budget.take();
    budget.take();
    expect(budget.left()).toBe(0);
  });
});

/**
 * The browser checks press the page's canvas over a device field. The canvas
 * is 608×1344 (the half-size frame an MJPEG device delivers) while the display
 * is 1216×2688, so the press has to be placed by the display size. Dividing by
 * the canvas put the press at the top-left corner — and that mistake cancelled
 * out against the page's own one, so it only showed once the page was fixed.
 */
describe("clientPointFor", () => {
  const display = { width: 1216, height: 2688 };
  const rect = { left: 0, top: 0, width: 400, height: 800 };

  it("puts the centre of the display at the centre of the canvas", () => {
    expect(clientPointFor({ x: 608, y: 1344 }, display, rect)).toEqual({ x: 200, y: 400 });
  });

  it("puts a field near the top at the top, not a quarter of the way down", () => {
    // The search field sits at y≈180 of 2688 — 6.7% down, not 13.4%.
    const p = clientPointFor({ x: 608, y: 180 }, display, rect);
    expect(p.y).toBeCloseTo(53.57, 1);
  });

  it("honours the canvas offset", () => {
    const offset = { left: 120, top: 40, width: 400, height: 800 };
    expect(clientPointFor({ x: 608, y: 1344 }, display, offset)).toEqual({ x: 320, y: 440 });
  });
});

describe("shouldRun", () => {
  it("runs everything without a filter", () => {
    expect(shouldRun("pinch", null)).toBe(true);
    expect(shouldRun("pinch", [])).toBe(true);
  });

  it("matches a scenario by substring, case-insensitively", () => {
    expect(shouldRun("browser keyboard", ["browser"])).toBe(true);
    expect(shouldRun("browser keyboard", ["KEY"])).toBe(true);
    expect(shouldRun("browser keyboard", ["pinch"])).toBe(false);
  });

  it("matches any of several filters", () => {
    expect(shouldRun("pinch", ["tap", "pinch"])).toBe(true);
  });

  it("always runs takeover, which every later scenario depends on", () => {
    // Without a controller the server correctly ignores input, and a skipped
    // takeover would make every selected scenario fail for the wrong reason.
    expect(shouldRun("takeover", ["pinch"])).toBe(true);
  });
});

describe("parseOnly", () => {
  it("is null when the flag is absent, so everything runs", () => {
    expect(parseOnly(undefined)).toBeNull();
  });

  it("splits and trims a comma list", () => {
    expect(parseOnly(" browser keyboard , pinch ")).toEqual(["browser keyboard", "pinch"]);
  });
});

describe("assistantCropHeight", () => {
  const display = { width: 1216, height: 2688 };
  const shot = { width: 608, height: 1144 };

  it("keeps the bar and a margin, in screenshot pixels", () => {
    // 1230 + 220 = 1450 display px, plus the 24 px margin, halved for the
    // 608-wide capture → 627.
    const height = assistantCropHeight([{ y: 1230, h: 220 }], display, shot);
    expect(height).toBe(Math.round((1450 + 24) / 2));
  });

  it("follows the bar when a long query pushes it down", () => {
    const short = assistantCropHeight([{ y: 1230, h: 220 }], display, shot);
    const long = assistantCropHeight([{ y: 1400, h: 220 }], display, shot);
    expect(long).toBeGreaterThan(short);
  });

  it("uses the lowest of the bar's nodes", () => {
    const height = assistantCropHeight(
      [
        { y: 1230, h: 120 },
        { y: 1400, h: 200 },
      ],
      display,
      shot,
    );
    expect(height).toBe(Math.round((1600 + 24) / 2));
  });

  it("never exceeds the screenshot", () => {
    expect(assistantCropHeight([{ y: 2600, h: 200 }], display, shot)).toBe(shot.height);
  });
});

/**
 * The read-only guard is the only acceptance evidence for the read-only
 * promise. It used to aim at (100, 100) — blank white in the top bar — and
 * assert only that the page had not navigated, which a server that forwarded
 * read-only input would also satisfy. These pin the verdict to the thing that
 * would actually move if the input were routed.
 */
describe("readonlyGuardVerdict", () => {
  const feed = (extra: Partial<{ input: boolean; cy: number }> = {}) => [
    { label: "首页", cx: 100, cy: 150, w: 80, clickable: true, input: false },
    { label: "推荐", cx: 300, cy: 150, w: 120, clickable: true, input: false },
    { label: "关注", cx: 500, cy: 150, w: 120, clickable: true, input: false },
    { label: "热榜", cx: 200, cy: 350, w: 120, clickable: true, input: false },
    ...(extra.input
      ? [{ label: "搜索", cx: 600, cy: 160, w: 400, clickable: true, input: true }]
      : []),
  ];

  it("passes when the tap was ignored and the feed is unchanged", () => {
    expect(readonlyGuardVerdict({ bundle: "com.zhihu.hmos" }, { bundle: "com.zhihu.hmos", nodes: feed() })).toBeNull();
  });

  it("fails when the tap opened the search page", () => {
    expect(
      readonlyGuardVerdict(
        { bundle: "com.zhihu.hmos" },
        { bundle: "com.zhihu.hmos", nodes: feed({ input: true }) },
      ),
    ).toBe("the injected tap opened the search page");
  });

  it("fails when the tap left the feed", () => {
    const verdict = readonlyGuardVerdict(
      { bundle: "com.zhihu.hmos" },
      { bundle: "com.zhihu.hmos", nodes: [{ label: "热榜", cx: 100, cy: 100, w: 100, clickable: true, input: false }] },
    );
    expect(verdict).toContain("left the feed");
  });

  it("fails when the tap left the app", () => {
    expect(
      readonlyGuardVerdict(
        { bundle: "com.zhihu.hmos" },
        { bundle: "com.ohos.sceneboard", nodes: feed() },
      ),
    ).toContain("navigated to com.ohos.sceneboard");
  });

  it("aims at a node that would navigate if the input were routed", () => {
    // The guard's target: the wide clickable node in the top bar.
    expect(isSearchEntryNode({ label: "热榜", cx: 608, cy: 200, w: 700, clickable: true, input: false })).toBe(true);
    // A tab label is not it: too narrow.
    expect(isSearchEntryNode({ label: "推荐", cx: 300, cy: 150, w: 120, clickable: true, input: false })).toBe(false);
  });
});
