import type { AgentClient } from "./agent/client.js";
import type { HdcRunner } from "../transport/hdc.js";
import type { InputTextMode, UiNode } from "../transport/model.js";
import type { ControlDriver } from "./control.js";

/** The part of a device this adapter needs; `Device` satisfies it. */
export interface AgentDriverHost {
  readonly deviceId?: string;
  readonly agent: Pick<
    AgentClient,
    | "hypium"
    | "captureLayout"
    | "getDisplaySize"
    | "getDisplayRotation"
    | "captureScreen"
    | "click"
    | "touchDown"
    | "touchMove"
    | "touchUp"
    | "inputText"
    | "triggerKey"
  >;
  readonly hdc?: HdcRunner;
}

/**
 * Adapts the extension protocol to `ControlDriver`.
 *
 * Every call forwards to the same `AgentClient` the session uses, so there is
 * one wire, one serial queue and one lock; this class adds names, not a
 * transport.
 */
export class AgentDriver implements ControlDriver {
  readonly kind = "agent" as const;
  private readonly host: AgentDriverHost;

  constructor(host: AgentDriverHost) {
    this.host = host;
  }

  get deviceId(): string | undefined {
    return this.host.deviceId;
  }

  get hdc(): HdcRunner | undefined {
    return this.host.hdc;
  }

  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown> {
    return this.host.agent.hypium(api, thisRef, args);
  }

  captureLayout(): Promise<UiNode> {
    return this.host.agent.captureLayout();
  }

  getDisplaySize(): Promise<{ width: number; height: number }> {
    return this.host.agent.getDisplaySize();
  }

  getDisplayRotation(): Promise<number> {
    return this.host.agent.getDisplayRotation();
  }

  captureScreen(opts: { scale?: number } = {}): Promise<Buffer> {
    return this.host.agent.captureScreen(opts);
  }

  click(x: number, y: number): Promise<void> {
    return this.host.agent.click(x, y);
  }

  touchDown(x: number, y: number): Promise<void> {
    return this.host.agent.touchDown(x, y);
  }

  touchMove(x: number, y: number): Promise<void> {
    return this.host.agent.touchMove(x, y);
  }

  touchUp(x: number, y: number): Promise<void> {
    return this.host.agent.touchUp(x, y);
  }

  inputText(x: number, y: number, text: string, mode?: InputTextMode): Promise<void> {
    return this.host.agent.inputText(x, y, text, mode);
  }

  triggerKey(code: number): Promise<void> {
    return this.host.agent.triggerKey(code);
  }
}
