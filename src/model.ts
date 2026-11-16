export interface UiNode {
  attributes: Record<string, string>;
  children: UiNode[];
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
