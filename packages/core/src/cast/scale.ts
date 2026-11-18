import { UitestError } from "../transport/errors.js";

/**
 * Turns a person's `--max-size` into the scale their transport understands.
 *
 * The two H.264 transports take an integer divisor (`-scale 2` means half), and
 * the extension accepts only 1..5. MJPEG's scale is a fraction instead, because
 * it is the agent's JPEG capture that is being resized, not the extension's
 * encoder. One number from the command line therefore means two different
 * things, and computing it in the caller would get one of them wrong.
 *
 * The result is exact rather than approximate: a divisor is a divisor, and
 * pretending a 6x shrink exists would hand the person a picture twice the size
 * they asked for while reporting success.
 */
export function resolveCastScale(
  transport: "grpc" | "ws" | "mjpeg",
  longestEdge: number,
  opts: { scale?: number; maxSize?: number },
): number {
  if (opts.scale !== undefined && opts.maxSize !== undefined) {
    throw new UitestError(
      "scale and maxSize both given: set one, not both",
      "EBADARG",
    );
  }
  if (opts.maxSize === undefined) {
    if (opts.scale !== undefined) return opts.scale;
    return transport === "mjpeg" ? 0.5 : 1;
  }
  if (!(opts.maxSize > 0) || !(longestEdge > 0)) {
    throw new UitestError(
      `maxSize needs a positive size and a known display, got ${opts.maxSize} and ${longestEdge}`,
      "EBADARG",
    );
  }

  if (transport === "mjpeg") {
    // The agent resizes the JPEG it captures; any fraction works. It is
    // rounded *down*, because `maxSize` is an upper bound: 1014/2560 rounds to
    // 0.40 and yields a 1024 px frame, 10 px larger than asked.
    const fraction = Math.floor((opts.maxSize / longestEdge) * 100) / 100;
    if (fraction < 0.05) {
      // Below the floor the agent would silently clamp, and a 128 px picture
      // is not the 50 px one asked for. The grpc path refuses in the same
      // case; saying so is the only honest answer here too.
      const reachable = Math.round(longestEdge * 0.05);
      throw new UitestError(
        `maxSize ${opts.maxSize} is below what the agent can reach: ` +
          `a 5% capture of ${longestEdge} px is ${reachable} px`,
        "EBADARG",
      );
    }
    return Math.min(1, fraction);
  }

  const divisor = Math.ceil(longestEdge / opts.maxSize);
  if (divisor > 5) {
    // Say what the device can actually reach, so the person can pick a size
    // that works instead of guessing at the limit.
    const reachable = Math.ceil(longestEdge / 5);
    throw new UitestError(
      `maxSize ${opts.maxSize} is below what the casting extension can reach: ` +
        `a 5x shrink of ${longestEdge} px is ${reachable} px`,
      "EBADARG",
    );
  }
  return Math.max(1, divisor);
}
