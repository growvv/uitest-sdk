import { H264CastClient } from "./client.js";
import { WsCastClient } from "./ws-client.js";
import { MjpegCastClient } from "./mjpeg.js";
import { CASTING_EXTENSION } from "./resolve.js";
import type { AgentClient } from "../driver/agent/client.js";
import type { HdcRunner } from "../transport/hdc.js";
import { ExtensionMissingError } from "../transport/errors.js";
import type { CastClient, CastOptions } from "./types.js";

/** The part of a connected device a cast needs; `Device` satisfies it. */
export interface CastHost {
  readonly agent: AgentClient;
  readonly hdc: HdcRunner;
  readonly abi: "arm64" | "x86_64";
  resolveCastExtension(): string | null;
}

/**
 * Chooses the cast transport explicitly: H.264 where an extension exists,
 * MJPEG where it cannot (x86_64 has no build) or where the caller asked for
 * it. The choice is reported through `castKind`; it is never a silent
 * downgrade after a failure, and a transport the caller named is never
 * replaced by another.
 *
 * `transport: "ws"` picks the 7.0 WebSocket build and requires `wsExtension`;
 * `transport: "mjpeg"` skips the extension and wraps the agent's JPEG stream;
 * anything else uses the bundled 6.8 gRPC build. The two extension builds can
 * coexist on the device because `--extension-name` is a filename lookup.
 */
export async function createCast(host: CastHost, opts: CastOptions): Promise<CastClient> {
  if (opts.transport === "mjpeg") {
    // MJPEG is a stream wrapper with no recorder behind it. Handing back a
    // client that silently records nothing is the fallback this SDK forbids.
    if (opts.mode === "record") {
      throw new ExtensionMissingError(
        "record mode needs an H.264 extension; mjpeg cannot record",
        "ENOCAST",
      );
    }
    return new MjpegCastClient(host.agent, { scale: opts.scale });
  }
  if (opts.transport === "ws") {
    if (host.abi === "x86_64") {
      throw new ExtensionMissingError(
        `the 7.0 casting extension has no ${host.abi} build`,
        "ENOCAST",
      );
    }
    return WsCastClient.start(host.hdc, opts);
  }
  if (host.resolveCastExtension() !== null) {
    return H264CastClient.start(host.hdc, opts);
  }
  // MJPEG is a stream wrapper with no recorder behind it. Handing back a
  // client that silently records nothing is the fallback this SDK forbids.
  if (opts.mode === "record") {
    throw new ExtensionMissingError(
      `record mode needs ${CASTING_EXTENSION}, which has no ${host.abi} build`,
      "ENOCAST",
    );
  }
  return new MjpegCastClient(host.agent, { scale: opts.scale });
}
