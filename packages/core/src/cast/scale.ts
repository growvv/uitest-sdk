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
    // The agent resizes the JPEG it captures; any fraction works, but a
    // fraction below 1/20 is a thumbnail, not a mirror.
    return Math.min(1, Math.max(0.05, Math.round((opts.maxSize / longestEdge) * 100) / 100));
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
