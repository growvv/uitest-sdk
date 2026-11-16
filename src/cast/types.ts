import type { H264Chunk } from "../model.js";

export interface JpegFrame {
  data: Buffer;
  pts: number;
}

export interface CastOptions {
  mode: "stream" | "record";
  /**
   * Which transport to use. Chosen explicitly and never inferred from what
   * happens to work: `"grpc"` needs the 6.8 extension, `"ws"` needs the 7.0
   * one, and asking for a transport whose extension is not on the device is an
   * error rather than a silent downgrade.
   *
   * Defaults to `"grpc"` — that is the build bundled in `assets/`.
   */
  transport?: "grpc" | "ws";
  /** Overrides the abstract socket name; the only way to run casts concurrently. */
  socketName?: string;
  /**
   * WebSocket transport only: the device TCP port the extension listens on
   * (`-p`). One port per concurrent cast; defaults to 5000.
   */
  port?: number;
  /**
   * WebSocket transport only: local path to the 7.0 extension. It is pushed to
   * `/data/local/tmp/<basename>` and loaded by that name, so it can sit next to
   * the bundled 6.8 build without either overwriting the other.
   *
   * Required for `transport: "ws"` — the SDK does not bundle the 7.0 build.
   */
  wsExtension?: string;
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
  /**
   * Record mode only: how long to keep recording.
   *
   * When it elapses the client disposes itself — the same path a caller takes,
   * so the muxer is closed, the file pulled and the daemon killed. Without it,
   * the caller decides when to `dispose()`; the encoder is start/stop driven
   * and writes nothing until then.
   */
  durationMs?: number;
}

export interface CastClient {
  /** Which transport actually backs this client. Chosen explicitly, never by fallback. */
  readonly castKind: "h264" | "mjpeg";
  stream(): AsyncIterable<H264Chunk | JpegFrame>;
  requestIDRFrame(): Promise<void>;
  dispose(): Promise<void>;
}
