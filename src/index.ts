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

export type { SessionOptions, TapOptions, Target, TypeOptions } from "./operations/session.js";
export type { ActionResult, ActionStatus } from "./driver/agent/result.js";
export type { Screen, ScreenElement } from "./driver/agent/screen.js";
export type { PendingApproval } from "./governance/approvals.js";
export type { LeaseInfo } from "./governance/lease.js";
export type { CastSettings } from "./cast/config.js";

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
