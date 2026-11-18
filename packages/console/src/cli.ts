import { join } from "node:path";
import { connect } from "uitest-sdk";
import type { ConnectOptions } from "uitest-sdk";
import { parseArgv } from "uitest-sdk/commands";
import { Approvals, holdDevice, readHold, readRecentTrace, resumeDevice } from "uitest-sdk/govern";
import { createViewerSource } from "uitest-sdk/viewer";
import type { ViewerSource } from "uitest-sdk/viewer";
import { createConsoleServer, consoleHooks } from "./server.js";
import type { ConsoleDeps } from "./server.js";
import { openWindow } from "./window.js";
import { VERSION } from "./version.js";

/**
 * `uitest-console` — the person-facing half of the same device session.
 *
 * One process, one browser window, one page: the mirror and node table come
 * from core's viewer, and this product adds takeover and the approval inbox.
 * It never holds the device lease while merely watching (an agent may be
 * working at the same time); `Hold` writes the person's lease, which is what
 * pauses the agents, and `Resume` hands it back.
 */

const DEFAULT_PORT = 7042;

export interface ConsoleCliOptions {
  port: number;
  host: string;
  privacy: boolean;
  open: boolean;
  device?: string;
  stateDir: string;
  task: string;
  transport?: "grpc" | "ws" | "mjpeg";
  record?: string;
  /** Serve the node table beside the video. `false` is video-only mirroring. */
  layout: boolean;
  scale: 1 | 2 | 3 | 4 | 5;
  frameRate: 15 | 30 | 60 | 120;
  /** ws transport only: device-side listening port. */
  castPort?: number;
  /** ws transport only: local path to the 7.0 extension. */
  wsExtension?: string;
}

/** Reads the command line, rejecting values it cannot honour. */
export function consoleOptions(args: Record<string, string | boolean | string[]>): ConsoleCliOptions {
  const str = (name: string): string | undefined => {
    const raw = args[name];
    if (raw === undefined || raw === true) return undefined;
    return Array.isArray(raw) ? raw[0] : String(raw);
  };
  const num = (name: string, fallback: number): number => {
    const raw = args[name];
    if (raw === undefined) return fallback;
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isFinite(value) || value < 0 || value > 65_535) {
      throw new Error(`--${name} must be a port number`);
    }
    return value;
  };

  const privacyRaw = str("privacy");
  let privacy = true;
  if (privacyRaw !== undefined) {
    const normalized = privacyRaw.toLowerCase();
    if (["off", "false", "no", "0"].includes(normalized)) privacy = false;
    else if (!["on", "true", "yes", "1"].includes(normalized)) {
      throw new Error(`--privacy takes on or off, got "${privacyRaw}"`);
    }
  }

  const transport = str("transport");
  if (transport !== undefined && !["grpc", "ws", "mjpeg"].includes(transport)) {
    throw new Error(`--transport takes grpc, ws or mjpeg, got "${transport}"`);
  }

  // The stream settings the old `live` command took. They are not decoration:
  // a person on a slow link needs `--scale 2`, and a 7.0 device needs
  // `--transport ws` with its extension.
  const scaleRaw = num("scale", 1);
  if (![1, 2, 3, 4, 5].includes(scaleRaw)) throw new Error("--scale must be 1..5");
  const frameRate = num("fps", 30);
  if (![15, 30, 60, 120].includes(frameRate)) {
    throw new Error("--fps must be 15, 30, 60 or 120");
  }

  return {
    port: num("port", DEFAULT_PORT),
    host: str("host") ?? "127.0.0.1",
    privacy,
    open: args["noOpen"] !== true,
    ...(str("device") ? { device: str("device")! } : {}),
    stateDir: str("stateDir") ?? ".uitest-phone",
    task: str("task") ?? "console",
    ...(transport ? { transport: transport as "grpc" | "ws" | "mjpeg" } : {}),
    ...(str("record") ? { record: str("record")! } : {}),
    layout: args["noLayout"] !== true,
    scale: scaleRaw as 1 | 2 | 3 | 4 | 5,
    frameRate: frameRate as 15 | 30 | 60 | 120,
    ...(str("castPort") ? { castPort: num("castPort", 5000) } : {}),
    ...(str("wsExtension") ? { wsExtension: str("wsExtension")! } : {}),
  };
}

export interface ConsoleRun {
  url: string;
  port: number;
  /** The device's 8-character hash, the only identifier ever printed. */
  tag: string;
  /**
   * Stops the page and lets the device go.
   *
   * A hold is not released: the person may have taken the phone to use it and
   * closing this window is not the same as handing it back. The caller says how
   * to release it (`uitest-phone resume`), because a hold nobody can see is a
   * device every agent refuses to touch.
   */
  close(): Promise<void>;
}

/**
 * Opens the device, builds the page, and resolves once it is listening.
 *
 * Split from `consoleMain` so a test can drive the wiring without a browser
 * and without owning the process's signals.
 */
export async function startConsole(
  opts: ConsoleCliOptions,
  open: (o: ConnectOptions) => Promise<Awaited<ReturnType<typeof connect>>> = connect,
): Promise<ConsoleRun> {
  // No lease: watching a device an agent is driving is the point. `Hold` is the
  // explicit statement that the person wants it, and it writes the same lease
  // the CLI's `hold` writes.
  const session = await open({
    ...(opts.device ? { deviceId: opts.device } : {}),
    stateDir: opts.stateDir,
    task: opts.task,
    lease: false,
  });

  const source: ViewerSource = createViewerSource(session.core, session.device, {
    stateDir: opts.stateDir,
    layout: opts.layout,
    cast: {
      scale: opts.scale,
      frameRate: opts.frameRate,
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(opts.castPort !== undefined ? { port: opts.castPort } : {}),
      ...(opts.wsExtension ? { wsExtension: opts.wsExtension } : {}),
    },
    ...(opts.record ? { recordPath: opts.record } : {}),
  });

  const deps: ConsoleDeps = {
    approvals: new Approvals({ dir: join(opts.stateDir, "approvals", session.tag) }),
    stateDir: opts.stateDir,
    tag: session.tag,
    hold: () => holdDevice({ stateDir: opts.stateDir, tag: session.tag }),
    resume: () => resumeDevice({ stateDir: opts.stateDir, tag: session.tag }),
    // The lease is the truth: a hold may have been written by `uitest-phone
    // hold` before this page started, and `resume` may run from another shell.
    isHeld: async () => {
      const lease = await readHold({ stateDir: opts.stateDir, tag: session.tag });
      return lease?.hold === true;
    },
    activity: () => readRecentTrace(opts.stateDir, { limit: 20 }),
  };

  let server;
  try {
    server = await createConsoleServer({
      ...deps,
      source,
      port: opts.port,
      host: opts.host,
      privacy: opts.privacy,
    });
  } catch (e) {
    // A port already in use is the everyday case: the person ran the console
    // twice. Leaving the session open would keep a daemon and an fport behind
    // for a page that never existed.
    await session.close().catch(() => undefined);
    throw e;
  }

  const shown = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const url = `http://${shown}:${server.port}/`;
  let closed = false;
  return {
    url,
    port: server.port,
    tag: session.tag,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await session.close();
    },
  };
}

/**
 * The console's options from the command line.
 *
 * `parseArgv` files `--device`, `--state-dir` and `--task` under `options`
 * (they are global flags shared with the phone), and everything else under
 * `args`. Reading only `args` silently drops the device a person named and
 * opens whichever device is attached — which is how a two-device acceptance
 * run ended up pointed at the wrong phone. Merge both, options last: the
 * parser's normalised view of a global flag is the one to trust.
 */
export function consoleOptionsFrom(argv: string[]): ConsoleCliOptions {
  const parsed = parseArgv(argv);
  const merged: Record<string, string | boolean | string[]> = { ...parsed.args };
  // The three global flags the console acts on. The rest of `options`
  // (read-only, confirm, apps, settle-ms) belong to the phone's session, and
  // the console must not silently adopt them as if they were its own.
  for (const key of ["device", "stateDir", "task"] as const) {
    const value = parsed.options[key];
    if (value !== undefined) merged[key] = value;
  }
  return consoleOptions(merged);
}

/**
 * Resolves when the person or their supervisor asks this console to stop.
 *
 * SIGINT/SIGTERM cover a terminal. They are not enough for a supervisor:
 * on Windows `child.kill()` terminates the process outright and no handler
 * runs, so the device lease and the hdc port forward are never released —
 * twenty abandoned forwards filled 8012..8031 and the next run could not
 * open the tunnel. Closing the child's stdin is a signal every platform
 * delivers, so it is honoured as the same request to stop.
 */
export function waitForStop(io: {
  stdin: { resume(): void; on(event: string, listener: () => void): unknown };
  signals: { once(event: string, listener: () => void): unknown };
}): Promise<void> {
  io.stdin.resume();
  return new Promise<void>((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      resolve();
    };
    io.signals.once("SIGINT", stop);
    io.signals.once("SIGTERM", stop);
    io.stdin.on("end", stop);
    io.stdin.on("close", stop);
  });
}

export async function consoleMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-console [--device id] [--state-dir dir] [--port 7042] [--host 127.0.0.1]\n" +
        "                      [--transport grpc|ws|mjpeg] [--privacy on|off] [--no-open]\n" +
        "                      [--task console] [--record file.mp4] [--no-layout]\n" +
        "                      [--scale 1..5] [--fps 15|30|60|120] [--cast-port 5000]\n" +
        "                      [--ws-extension path]\n\n" +
        "Opens the phone's screen in a browser window: mirror, node table, takeover,\n" +
        "and the approvals waiting for a person. Watching does not take the device\n" +
        "from an agent; Hold does, and Resume hands it back.\n\n" +
        "The server listens on 127.0.0.1 unless --host says otherwise; anyone who\n" +
        "can reach the port can watch and drive the phone.\n",
    );
    return 0;
  }
  if (parsed.command) {
    process.stderr.write(
      `error: uitest-console takes flags, not a command (got "${parsed.command}")\n`,
    );
    return 2;
  }

  let opts: ConsoleCliOptions;
  try {
    opts = consoleOptionsFrom(argv);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let run: ConsoleRun;
  try {
    run = await startConsole(opts);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  process.stdout.write(
    `uitest-console ${VERSION} · ${run.url} · device ${run.tag}\n` +
      `  privacy ${opts.privacy ? "on" : "off"} · hold pauses agents, resume hands the phone back\n` +
      `  Ctrl-C closes the page\n`,
  );
  if (opts.open) openWindow(run.url);

  await waitForStop({ stdin: process.stdin, signals: process });

  await run.close().catch(() => undefined);
  // A hold survives the window on purpose — it means "a person is using the
  // phone". Closing the console does not undo that, so say what does, or the
  // device stays refused to every agent with nothing on screen explaining why.
  const lease = await readHold({ stateDir: opts.stateDir, tag: run.tag }).catch(() => null);
  if (lease?.hold === true) {
    process.stdout.write(`device ${run.tag} is still held · release it with: uitest-phone resume\n`);
  }
  return 0;
}

/** Exported for tests: the hooks the page talks to, without a device. */
export { consoleHooks };
