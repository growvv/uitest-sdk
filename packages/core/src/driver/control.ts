import type { InputTextMode, UiNode } from "../transport/model.js";
import type { ShellRunner } from "../transport/apps.js";

/**
 * What a control stack has to provide to drive one device.
 *
 * The extension protocol is the only control transport this SDK talks to;
 * `HypiumDriver` is the 118-member hypium-compatible facade over the same
 * agent connection, not a second transport. A future stack implements this
 * interface and the session accepts it without knowing what is underneath.
 */
export interface ControlDriver {
  readonly kind: "agent";
  readonly deviceId?: string;
  readonly hdc?: ShellRunner;
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
  captureLayout(): Promise<UiNode>;
  getDisplaySize(): Promise<{ width: number; height: number }>;
  getDisplayRotation(): Promise<number>;
  captureScreen(opts?: { scale?: number }): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  inputText(x: number, y: number, text: string, mode?: InputTextMode): Promise<void>;
  triggerKey(code: number): Promise<void>;
  dispose?(): Promise<void>;
}
