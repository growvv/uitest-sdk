import { describe, expect, it } from "vitest";
import { createCast } from "../../src/cast/create.js";
import type { CastHost } from "../../src/cast/create.js";
import type { AgentClient } from "../../src/driver/agent/client.js";
import type { HdcRunner } from "../../src/transport/hdc.js";
import { ExtensionMissingError } from "../../src/transport/errors.js";

/** A host whose extension exists, so only an explicit choice can pick MJPEG. */
function host(over: Partial<CastHost> = {}): CastHost {
  return {
    agent: {
      async *streamScreen() {
        yield Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      },
      async stopStream() {},
    } as unknown as AgentClient,
    hdc: {} as HdcRunner,
    abi: "arm64",
    resolveCastExtension: () => "/assets/arm64/libscreen_casting.z.so",
    ...over,
  };
}

describe("createCast: explicit transports", () => {
  it("uses MJPEG when the caller asks for it, even with an extension present", async () => {
    // The spec lists mjpeg beside grpc and ws as a transport a person may
    // choose. Falling back to H.264 because an extension happens to exist
    // would ignore the request and stream something they did not ask for.
    const cast = await createCast(host(), { mode: "stream", transport: "mjpeg" });
    expect(cast.castKind).toBe("mjpeg");
    await cast.dispose();
  });

  it("refuses to record over MJPEG instead of writing nothing", async () => {
    await expect(
      createCast(host(), { mode: "record", transport: "mjpeg", outputPath: "/tmp/out.mp4" }),
    ).rejects.toThrow(ExtensionMissingError);
  });
});
