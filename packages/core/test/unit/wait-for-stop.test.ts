import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForStop } from "../../src/viewer/lifecycle.js";

/**
 * `waitForStop` was copied verbatim into `uitest-console` and `uitest-mirror`.
 * Products cannot import each other, so the shared home is core — and a copy
 * is how one product quietly loses the stdin case on Windows, where
 * `child.kill()` delivers no signal and only closing stdin reaches the handler
 * that releases the lease and the port forward.
 */
describe("waitForStop", () => {
  const io = () => {
    const stdin = new EventEmitter() as EventEmitter & { resume(): void };
    stdin.resume = () => undefined;
    return { stdin, signals: new EventEmitter() };
  };

  it("stops when the supervisor closes stdin", async () => {
    const { stdin, signals } = io();
    const stopped = waitForStop({ stdin, signals });
    stdin.emit("end");
    await expect(stopped).resolves.toBeUndefined();
  });

  it("stops on SIGINT and on SIGTERM", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const { stdin, signals } = io();
      const stopped = waitForStop({ stdin, signals });
      signals.emit(signal);
      await expect(stopped).resolves.toBeUndefined();
    }
  });

  it("resolves once, whichever comes first", async () => {
    const { stdin, signals } = io();
    let stops = 0;
    const stopped = waitForStop({ stdin, signals }).then(() => {
      stops++;
    });
    signals.emit("SIGTERM");
    stdin.emit("end");
    await stopped;
    expect(stops).toBe(1);
  });
});
