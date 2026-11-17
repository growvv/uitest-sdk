import { UitestError } from "../../transport/errors.js";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new UitestError(`request timeout after ${ms} ms`, "ETIMEDOUT"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * FIFO queue that runs one task at a time. The device-side agent holds a global
 * lock and answers concurrent requests with `Disallow concurrent use`, so every
 * RPC must go through here.
 *
 * A timeout releases the queue but does NOT cancel the underlying task — an
 * in-flight socket write cannot be interrupted. The caller (AgentClient) is
 * responsible for discarding the connection afterwards, since a late reply
 * would otherwise be paired with the wrong request.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get depth(): number {
    return this.pending;
  }

  run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    this.pending++;
    const started = this.tail.then(fn);
    const guarded = timeoutMs === undefined ? started : withTimeout(started, timeoutMs);
    this.tail = guarded.then(
      () => undefined,
      () => undefined,
    );
    return guarded.finally(() => {
      this.pending--;
    });
  }
}
