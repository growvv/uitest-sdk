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
export class DaemonStartError extends UitestError {}
export class AgentProtocolError extends UitestError {}
export class AgentBusyError extends UitestError {}
export class AgentConnectionError extends UitestError {}
export class ExtensionMissingError extends UitestError {}
