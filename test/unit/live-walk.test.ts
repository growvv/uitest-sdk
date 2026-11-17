import { describe, it, expect } from "vitest";
import { RestartBudget } from "../../scripts/live-walk.js";

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
