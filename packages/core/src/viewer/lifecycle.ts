/**
 * Resolves when a person or their supervisor asks the process to stop.
 *
 * SIGINT/SIGTERM cover a terminal. They are not enough for a supervisor: on
 * Windows `child.kill()` terminates the process outright and no handler runs,
 * so the device lease and the hdc port forward are never released — twenty
 * abandoned forwards filled 8012..8031 and the next run could not open the
 * tunnel at all. Closing the child's stdin is a signal every platform
 * delivers, so it is honoured as the same request to stop.
 *
 * It lives in core because every product needs it and products cannot import
 * each other; the two copies it replaces were already drifting in comment and
 * would eventually have drifted in behaviour.
 */
export function waitForStop(io: {
  stdin: { resume(): void; on(event: string, listener: () => void): unknown };
  signals: { once(event: string, listener: () => void): unknown };
}): Promise<void> {
  io.stdin.resume();
  return new Promise<void>((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      resolve();
    };
    io.signals.once("SIGINT", stop);
    io.signals.once("SIGTERM", stop);
    io.stdin.on("end", stop);
    io.stdin.on("close", stop);
  });
}
