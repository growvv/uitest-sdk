import { describe, expect, it } from "vitest";
import { isHistoryListInFront } from "../../../../scripts/acceptance.js";

/**
 * Whether the staged surface is still the one the console's cases are about.
 *
 * The inbox case needs the calculator's history list, because its delete key is
 * the step the policy flags. The phone is a real phone: it sleeps during a long
 * run, and waking it lands on the lock screen or the launcher. The 0.1.1 run
 * checked this once, at staging, and then spent its last four cases on a phone
 * that had locked itself — the mirror went black, the replay found nothing to
 * tap, and both were reported as console defects.
 */
describe("isHistoryListInFront", () => {
  it("is true when the list is in front with a row on it", () => {
    expect(
      isHistoryListInFront([{ label: "history back icon" }, { label: "history record delete" }]),
    ).toBe(true);
  });

  it("is false when the list is in front but empty", () => {
    // An empty list is still the list, but a delete key that deletes nothing is
    // not the step this case is about.
    expect(
      isHistoryListInFront([{ label: "history record delete" }, { label: "没有历史记录" }]),
    ).toBe(false);
  });

  it("is false on the keypad, the launcher, or a lock screen", () => {
    expect(isHistoryListInFront([{ label: "7" }, { label: "8" }])).toBe(false);
    expect(isHistoryListInFront([])).toBe(false);
    expect(isHistoryListInFront([{ label: "ScreenLockWidgetView RelativeContainer" }])).toBe(false);
  });

  it("tolerates elements with no label at all", () => {
    // The layout carries containers and images with no label; a missing one
    // must not throw or be read as the row.
    expect(isHistoryListInFront([{ label: undefined }, { label: "history record delete" }])).toBe(true);
  });
});
