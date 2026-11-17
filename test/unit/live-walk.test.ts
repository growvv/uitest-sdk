import { describe, it, expect } from "vitest";
import {
  RestartBudget,
  assistantCropHeight,
  chromeKillSteps,
  clientPointFor,
  isSearchEntryNode,
  parseOnly,
  readonlyGuardVerdict,
  reportFileName,
  shouldRelaunch,
  shouldRun,
  stabilityStep,
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

  it("keeps more room under a taller bar", () => {
    // The bar's own padding below its last node is not in the layout, so a
    // fixed 24 px margin clips the bottom edge of a taller bar. The margin
    // follows the bar's height: a 600 px bar keeps 60, not 24.
    const height = assistantCropHeight([{ y: 1000, h: 600 }], display, shot);
    expect(height).toBe(Math.round((1600 + 60) / 2));
  });

  it("keeps the small margin for a normal bar", () => {
    // The device's bar is 220 px tall; 10% of that is 22, below the floor.
    expect(assistantCropHeight([{ y: 1230, h: 220 }], display, shot)).toBe(
      Math.round((1450 + 24) / 2),
    );
  });
});

describe("reportFileName", () => {
  // A partial run used to write `report.md`, replacing the committed
  // full-acceptance report with one whose own header says it is not a full
  // acceptance. `--only` is for iterating on the script; its output must not
  // be able to stand in for the record.
  it("uses report.md for a complete run", () => {
    expect(reportFileName(null)).toBe("report.md");
  });

  it("keeps a filtered run out of the committed report's path", () => {
    expect(reportFileName(["tap"])).toBe("report-only.md");
  });
});

describe("chromeKillSteps", () => {
  // The acceptance run drives a real browser and kills it in a finally block.
  // `taskkill` exists only on Windows, so on macOS and Linux the call threw,
  // was swallowed as "already exited", and left a headless Chrome holding the
  // debug port — the next run then found a stale page instead of its own.
  it("uses taskkill on Windows", () => {
    expect(chromeKillSteps(4242, "win32")).toEqual([
      { kind: "exec", command: "taskkill", args: ["/PID", "4242", "/T", "/F"] },
    ]);
  });

  it("signals the process group on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      // The group first (Chrome spawns renderers under it), then the process
      // itself in case the spawn was not detached and the group kill missed.
      expect(chromeKillSteps(4242, platform)).toEqual([
        { kind: "signal", pid: -4242, signal: "SIGKILL" },
        { kind: "signal", pid: 4242, signal: "SIGKILL" },
      ]);
    }
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

/**
 * The stability run's tick used to decide "back" on the feed predicate alone.
 * That predicate only accepts 首页 with 推荐/关注, so a feed variant read as
 * "not the feed" — and a back there backgrounds the app. Every later tick then
 * scrolled the launcher, the stream went static (13 fps against 18), and the
 * handover's Home key had nothing to leave.
 */
describe("stabilityStep", () => {
  const ZHIHU = "com.zhihu.hmos";

  it("scrolls on most ticks", () => {
    expect(stabilityStep(ZHIHU, ZHIHU, true, 0)).toBe("scroll");
    expect(stabilityStep(ZHIHU, ZHIHU, true, 13)).toBe("scroll");
  });

  it("types on the text ticks", () => {
    expect(stabilityStep(ZHIHU, ZHIHU, true, 15)).toBe("text");
    expect(stabilityStep(ZHIHU, ZHIHU, true, 16)).toBe("text");
  });

  it("never sends back while the app is in front on its feed", () => {
    // Back on the feed backgrounds Zhihu; the rest of the run would type into
    // the launcher.
    for (const n of [17, 18, 19, 37, 38, 39]) {
      expect(stabilityStep(ZHIHU, ZHIHU, true, n)).toBe("scroll");
    }
  });

  it("sends back only on a page where back has somewhere to go", () => {
    expect(stabilityStep(ZHIHU, ZHIHU, false, 17)).toBe("back");
  });

  it("relaunches when the app is not in front at all", () => {
    // The bug: the launcher is not the feed, so the old tick sent back into it
    // forever. Whatever the tick number, a backgrounded app is brought back.
    expect(stabilityStep("com.ohos.sceneboard", ZHIHU, false, 17)).toBe("relaunch");
    expect(stabilityStep("com.ohos.sceneboard", ZHIHU, false, 0)).toBe("relaunch");
    expect(stabilityStep("com.ohos.sceneboard", ZHIHU, true, 5)).toBe("relaunch");
  });
});

describe("shouldRelaunch", () => {
  it("does not restart the app on every tick", () => {
    // A relaunch is a cold start, and the splash carries almost no frames.
    // Firing one every 500 ms kept Zhihu restarting and dragged the measured
    // fps down.
    expect(shouldRelaunch("relaunch", 0)).toBe(false);
    expect(shouldRelaunch("relaunch", 500)).toBe(false);
    expect(shouldRelaunch("relaunch", 4000)).toBe(true);
  });

  it("never relaunches on a tick that does something else", () => {
    expect(shouldRelaunch("scroll", 10_000)).toBe(false);
    expect(shouldRelaunch("back", 10_000)).toBe(false);
    expect(shouldRelaunch("text", 10_000)).toBe(false);
  });
});
