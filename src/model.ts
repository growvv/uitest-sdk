export interface UiNode {
  attributes: Record<string, string>;
  /**
   * Child nodes. Absent on leaves: the device omits the key rather than sending
   * an empty array, which is why every walk over the tree reads
   * `node.children ?? []`.
   */
  children?: UiNode[];
}

export interface UiEvent {
  type: string;
  [key: string]: unknown;
}

export interface H264Chunk {
  data: Buffer;
  pts: number;
  flags: number;
  isKeyFrame: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window predicate as the extension accepts it. */
export interface WindowFilter {
  title?: string;
  bundleName?: string;
  focused?: boolean;
  actived?: boolean;
}

/** Text input options for the device's IME path. */
export interface InputTextMode {
  /** Use the clipboard once instead of typing character by character. */
  paste?: boolean;
  /** Append to the existing text instead of replacing it. */
  addition?: boolean;
}
