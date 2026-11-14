import type { H264Chunk } from "../model.js";

export interface JpegFrame {
  data: Buffer;
  pts: number;
}

export interface CastOptions {
  mode: "stream" | "record";
  /** Overrides the abstract socket name; the only way to run casts concurrently. */
  socketName?: string;
  frameRate?: 15 | 30 | 60 | 120;
  /** Integer shrink factor. 2 -> half width/height. Values outside 1..5 are rejected. */
  scale?: 1 | 2 | 3 | 4 | 5;
  /**
   * Record mode only: where to pull the finished MP4 on `dispose()`. The
   * device-side path is hardcoded in the extension (`/data/local/tmp/mytest.mp4`)
   * and cannot be overridden.
   */
  outputPath?: string;
  bitRate?: number;
  iFrameInterval?: number;
  screenId?: number;
}

export interface CastClient {
  /** Which transport actually backs this client. Chosen explicitly, never by fallback. */
  readonly castKind: "h264" | "mjpeg";
  stream(): AsyncIterable<H264Chunk | JpegFrame>;
  requestIDRFrame(): Promise<void>;
  dispose(): Promise<void>;
}
