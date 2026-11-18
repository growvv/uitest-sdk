/** Types for the headless-browser screenshot helper, used by the acceptance runners. */
export interface CapturePageOptions {
  url: string;
  out: string;
  width?: number;
  height?: number;
  waitFor?: string;
  timeoutMs?: number;
  chromePath?: string | null;
  prepare?: (evaluate: (expression: string) => Promise<unknown>) => Promise<string[]> | string[];
}

export interface CapturePageResult {
  path: string;
  notes: string[];
}

export function chromeCandidates(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[];
export function findChrome(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string | null;
export function capturePage(opts: CapturePageOptions): Promise<CapturePageResult>;
