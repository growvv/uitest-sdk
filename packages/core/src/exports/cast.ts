/** `uitest-sdk/cast` — screen streaming and recording, without a viewer. */
export { createCast } from "../cast/create.js";
export type { CastHost } from "../cast/create.js";
export type { CastClient, CastOptions, JpegFrame } from "../cast/types.js";
// The frame a `stream()` yields: a consumer writing its own sink names it.
export type { H264Chunk } from "../transport/model.js";
export { CastConfig, castConfigPath } from "../cast/config.js";
export type { CastSettings } from "../cast/config.js";
export { Recording } from "../cast/record.js";
export type { RecordingOptions } from "../cast/record.js";
export { FpsMeter } from "../cast/fps.js";
export type { FpsStats, FpsMeterOptions } from "../cast/fps.js";
export { resolveCastingExtension, CASTING_EXTENSION } from "../cast/resolve.js";
export { H264CastClient, loadScrcpyService } from "../cast/client.js";
export { WsCastClient } from "../cast/ws-client.js";
export { MjpegCastClient } from "../cast/mjpeg.js";
// The WebSocket framing and NAL helpers: a third-party transport or an
// inspection tool needs them, and they are the reason the ws client needs no
// gRPC runtime.
export {
  buildHandshake,
  handshakeStatus,
  encodeTextFrame,
  encodeCloseFrame,
  encodePongFrame,
  decodeFrames,
  nalTypes,
  isKeyFrame,
} from "../cast/ws.js";
export type { WsFrame } from "../cast/ws.js";
