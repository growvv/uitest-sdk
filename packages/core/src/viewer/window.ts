import { spawn } from "node:child_process";

/**
 * Opens a viewer as a browser *app* window, or prints the URL.
 *
 * A tab brings the address bar, the tab strip and every other tab with it; the
 * mirror then looks like a web page rather than a device window. Edge and
 * Chrome both take `--app=<url>`, which is the cheapest window a product can
 * have without shipping a native shell (spec §6.2 defers that shell).
 *
 * It lives in core because two products need the same discovery order and the
 * same fallback; a copy in each would drift, and the product that drifted
 * would silently stop opening a window.
 */

export type Browser = "edge" | "chrome";

export interface WindowCommand {
  command: string;
  args: string[];
}

/** The console's size: a page with a node table beside the picture. */
const DEFAULT_SIZE = "1100,900";

/**
 * The command line for one browser.
 *
 * Windows paths are the default because that is where the device workbench is;
 * the macOS and Linux branches name the same binaries, since both browsers
 * install a shell wrapper there.
 */
export function appWindowCommand(
  browser: Browser,
  url: string,
  platform = process.platform,
  size = DEFAULT_SIZE,
): WindowCommand {
  const win = platform === "win32";
  if (browser === "edge") {
    return {
      command: win ? "msedge.exe" : "microsoft-edge",
      args: [`--app=${url}`, `--window-size=${size}`],
    };
  }
  return {
    command: win ? "chrome.exe" : "google-chrome",
    args: [`--app=${url}`, `--window-size=${size}`],
  };
}

export interface OpenWindowOptions {
  /** Which browser to try first. Defaults to Edge, then Chrome. */
  browser?: Browser;
  platform?: NodeJS.Platform;
  /**
   * `width,height` for `--window-size`.
   *
   * A product that mirrors a phone passes the device's aspect ratio; the
   * console keeps the default because its page is wider than it is tall.
   */
  size?: string;
  spawn?: (command: string, args: string[]) => unknown;
  print?: (line: string) => void;
}

/**
 * Tries the browsers in order and reports whether one started.
 *
 * `spawn` can throw synchronously (`ENOENT` on a bench without a browser) or
 * emit `error` afterwards; both are handled, because either one means the
 * person has to open the printed URL themselves.
 */
export function openWindow(
  url: string,
  opts: OpenWindowOptions = {},
): { opened: boolean; command?: string } {
  const platform = opts.platform ?? process.platform;
  const spawnFn =
    opts.spawn ??
    ((command: string, args: string[]) => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
      return child;
    });
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const order: Browser[] = opts.browser ? [opts.browser] : ["edge", "chrome"];

  for (const browser of order) {
    const { command, args } = appWindowCommand(browser, url, platform, opts.size);
    try {
      spawnFn(command, args);
      return { opened: true, command };
    } catch {
      // Try the next browser.
    }
  }
  print(`open ${url} in a browser (no Edge or Chrome found)`);
  return { opened: false };
}
