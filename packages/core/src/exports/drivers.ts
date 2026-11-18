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

// The agent layer, for a caller building its own reader or driver. These were
// root exports before 0.10; the split moved them here rather than dropping
// them, because a screen model, a selector and a gesture primitive are the
// library's core capability, not the products' convenience.
export { On, selectorText, parseOn, parseKeyName, KEY_NAMES } from "../driver/agent/selector.js";
export type { KeyName } from "../driver/agent/selector.js";
export { Screenshot } from "../driver/agent/shot.js";
export type { ShotContext, MarkBox, Rgb } from "../driver/agent/shot.js";
export { parseBounds, renderFull, renderDiff, findElement, findText, findTexts, nodesUnder, textOf, lineFor, ScreenBuilder } from "../driver/agent/screen.js";
export type { ElementRole, Diff, ScreenBuilderOptions } from "../driver/agent/screen.js";
export { Components, ComponentHandle, UiWindowHandle, resolveSelector } from "../driver/agent/components.js";
export type { HypiumSource, WaitOptions } from "../driver/agent/components.js";
export { Gestures } from "../driver/agent/gestures.js";
export type { GestureDevice, GestureOptions, GestureResult, FingerPath } from "../driver/agent/gestures.js";
export { ScreenReader, settle } from "../driver/agent/settle.js";
export type { ScreenSource, SettleOptions, SettleResult } from "../driver/agent/settle.js";
export { FrameDemux } from "../driver/agent/demux.js";
export type { DemuxHandlers } from "../driver/agent/demux.js";
export { SerialQueue } from "../driver/agent/queue.js";
export { DevicePool } from "../transport/pool.js";
export { cropRect } from "../transport/util/bounds.js";
export type { UiNode } from "../transport/model.js";
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

// The session's own halves: a product running commands through
// CommandRunner needs the types of what it passes in.
export type { SessionAgent, SessionDevice } from "../operations/session.js";
