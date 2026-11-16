export class UitestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class DeviceNotConnectedError extends UitestError {}
/**
 * The device is attached (or expected) but not usable without a person:
 * locked, not yet authorized for debugging, or offline. `state` is the
 * agent-facing word for it, the same one a command result carries.
 */
export type DeviceState = "device_locked" | "device_needs_setup" | "device_offline";
export class DeviceStateError extends DeviceNotConnectedError {
  constructor(
    readonly state: DeviceState,
    message: string,
    code: string,
    cause?: unknown,
  ) {
    super(message, code, cause);
  }
}
export class DaemonStartError extends UitestError {}
export class AgentProtocolError extends UitestError {}
export class AgentBusyError extends UitestError {}
export class AgentConnectionError extends UitestError {}
export class ExtensionMissingError extends UitestError {}
/** The bundle is not installed, or a short name matches more than one bundle. */
export class AppNotFoundError extends UitestError {}
/** `aa start` reported a failure, or no entry ability could be resolved. */
export class LaunchError extends UitestError {}
/** A ref or selector matched nothing on the current screen. */
export class ElementNotFoundError extends UitestError {}
/** Another task holds the device lease. */
export class LeaseHeldError extends UitestError {}
/** The device or host cannot serve this API, and no fallback is offered. */
export class UnsupportedError extends UitestError {}
