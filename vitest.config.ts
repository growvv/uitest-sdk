import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // The device files share one device: one daemon, one port, and a single
    // capture channel. Running two of them at once makes them fight over that
    // channel — a real conflict the SDK now reports immediately (spec §4.6) —
    // and one file's killAllUitest() would kill the other's daemon mid-request.
    maxWorkers: 1,
    minWorkers: 1,
  },
});
