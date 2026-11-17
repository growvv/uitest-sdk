/**
 * `uitest-sdk/drivers` — the transport and driver layer for a product that
 * needs a wire the session does not expose, or its own driver on top of one.
 */
export { Device } from "../driver/device.js";
export type { DeviceOptions } from "../driver/device.js";
export type { ControlDriver } from "../driver/control.js";
export { AgentDriver } from "../driver/agent-driver.js";
export type { AgentDriverHost } from "../driver/agent-driver.js";
export { AgentClient, MODULE_ID, isBusyException, exceptionText } from "../driver/agent/client.js";
export type { AgentClientOptions, AgentMethod } from "../driver/agent/client.js";
export { CliRunner } from "../driver/cli.js";
export type { DumpLayoutOptions } from "../driver/cli.js";
export { HdcRunner } from "../transport/hdc.js";
export type { HdcOptions } from "../transport/hdc.js";
export { Files } from "../transport/files.js";
export type { FileEntry } from "../transport/files.js";
export { AppManager, resolveAppList } from "../transport/apps.js";
export type {
  AppInfo,
  LaunchOptions,
  LaunchResult,
  ListOptions as AppListOptions,
  ShellRunner,
} from "../transport/apps.js";
export { Gesture, HYPIIUM_CATALOG, HypiumDriver, shellQuote, splitCommand } from "../driver/hypium/index.js";
export type {
  ActionOptions,
  CaptureOptions,
  CheckExistOptions,
  ComponentPredicate,
  Direction,
  DisappearOptions,
  DragOptions,
  FlingOptions,
  HookCallback,
  HypiumAgent,
  HypiumCatalogEntry,
  HypiumCategory,
  HypiumDriverOptions,
  HypiumHdc,
  HypiumIO,
  HypiumLogger,
  HypiumStatus,
  ImageCheckOptions,
  ImageOptions,
  MouseButton,
  MouseClickOptions,
  PenOptions,
  PointLike,
  Rotation,
  Side,
  SwipeOptions,
  TargetOptions,
  TouchMode,
  WaitComponentOptions,
  WaitIdleOptions,
  WindowCheck,
} from "../driver/hypium/index.js";
