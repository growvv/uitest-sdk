import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Opens a viewer as a browser *app* window, or prints the URL.
 *
 * A tab brings the address bar, the tab strip and every other tab with it; the
 * mirror then looks like a web page rather than a device window. Edge and
 * Chrome both take `--app=<url>`, which is the cheapest window a product can
 * have without shipping a native shell (spec §6.2 defers that shell).
 *
 * It lives in core because every product needs the same discovery order and the
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
  profile?: string,
): WindowCommand {
  const win = platform === "win32";
  // A profile of its own makes this process *the* window instead of a message
  // to one that is already running: without it the launcher hands the URL to
  // the existing browser and exits in tens of milliseconds, so a product that
  // treats the process's exit as "the window closed" stops at once.
  const ownProfile = profile
    ? [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"]
    : [];
  if (browser === "edge") {
    return {
      command: win ? "msedge.exe" : "microsoft-edge",
      args: [`--app=${url}`, `--window-size=${size}`, ...ownProfile],
    };
  }
  return {
    command: win ? "chrome.exe" : "google-chrome",
    args: [`--app=${url}`, `--window-size=${size}`, ...ownProfile],
  };
}

export interface OpenWindowOptions {
  /** Which browser to try first. Defaults to Edge, then Chrome. */
  browser?: Browser;
  platform?: NodeJS.Platform;
  /** `exists` is injected by the tests; production asks the filesystem. */
  exists?: (path: string) => boolean;
  /**
   * `width,height` for `--window-size`.
   *
   * A product that mirrors a phone passes the device's aspect ratio; the
   * console keeps the default because its page is wider than it is tall.
   */
  size?: string;
  /**
   * Called when the window the browser opened goes away.
   *
   * The child is detached and unref'd, so nothing else observes its exit. A
   * product that holds the device for the window's lifetime — the mirror does
   * — has to know: closing the window is how a person says they are done with
   * the phone. For this to mean anything the window must have a profile of its
   * own (`profile: true`); a window that joined an existing browser exits as
   * soon as it has handed the URL over.
   */
  onClose?: () => void;
  /**
   * Run the window in a profile of its own, one per call.
   *
   * Costs a cold browser start (no shared cache, no signed-in profile) and is
   * the only way the launched process stays alive as long as the window does.
   * Products that just need a page to appear leave it off.
   */
  profile?: boolean;
  spawn?: (command: string, args: string[]) => unknown;
  print?: (line: string) => void;
  /** Kills a browser this call started; injected by the tests. */
  kill?: (pid: number) => void;
  /** Removes a profile directory; injected by the tests. */
  removeDir?: (dir: string) => void | Promise<void>;
  /** How long to wait between removal attempts; injected by the tests. */
  wait?: (ms: number) => Promise<void>;
  /**
   * Creates the profile directory; injected by the tests.
   *
   * The real one is `mkdtemp` under the temp directory, which touches the
   * disk. A test that asserts *which* directory is removed should not leave a
   * real one behind for every run.
   */
  makeProfile?: () => string;
}

/** What `openWindow` reports: the window, and a way to close it. */
export interface OpenWindowResult {
  opened: boolean;
  command?: string;
  /**
   * Ends the window this call opened.
   *
   * A mirror that stops for any reason other than the window — stdin closed,
   * SIGINT — otherwise leaves a window pointing at a server that is gone.
   * Absent when no window opened.
   *
   * It resolves once the window's profile directory is gone, so a product
   * that awaits it does not exit mid-cleanup. See `removeWindowProfile`.
   */
  close?: () => Promise<void>;
}

/**
 * Deletes a window's profile directory, retrying while the browser lets go.
 *
 * Measured on Windows: an Edge profile whose process was just killed refuses
 * `rmSync` with EPERM for roughly 590 ms while the browser finishes writing.
 * The first version retried on a `setTimeout(...).unref()`, and an unref'd
 * timer does not hold the event loop — the product finished closing in 684 ms
 * and exited before the retry ran, so every mirror stop left its directory
 * behind. One per run at 20-760 MB filled the machine's disk.
 *
 * `remove` is the raw attempt (it throws); `wait` is injected by the tests.
 */
export async function removeWindowProfile(
  dir: string,
  remove: (dir: string) => void = (d) => rmSync(d, { recursive: true, force: true }),
  opts: { wait?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 4;
  // Not unref'd: the caller awaits this, and the wait is the only thing
  // keeping the process alive until the directory is really gone.
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      remove(dir);
      return;
    } catch {
      // Still shutting down; try again in a moment.
      if (i < attempts - 1) await wait(300 * (i + 1));
    }
  }
  // Left behind; the OS temp cleaner is the backstop.
}

/**
 * Where the two browsers install on Windows.
 *
 * A bare `msedge.exe` is not on PATH on a normal Windows install: `spawn`
 * reports `ENOENT` asynchronously, so a product that trusted the name opened
 * no window at all — and, until this list existed, exited the moment it
 * started because the failed launch looked like a closed window.
 */
function installedBrowsers(browser: Browser, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [];
  // The environment gives backslashes; the rest of this file writes forward
  // slashes, and a mixed path is one the existence check cannot match.
  const dir = (p: string | undefined, fallback: string): string =>
    (p ?? fallback).replace(/\\/g, "/");
  const pf = dir(process.env["ProgramFiles"], "C:/Program Files");
  const pf86 = dir(process.env["ProgramFiles(x86)"], "C:/Program Files (x86)");
  const local = process.env["LOCALAPPDATA"]?.replace(/\\/g, "/");
  if (browser === "edge") {
    return [
      `${pf86}/Microsoft/Edge/Application/msedge.exe`,
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
    ];
  }
  return [
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Google/Chrome/Application/chrome.exe`,
    ...(local ? [`${local}/Google/Chrome/Application/chrome.exe`] : []),
  ];
}

/** The first installed copy, or the bare name so PATH can still be tried. */
export function resolveBrowserPath(
  browser: Browser,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const installed = installedBrowsers(browser, platform).find((p) => exists(p));
  return installed ?? appWindowCommand(browser, "", platform).command;
}

/**
 * Reports `onClose` once the browser process really ran and then went away.
 *
 * The `close` event alone is not that: a launch that fails emits `error`
 * first and then `close` with a negative exit code, and counting it as a
 * closed window made `uitest-mirror` treat "Edge is not installed" as "the
 * person is done with the phone". Only a child that emitted `spawn` — Node's
 * signal that the process exists — can close a window.
 */
function watchClose(
  child: { on(event: string, listener: (...args: never[]) => void): unknown } | undefined,
  onClose: (() => void) | undefined,
  onFailed: (() => void) | undefined,
  onGone?: () => void,
): void {
  if (!child || typeof child.on !== "function") return;
  let launched = false;
  let told = false;
  let cleaned = false;
  const clean = (): void => {
    if (cleaned) return;
    cleaned = true;
    onGone?.();
  };
  const tell = (): void => {
    // The profile directory goes whenever the browser process does — a real
    // close, or a launch that never happened — so no directory outlives the
    // window it belonged to.
    clean();
    if (!launched || told) return;
    told = true;
    onClose?.();
  };
  child.on("spawn", () => {
    launched = true;
  });
  child.on("error", () => {
    if (!launched) onFailed?.();
  });
  // `exit` and `close` both fire for a normal browser shutdown; `close` also
  // covers the case where the process is reaped by someone else. Only one
  // call reaches `onClose`.
  child.on("close", tell);
  child.on("exit", tell);
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
): OpenWindowResult {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const kill = opts.kill ?? ((pid: number) => process.kill(pid));
  const spawnFn =
    opts.spawn ??
    ((command: string, args: string[]) => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.unref();
      return child;
    });
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const wait =
    opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The tests inject `removeDir` (they assert the directory is named); in
  // production it is the retrying removal, because a single `rmSync` right
  // after the kill loses the race with the browser's shutdown.
  const removeDir = opts.removeDir ?? ((dir: string) => removeWindowProfile(dir, undefined, { wait }));
  const order: Browser[] = opts.browser ? [opts.browser] : ["edge", "chrome"];
  // One directory per window, so a second mirror never joins the first one's
  // browser — and so the process this call spawned is the one that owns the
  // window. The `mkdtemp` suffix is what keeps two calls from colliding.
  const makeProfile = opts.makeProfile ?? (() => mkdtempSync(join(tmpdir(), "uitest-window-")));
  const profile = opts.profile ? makeProfile() : undefined;

  for (const browser of order) {
    const { command, args } = appWindowCommand(browser, url, platform, opts.size, profile);
    const exe = resolveBrowserPath(browser, platform, exists);
    try {
      const child = spawnFn(exe, args) as Parameters<typeof watchClose>[0] & { pid?: number };
      // The directory is per-window, so it is removed once and by whichever
      // path gets there first: the browser exiting, or the product closing it.
      let removed = false;
      let removing: Promise<void> | undefined;
      const removeProfile = (): Promise<void> => {
        if (!profile || removed) return removing ?? Promise.resolve();
        removed = true;
        removing = Promise.resolve(removeDir(profile)).catch(() => undefined);
        return removing;
      };
      watchClose(
        child,
        opts.onClose,
        () => print(`open ${url} in a browser (${exe} did not start)`),
        () => void removeProfile(),
      );
      const pid = child?.pid;
      return {
        opened: true,
        command: exe,
        ...(typeof pid === "number"
          ? {
              close: async () => {
                try {
                  kill(pid);
                } catch {
                  // Already gone.
                }
                await removeProfile();
              },
            }
          : {}),
      };
    } catch {
      // Try the next browser.
    }
  }
  print(`open ${url} in a browser (no Edge or Chrome found)`);
  return { opened: false };
}
