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
