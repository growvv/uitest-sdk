/** `uitest-sdk/viewer` — the mirror-and-inspect page and the input lane. */
export { ViewerServer, startViewerServer } from "../viewer/server.js";
export type {
  ViewerServerOptions,
  ViewerSource,
  ViewerFeatures,
  ViewerClient,
  ViewerHooks,
  ViewerInputMode,
} from "../viewer/server.js";
export { createViewerSource } from "../viewer/source.js";
export type { ViewerSourceOptions } from "../viewer/source.js";
export { PLAYER_HTML, renderPlayerPage } from "../viewer/player.js";
// The window a product opens around the page. Two products need the same
// browser order and the same fallback, so it is one implementation here.
export { appWindowCommand, openWindow } from "../viewer/window.js";
export type { Browser, OpenWindowOptions, WindowCommand } from "../viewer/window.js";
export { openInput } from "../input/open.js";
export type { InputHost } from "../input/open.js";
export { AgentInputLane } from "../input/lane.js";
export type { InputLane, InputSession, InputAgent } from "../input/lane.js";
// The stop signal every product's CLI needs: a supervisor on Windows can
// only close stdin, and a product that does not hear it leaves its lease and
// its port forward behind. One implementation, exported rather than copied.
export { waitForStop } from "../viewer/lifecycle.js";
export { originAllowed } from "../viewer/origin.js";
export type { OriginContext } from "../viewer/origin.js";
export { LiveState } from "../viewer/state.js";
export type { LiveStatus, ChangeListener } from "../viewer/state.js";
export { avcC, codecString, parameterSets, splitNalUnits, toAvcc } from "../viewer/avc.js";

// The inspect panel is a core capability the console renders, so the pieces a
// third party needs to build its own panel are public here rather than buried
// in a driver module.
export { inspectScreen, renderPanel, colorFor, ROLE_COLORS } from "../driver/agent/inspector.js";
export type { InspectNode, Inspection, PanelOptions } from "../driver/agent/inspector.js";
