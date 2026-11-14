export { Device } from "./device.js";
export type { DeviceOptions } from "./device.js";

export { AgentClient, MODULE_ID, isBusyException } from "./agent/client.js";
export type { AgentClientOptions, AgentMethod } from "./agent/client.js";
export { FrameDemux } from "./agent/demux.js";
export type { DemuxHandlers } from "./agent/demux.js";
export { SerialQueue } from "./agent/queue.js";

export { HdcRunner } from "./hdc.js";
export type { HdcOptions } from "./hdc.js";

export { CliRunner } from "./cli.js";
export type { DumpLayoutOptions } from "./cli.js";

export { H264CastClient, loadScrcpyService } from "./cast/client.js";
export { MjpegCastClient } from "./cast/mjpeg.js";
export { resolveCastingExtension, CASTING_EXTENSION } from "./cast/resolve.js";
export type { CastClient, CastOptions, JpegFrame } from "./cast/types.js";

export { parseBounds, cropRect } from "./util/bounds.js";
export type { H264Chunk, Rect, UiEvent, UiNode } from "./model.js";

export {
  UitestError,
  DeviceNotConnectedError,
  DaemonStartError,
  AgentProtocolError,
  AgentBusyError,
  AgentConnectionError,
  ExtensionMissingError,
} from "./errors.js";
