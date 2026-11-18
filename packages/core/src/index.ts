/**
 * `uitest-sdk` — the root entry.
 *
 * Root is deliberately small: connecting and the category-shaped `Session`.
 * Everything else has a subpath (`uitest-sdk/commands`, `/cast`, `/viewer`,
 * `/govern`, `/drivers`), so the root cannot become a dumping ground and a
 * product's import makes its dependencies visible.
 */
export { connect, connectDevice, Session } from "./api.js";
export type {
  ActApi,
  CastApi,
  ConnectOptions,
  GovernApi,
  ObserveApi,
  ViewerHandle,
  ViewApi,
  WaitApi,
} from "./api.js";
export { Device } from "./driver/device.js";
export type { DeviceOptions } from "./driver/device.js";
export { tagOf } from "./transport/tag.js";
export { VERSION } from "./version.js";

// The types the documented signatures name. Without these a TypeScript
// consumer cannot annotate `observe.window()` or `act.drag` and has to reach
// into `dist/`, which the layering forbids; `type-surface.test.ts` compiles a
// fixture against the published declarations to keep the list honest.
export type {
  SessionOptions,
  TapOptions,
  Target,
  TypeOptions,
  SessionAgent,
  SessionDevice,
  InspectOptions,
  InspectResult,
  SwipeInput,
  WaitForOptions,
  ListOptions,
  ReadListResult,
  WindowFilter,
  WindowOptions,
  WindowResult,
  PinchInput,
} from "./operations/session.js";
export type { DragOptions, FlingOptions, RecordingHandle } from "./api.js";
export type { ApprovalDecision, ApprovalScope, PendingApproval } from "./governance/approvals.js";
export type { LeaseInfo } from "./governance/lease.js";
export type { CastSettings } from "./cast/config.js";
export type { H264Chunk, Rect, UiEvent } from "./transport/model.js";
export type { Point } from "./driver/agent/gestures.js";
export type { ScreenContext } from "./driver/agent/screen.js";
export type { ActionResult, ActionStatus } from "./driver/agent/result.js";
export type { Screen, ScreenElement } from "./driver/agent/screen.js";

export {
  UitestError,
  DeviceNotConnectedError,
  DeviceStateError,
  DaemonStartError,
  AgentProtocolError,
  AgentBusyError,
  AgentConnectionError,
  ExtensionMissingError,
  AppNotFoundError,
  LaunchError,
  ElementNotFoundError,
  LeaseHeldError,
  UnsupportedError,
} from "./transport/errors.js";
export type { DeviceState } from "./transport/errors.js";
