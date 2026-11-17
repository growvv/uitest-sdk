import type { ComponentHandle } from "../agent/components.js";
import type { On } from "../agent/selector.js";
import type { InputTextMode, Rect, WindowFilter } from "../../transport/model.js";

export type PointLike = { x: number; y: number } | readonly [number, number];

/** A point, ratio pair, rectangle, selector or an already-resolved component. */
export type Target = PointLike | Rect | On | ComponentHandle;

export type TouchMode = "normal" | "long" | "double";
export type Direction = "up" | "down" | "left" | "right";
export type Side = "left" | "right";
/** 0 = 0°, 1 = 90°, 2 = 180°, 3 = 270°. The device rejects names. */
export type Rotation = 0 | 1 | 2 | 3;
export type MouseButton = 0 | 1 | 2 | "left" | "right" | "middle";
export type ToastMatch = "equal" | "starts_with" | "ends_with" | "contains";

export interface TargetOptions {
  /** Relative position inside a component or rect; default is its center. */
  offset?: [number, number];
  /** Area that ratio coordinates are relative to. */
  area?: Target;
}

export interface ActionOptions extends TargetOptions {
  /** Pause after the action, in ms. */
  waitMs?: number;
}

export interface DragOptions extends TargetOptions {
  /** Long-press before moving, in ms. Default 1500. */
  pressMs?: number;
  durationMs?: number;
  /** Movement speed in px/s; overrides durationMs. */
  speed?: number;
}

export interface SwipeOptions {
  /** Percent of the area to travel, 1–100. Default 60. */
  distance?: number;
  area?: Target;
  /** Start from this side for horizontal swipes. */
  side?: Side;
  /** Explicit ratio start point, instead of the direction-derived one. */
  startPoint?: [number, number];
  durationMs?: number;
  steps?: number;
}

export interface PinchOptions {
  /** End distance relative to the start; 0.4 shrinks, 1.6 grows. */
  scale?: number;
  direction?: "diagonal" | "horizontal" | "vertical";
  durationMs?: number;
}

export interface FlingOptions {
  /** Percent of the area to travel, 1–100. Default 50. */
  distance?: number;
  area?: Target;
  /** Named speed or pixels per second. */
  speed?: "fast" | "normal" | "slow" | number;
}

export interface GestureOptions {
  /** Area for ratio points. Default is the whole display. */
  area?: Target;
  /** Fallback duration when a step does not carry one. */
  durationMs?: number;
  /** Fallback speed in px/s. */
  speed?: number;
}

export interface PenOptions extends GestureOptions {
  /** 0–1; defaults to 0.5. */
  pressure?: number;
}

export interface MouseClickOptions {
  button?: MouseButton;
  keys?: (number | string)[];
}

export interface ImageOptions {
  /** Template matching is implemented; SIFT needs OpenCV on the host. */
  mode?: "template" | "sift";
  /** 0–1, default 0.95. */
  similarity?: number;
  /** Restrict the search to this area. */
  area?: Target;
  /** Capture scale; default 0.5, matching `captureScreen`. */
  scale?: number;
}

export interface ImageCheckOptions extends ImageOptions {
  /** Total search time, in ms. Default 3000. */
  timeoutMs?: number;
  /** Delay between captures, in ms. Default 500. */
  pollMs?: number;
}

export interface CaptureOptions {
  /** Save to this path. Without it, a Buffer is returned. */
  savePath?: string;
  /** false writes on the device with `uitest screenCap`. Default true. */
  inPc?: boolean;
  /** Crop to this area. */
  area?: Target;
  scale?: number;
}

export interface WaitIdleOptions {
  idleMs?: number;
  timeoutMs?: number;
}

export interface WaitComponentOptions {
  timeoutMs?: number;
}

export interface DisappearOptions extends WaitComponentOptions {
  pollMs?: number;
}

export interface CheckExistOptions {
  expectExist?: boolean;
  /** Wait this long for the component. */
  waitMs?: number;
  /** Scroll this container while looking. */
  scrollTarget?: On | ComponentHandle;
}

export type ComponentPredicate = Record<string, unknown>;

export interface WindowCheck {
  title?: string;
  bundleName?: string;
}

export type HookCallback = (event: Record<string, unknown>) => void;

/** The agent surface the facade uses; `AgentClient` satisfies it. */
export interface HypiumAgent {
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
  getDisplaySize(): Promise<{ width: number; height: number }>;
  getDisplayRotation(): Promise<number>;
  captureScreen(opts?: { scale?: number }): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  triggerKey(keyCode: number): Promise<void>;
}

/** The hdc surface the facade uses; `HdcRunner` satisfies it. */
export interface HypiumHdc {
  shell(cmd: string, timeoutMs?: number): Promise<string>;
  command(args: string[], timeoutMs?: number): Promise<string>;
  push(local: string, remote: string): Promise<void>;
  pull(remote: string, local: string): Promise<void>;
}

export interface HypiumIO {
  writeFile(path: string, data: Buffer): Promise<void>;
  readFile(path: string): Promise<Buffer>;
}

export interface HypiumLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
}

export type { InputTextMode, Rect, WindowFilter };

/**
 * A host-side gesture description. It mirrors hypium's `Gesture` builder:
 * `start` presses, `moveTo` drags, `pause` holds. Points may be ratio pairs or
 * absolute display coordinates; `injectGesture` resolves them.
 */
export class Gesture {
  readonly steps: { point: PointLike; holdMs: number; moveMs?: number }[] = [];

  start(point: PointLike, holdSeconds = 0.001): this {
    this.steps.push({ point, holdMs: Math.max(1, holdSeconds * 1000) });
    return this;
  }

  moveTo(point: PointLike, durationSeconds?: number): this {
    this.steps.push({
      point,
      holdMs: 0,
      moveMs: durationSeconds === undefined ? undefined : Math.max(1, durationSeconds * 1000),
    });
    return this;
  }

  pause(seconds = 1): this {
    const last = this.steps.at(-1);
    if (!last) return this.start([0.5, 0.5], seconds);
    last.holdMs += Math.max(0, seconds * 1000);
    return this;
  }
}
