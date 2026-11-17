import { Gestures } from "../agent/gestures.js";
import type { InputTextMode } from "../model.js";

/**
 * The input side of a device, as `LiveInput` needs it.
 *
 * Deliberately narrow: every method is one gesture or one key/text injection.
 * The live server keeps this on a second agent connection so an input never
 * waits behind a layout read on the read connection.
 */
export interface InputLane {
  click(x: number, y: number): Promise<void>;
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  key(keyCode: number): Promise<void>;
  text(x: number, y: number, text: string, mode: "typing" | "paste"): Promise<void>;
  /** One two-finger segment: a complete matrix gesture from `from` to `to`. */
  pinch(cx: number, cy: number, from: number, to: number, durationMs: number): Promise<void>;
  scroll(x: number, y: number, down: boolean, steps: number): Promise<void>;
}

/** A lane plus the forward it owns. Closing releases both. */
export interface InputSession {
  lane: InputLane;
  close(): Promise<void>;
}

/**
 * The subset of `AgentClient` this module uses. Keeping it structural means
 * tests can record calls without a socket, and `AgentClient` needs no change.
 */
export interface InputAgent {
  click(x: number, y: number): Promise<void>;
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  triggerKey(keyCode: number): Promise<void>;
  inputText(x: number, y: number, text: string, mode?: InputTextMode): Promise<void>;
  hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
}

const round = (n: number): number => Math.round(n);

/**
 * Translates `InputLane` calls into the agent protocol.
 *
 * No policy lives here: deciding what a pointer sequence means, when to flush
 * text and when to lift a stuck pointer is `LiveInput`'s job. Pinch is the one
 * exception the device forces — it accepts a precomputed matrix, not two
 * streamed pointers — so each lane call is one complete segment.
 */
export class AgentInputLane implements InputLane {
  private readonly gestures: Gestures;

  constructor(private readonly agent: InputAgent) {
    this.gestures = new Gestures(agent);
  }

  click(x: number, y: number): Promise<void> {
    return this.agent.click(round(x), round(y));
  }

  touchDown(x: number, y: number): Promise<void> {
    return this.agent.touchDown(round(x), round(y));
  }

  touchMove(x: number, y: number): Promise<void> {
    return this.agent.touchMove(round(x), round(y));
  }

  touchUp(x: number, y: number): Promise<void> {
    return this.agent.touchUp(round(x), round(y));
  }

  key(keyCode: number): Promise<void> {
    return this.agent.triggerKey(keyCode);
  }

  async text(
    x: number,
    y: number,
    text: string,
    mode: "typing" | "paste",
  ): Promise<void> {
    await this.agent.inputText(
      round(x),
      round(y),
      text,
      mode === "paste" ? { paste: true, addition: true } : { addition: true },
    );
  }

  async pinch(
    cx: number,
    cy: number,
    from: number,
    to: number,
    durationMs: number,
  ): Promise<void> {
    await this.gestures.multiTouch(
      [
        { from: { x: cx - from, y: cy }, to: { x: cx - to, y: cy } },
        { from: { x: cx + from, y: cy }, to: { x: cx + to, y: cy } },
      ],
      // The default step count is derived from the duration and produces 30+
      // setPoint round trips per segment (548 ms measured). Six points keep a
      // segment near 50-100 ms, which is what makes continuous zoom usable.
      { durationMs, steps: 6 },
    );
  }

  async scroll(x: number, y: number, down: boolean, steps: number): Promise<void> {
    await this.agent.hypium("Driver.mouseScroll", "Driver#0", [
      { x: round(x), y: round(y) },
      down,
      steps,
    ]);
  }
}
