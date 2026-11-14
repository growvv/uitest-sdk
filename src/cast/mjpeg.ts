import type { AgentClient } from "../agent/client.js";
import type { CastClient, JpegFrame } from "./types.js";

/**
 * Cast path for devices without the H.264 extension (x86_64 emulator, or a
 * device whose extension failed to load). Wraps the agent's JPEG stream so
 * callers see the same `CastClient` surface.
 *
 * Frames are dirty-region driven: a static screen produces one frame and then
 * silence. That is the capture model, not a stall.
 */
export class MjpegCastClient implements CastClient {
  readonly castKind = "mjpeg" as const;
  private readonly scale: number;

  constructor(
    private readonly agent: AgentClient,
    opts: { scale?: number } = {},
  ) {
    this.scale = opts.scale ?? 0.5;
  }

  async *stream(): AsyncIterable<JpegFrame> {
    for await (const data of this.agent.streamScreen({ scale: this.scale })) {
      yield { data, pts: Date.now() };
    }
  }

  /** No keyframe concept in MJPEG; a no-op so callers need not branch. */
  async requestIDRFrame(): Promise<void> {
    return;
  }

  /** Stops the capture stream. The agent daemon itself is shared and left running. */
  async dispose(): Promise<void> {
    await this.agent.stopStream();
  }
}
