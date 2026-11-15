export { Device } from "./device.js";
export type { DeviceOptions } from "./device.js";

export { AgentClient, MODULE_ID, isBusyException, exceptionText } from "./agent/client.js";
export type { AgentClientOptions, AgentMethod } from "./agent/client.js";
export { FrameDemux } from "./agent/demux.js";
export type { DemuxHandlers } from "./agent/demux.js";
export { SerialQueue } from "./agent/queue.js";

// Agent-facing layer: screen model, actions, results.
export {
  ScreenBuilder,
  renderFull,
  renderDiff,
  nodesUnder,
  findElement,
  findText,
  findTexts,
  textOf,
  lineFor,
} from "./agent/screen.js";
export type { Screen, ScreenElement, ScreenContext, Diff, ElementRole } from "./agent/screen.js";
export { EXIT_CODE, statusOf, isOk, actionText } from "./agent/result.js";
export type { ActionResult, ActionStatus } from "./agent/result.js";
export { ScreenReader, settle } from "./agent/settle.js";
export type { ScreenSource, SettleOptions, SettleResult } from "./agent/settle.js";
export { Screenshot } from "./agent/shot.js";
export type { ShotContext } from "./agent/shot.js";
export { On, selectorText, parseOn, parseKeyName, KEY_NAMES } from "./agent/selector.js";
export type { KeyName } from "./agent/selector.js";
export { Components, ComponentHandle, UiWindowHandle, resolveSelector } from "./agent/components.js";
export type { HypiumSource, WaitOptions } from "./agent/components.js";
export { Gestures } from "./agent/gestures.js";
export type {
  GestureDevice,
  GestureOptions,
  GestureResult,
  PinchOptions,
  FingerPath,
  Point,
} from "./agent/gestures.js";

// Session and its supporting pieces.
export { Session } from "./session.js";
export type {
  SessionAgent,
  SessionDevice,
  SessionOptions,
  Target,
  TapOptions,
  TypeOptions,
  SwipeInput,
  WaitForOptions,
  ListOptions,
  ReadListResult,
  PinchInput,
  WindowFilter,
  WindowOptions,
  WindowResult,
} from "./session.js";
export { AppManager } from "./apps.js";
export type { AppInfo, LaunchOptions, LaunchResult, ListOptions as AppListOptions, ShellRunner } from "./apps.js";
export { Policy, DEFAULT_CONFIRM, POLICY_WORDS, SYSTEM_CHROME } from "./policy.js";
export type { PolicyOptions, PolicyCheck, Decision, Rule, ConfirmRule } from "./policy.js";
export { Approvals } from "./approvals.js";
export type { ApprovalOptions, PendingApproval, StepIdentity, ConsumeResult } from "./approvals.js";
export { Lease, readLease } from "./lease.js";
export type { LeaseInfo, LeaseOptions } from "./lease.js";
export { TraceRecorder, deviceTag } from "./trace.js";
export type { TraceEntry, TraceRecord, TraceOptions, TaskReportResult } from "./trace.js";
export { doctor, renderDoctor, deviceTagOf } from "./doctor.js";
export type { DoctorReport, Capabilities, TargetLister } from "./doctor.js";

// Agent front ends: one command surface shared by the CLI and MCP.
export { COMMANDS, CommandRunner } from "./commands.js";
export type { CommandSpec, ArgType, RunnerOptions, RunResult } from "./commands.js";
export { parseArgv, formatHelp, formatResult, runCommand, main } from "./cli-main.js";
export type { ParsedArgv } from "./cli-main.js";
export { McpServer, toolDefinitions, toolName } from "./mcp.js";
export type { ToolDefinition, ToolRunner } from "./mcp.js";
export { installSkill, skillFiles, defaultSkillDirs } from "./install-skill.js";
export { VERSION } from "./version.js";
export type { SkillFile, InstallSkillOptions, InstallSkillResult } from "./install-skill.js";
export { agentTarget, connectAgent, agentConnected, mcpEntry } from "./connect.js";
export type { AgentId, AgentTarget, ConnectAgentOptions, ConnectAgentResult, McpEntryOptions } from "./connect.js";
export { registerJsonMcp, registerTomlMcp, isMcpRegistered } from "./mcp-register.js";
export type { McpEntry, RegisterMcpOptions, RegisterMcpResult } from "./mcp-register.js";
export { holdDevice, resumeDevice, readHold, resolveTag, HOLD_TASK } from "./hold.js";
export type { HoldOptions, HoldResult } from "./hold.js";
export { DevicePool } from "./pool.js";

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
  AppNotFoundError,
  LaunchError,
  ElementNotFoundError,
  LeaseHeldError,
} from "./errors.js";
