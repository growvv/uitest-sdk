import { join } from "node:path";
import { connect, tagOf } from "uitest-sdk";
import type { ConnectOptions } from "uitest-sdk";
import { LeaseHeldError, UitestError } from "uitest-sdk";
import { createViewerSource, openInput, openWindow, renderPlayerPage, startViewerServer } from "uitest-sdk/viewer";
import { waitForStop } from "uitest-sdk/viewer";
import type { ViewerServer, ViewerSource } from "uitest-sdk/viewer";
import { VERSION } from "./version.js";

/**
 * `uitest-mirror` — a HarmonyOS scrcpy.
 *
 * One command opens a device window you can drive with a mouse and keyboard,
 * optionally recording. It is deliberately smaller than `uitest-console`: no
 * node table, no takeover button, no approval inbox. Input goes straight to
 * the phone because that is what the person opened it for.
 *
 * The command line follows scrcpy's names (`--serial`, `--max-fps`,
 * `--max-size`) rather than the console's, because the people who reach for
 * this tool already know them. The parser is hand-written: `parseArgv` files
 * `--device` under a separate bucket and a missed merge once pointed a
 * two-device run at the wrong phone.
 */

export type Transport = "grpc" | "ws" | "mjpeg";
export type FrameRate = 15 | 30 | 60 | 120;

export interface MirrorOptions {
  serial?: string;
  transport: Transport;
  frameRate: FrameRate;
  bitRate?: number;
  maxSize?: number;
  record?: string;
  control: boolean;
  stayAwake: boolean;
  windowTitle: string;
  port: number;
  stateDir: string;
  wsExtension?: string;
}

/** The flags this product accepts. Anything else is a mistake, not a global. */
const FLAGS = new Set([
  "serial",
  "transport",
  "max-fps",
  "bit-rate",
  "max-size",
  "record",
  "no-control",
  "stay-awake",
  "window-title",
  "port",
  "state-dir",
  "ws-extension",
]);

const TRANSPORTS: Transport[] = ["grpc", "ws", "mjpeg"];
const FRAME_RATES: FrameRate[] = [15, 30, 60, 120];

/** `--max-fps` arrives as `maxFps` from one caller and `max-fps` from another. */
function pick(args: Record<string, string | boolean | string[]>, name: string): string | boolean | string[] | undefined {
  if (name in args) return args[name];
  const camel = name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return args[camel];
}

function str(args: Record<string, string | boolean | string[]>, name: string): string | undefined {
  const raw = pick(args, name);
  if (raw === undefined || raw === true) return undefined;
  return Array.isArray(raw) ? raw[0] : String(raw);
}

function num(args: Record<string, string | boolean | string[]>, name: string): number | undefined {
  const raw = str(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UitestError(`--${name} must be a number, got "${raw}"`, "EBADARG");
  }
  return value;
}

/**
 * Reads the command line, rejecting anything it cannot honour.
 *
 * A flag it does not know is an error rather than a shrug: someone typing
 * `--device` came from the console and would otherwise watch mirror open
 * whichever phone was attached, believing they had named one.
 */
export function mirrorOptions(args: Record<string, string | boolean | string[]>): MirrorOptions {
  for (const key of Object.keys(args)) {
    const kebab = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (!FLAGS.has(kebab)) {
      throw new UitestError(
        `unknown flag --${kebab}: ` +
          `uitest-mirror takes ${[...FLAGS].map((f) => `--${f}`).join(", ")}`,
        "EBADARG",
      );
    }
  }

  const transportRaw = str(args, "transport") ?? "grpc";
  if (!TRANSPORTS.includes(transportRaw as Transport)) {
    throw new UitestError(`--transport takes grpc, ws or mjpeg, got "${transportRaw}"`, "EBADARG");
  }

  const fpsRaw = str(args, "max-fps") ?? "30";
  const frameRate = Number(fpsRaw);
  if (!FRAME_RATES.includes(frameRate as FrameRate)) {
    // Not rounded to the nearest accepted value: the extension answers an
    // unknown rate by silently following the display refresh, which is 60 fps
    // on these phones — a person who asked for 45 would believe they got it.
    throw new UitestError(
      `--max-fps must be 15, 30, 60 or 120, got "${fpsRaw}"`,
      "EBADARG",
    );
  }

  const port = num(args, "port") ?? 0;
  if (port < 0 || port > 65_535) {
    throw new UitestError(`--port must be 0..65535, got ${port}`, "EBADARG");
  }

  const maxSize = num(args, "max-size");
  if (maxSize !== undefined && maxSize <= 0) {
    throw new UitestError(`--max-size must be positive, got ${maxSize}`, "EBADARG");
  }
  const bitRate = num(args, "bit-rate");
  if (bitRate !== undefined && bitRate <= 0) {
    throw new UitestError(`--bit-rate must be positive, got ${bitRate}`, "EBADARG");
  }

  return {
    ...(str(args, "serial") ? { serial: str(args, "serial")! } : {}),
    transport: transportRaw as Transport,
    frameRate: frameRate as FrameRate,
    ...(bitRate !== undefined ? { bitRate } : {}),
    ...(maxSize !== undefined ? { maxSize } : {}),
    ...(str(args, "record") ? { record: str(args, "record")! } : {}),
    control: pick(args, "no-control") !== true,
    stayAwake: pick(args, "stay-awake") === true,
    windowTitle: str(args, "window-title") ?? "uitest-mirror",
    port,
    stateDir: str(args, "state-dir") ?? ".uitest-phone",
    ...(str(args, "ws-extension") ? { wsExtension: str(args, "ws-extension")! } : {}),
  };
}

/**
 * The window size for a device, at a fixed height.
 *
 * A 1260x2720 phone in a 1100x900 window is a small picture with black bars on
 * both sides. Rounding the width to 100 keeps the window size stable across
 * devices that differ by a few pixels.
 */
export function windowSizeFor(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "400,900";
  const ideal = Math.round(((900 * width) / height) / 100) * 100;
  // The floor is 300, not 500: a 9:20 phone at 900 high is 405 wide, and a
  // 500 floor would letterbox every phone this tool is for. 300 still stops a
  // sliver on something absurdly tall.
  return `${Math.min(1400, Math.max(300, ideal))},900`;
}

export interface MirrorRun {
  url: string;
  port: number;
  /** The device's 8-character hash, the only identifier ever printed. */
  tag: string;
  /**
   * Resolves when the window the product opened goes away.
   *
   * Never resolves when no window opened (a bench without Edge or Chrome), so
   * a caller waits on this *and* the stop signals rather than instead of them.
   */
  windowClosed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the device and the page, resolving once it is listening.
 *
 * Split from `mirrorMain` so a test can drive the wiring without a browser and
 * without owning the process's signals.
 */
export async function startMirror(
  opts: MirrorOptions,
  open: (o: ConnectOptions) => Promise<Awaited<ReturnType<typeof connect>>> = connect,
  window: typeof openWindow = openWindow,
): Promise<MirrorRun> {
  // A lease, unlike the console: the person is driving the phone, and an agent
  // that keeps working would fight them for every gesture.
  const session = await open({
    ...(opts.serial ? { deviceId: opts.serial } : {}),
    stateDir: opts.stateDir,
    task: "mirror",
    // The lease is the default and is what makes this product safe: an agent
    // and a person cannot interleave gestures on one phone.
  });

  let awake: { restore(): Promise<void> } | null = null;
  let server: ViewerServer | null = null;
  let markWindowClosed: () => void = () => undefined;
  const windowClosed = new Promise<void>((resolve) => (markWindowClosed = resolve));
  try {
    if (opts.stayAwake) awake = await session.keepAwake(3600);

    const source: ViewerSource = createViewerSource(session.core, session.device, {
      stateDir: opts.stateDir,
      // No node table: this product is a picture with a keyboard, and reading
      // the layout on every frame would cost the device work nobody asked for.
      layout: false,
      cast: {
        transport: opts.transport,
        frameRate: opts.frameRate,
        ...(opts.bitRate !== undefined ? { bitRate: opts.bitRate } : {}),
        ...(opts.maxSize !== undefined ? { maxSize: opts.maxSize } : {}),
        ...(opts.wsExtension ? { wsExtension: opts.wsExtension } : {}),
      },
      ...(opts.record ? { recordPath: opts.record } : {}),
    });

    server = await startViewerServer({
      port: opts.port,
      host: "127.0.0.1",
      // Nothing to mask: no layout is read, so there are no labels to hide.
      privacy: false,
      source,
      features: {
        inspect: false,
        capture: false,
        record: true,
        control: opts.control,
        privacy: false,
      },
      input: {
        // `always`, not `takeover`: a mirror has one person in front of it, and
        // a button to press before the mouse works is friction with no one to
        // arbitrate against.
        mode: opts.control ? "always" : "off",
        open: () => openInput(session.device),
        // The lease, checked before every gesture that starts. A person who
        // runs `uitest-phone hold` owns the phone from that moment; without
        // this the mirror would keep sending their clicks to it, which is the
        // exact interleaving the lease exists to prevent.
        guard: () => session.core.assertLease(),
      },
      recordOnStart: Boolean(opts.record),
      page: renderPlayerPage({ title: opts.windowTitle }),
    });

    const url = `http://127.0.0.1:${server.port}/`;
    const { width, height } = await session.device.agent.getDisplaySize();
    // A profile of its own is what makes this process the window: without it
    // the browser hands the URL to a running instance and exits at once, and
    // the run would stop the moment it started.
    const opened = window(url, {
      size: windowSizeFor(width, height),
      onClose: markWindowClosed,
      profile: true,
    });
    const closeWindow = (opened as { close?: () => Promise<void> }).close;

    const started = server;
    let closed = false;
    return {
      url,
      port: started.port,
      tag: tagOf(session.device.deviceId),
      windowClosed,
      async close() {
        if (closed) return;
        closed = true;
        await started.close();
        // Stopping for any reason other than the window — stdin, Ctrl+C —
        // must not leave it showing a page whose server is gone. Awaited: the
        // window's profile directory is 20-760 MB, and the process must not
        // exit while the browser still refuses to let it go.
        await closeWindow?.();
        if (awake) await awake.restore().catch(() => undefined);
        await session.close();
      },
    };
  } catch (e) {
    // A port already in use, a cast that will not start, or a busy agent: a
    // server that was already listening keeps its cast daemon and its fport on
    // the device, so it is closed before the session that owns them.
    if (server) await server.close().catch(() => undefined);
    if (awake) await awake.restore().catch(() => undefined);
    await session.close().catch(() => undefined);
    throw e;
  }
}


const HELP = `usage: uitest-mirror [--serial id] [--transport grpc|ws|mjpeg] [--max-fps 15|30|60|120]
                     [--bit-rate N] [--max-size N] [--record file.mp4]
                     [--no-control] [--stay-awake] [--window-title text]
                     [--port 0] [--state-dir dir] [--ws-extension path]

Opens the device in its own browser window. Mouse and keyboard go to the phone.
Stops when the window closes, stdin closes, or on SIGINT/SIGTERM.
`;

export async function mirrorMain(
  argv: string[],
  deps: {
    stdin?: { resume(): void; on(event: string, listener: () => void): unknown };
    signals?: { once(event: string, listener: () => void): unknown };
    open?: (o: ConnectOptions) => Promise<Awaited<ReturnType<typeof connect>>>;
    window?: typeof openWindow;
    write?: (line: string) => void;
  } = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  // The parser is hand-written, so argv is read here rather than by core's
  // `parseArgv`: one flag, one meaning, and nothing silently promoted.
  const args: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      write(HELP);
      return 0;
    }
    if (!token.startsWith("--")) {
      throw new UitestError(`unexpected argument "${token}"`, "EBADARG");
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const camel = name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    if (eq >= 0) {
      args[camel] = body.slice(eq + 1);
    } else if (name === "no-control" || name === "stay-awake") {
      args[camel] = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UitestError(`--${name} needs a value`, "EBADARG");
      }
      args[camel] = next;
      i++;
    }
  }

  const opts = mirrorOptions(args);
  let run: MirrorRun;
  try {
    run = await startMirror(opts, deps.open, deps.window);
  } catch (e) {
    if (e instanceof LeaseHeldError) {
      // The message already names the task; the tag is what tells a person
      // with two phones which one they are being refused on.
      write(`${e.message}\ndevice ${opts.serial ? tagOf(opts.serial) : "?"}`);
      return 1;
    }
    throw e;
  }

  write(`uitest-mirror ${VERSION} · ${run.url} · device ${run.tag}`);
  if (!opts.control) write("input is off (--no-control): the picture is read-only");

  try {
    // Closing the window is how a person says they are done with the phone,
    // and it is the one stop signal a terminal does not deliver: the browser
    // is a detached child, so the product is told through `onClose`.
    await Promise.race([
      waitForStop({
        stdin: deps.stdin ?? process.stdin,
        signals: deps.signals ?? process,
      }),
      run.windowClosed,
    ]);
  } finally {
    await run.close();
  }
  return 0;
}
