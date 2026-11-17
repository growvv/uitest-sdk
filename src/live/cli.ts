import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Device } from "../driver/device.js";
import type { DeviceOptions } from "../driver/device.js";
import { Session } from "../operations/session.js";
import { parseArgv } from "../cli-main.js";
import { Recording } from "../cast/record.js";
import { createCast } from "../cast/create.js";
import { openInput } from "../input/open.js";
import { LiveServer } from "./server.js";
import type { LiveServerOptions } from "./server.js";
import type { CastOptions } from "../cast/types.js";
import type { Screen } from "../driver/agent/screen.js";

/**
 * `uitest-phone live`
 *
 * The mirror-and-inspect page, for a person rather than an agent. One process,
 * one browser tab, one device lease. It prints the URL it is serving, keeps
 * going until interrupted, and hands the device back on the way out.
 */

const DEFAULT_PORT = 7000;

export interface LiveCommandOptions {
  httpPort: number;
  host: string;
  privacy: boolean;
  open: boolean;
  /** Serve the node table beside the video. `false` is video-only mirroring. */
  layout: boolean;
  cast: Omit<CastOptions, "mode">;
}

/** Reads the command line into options, rejecting values it cannot honour. */
export function liveOptions(
  args: Record<string, string | boolean | string[]>,
): LiveCommandOptions {
  const num = (name: string, fallback: number): number => {
    const raw = args[name];
    if (raw === undefined) return fallback;
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative number`);
    }
    return value;
  };
  const str = (name: string): string | undefined => {
    const raw = args[name];
    if (raw === undefined || raw === true) return undefined;
    return Array.isArray(raw) ? raw[0] : String(raw);
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

  const scale = num("scale", 1);
  if (scale < 1 || scale > 5) throw new Error("--scale must be 1..5");
  const frameRate = num("fps", 30);
  if (![15, 30, 60, 120].includes(frameRate)) {
    throw new Error("--fps must be 15, 30, 60 or 120");
  }
  const transport = str("transport");
  if (transport !== undefined && transport !== "grpc" && transport !== "ws") {
    throw new Error(`--transport takes grpc or ws, got "${transport}"`);
  }

  return {
    httpPort: num("port", DEFAULT_PORT),
    host: str("host") ?? "127.0.0.1",
    privacy,
    open: args["noOpen"] !== true,
    layout: args["noLayout"] !== true,
    cast: {
      ...(transport ? { transport: transport as "grpc" | "ws" } : {}),
      ...(str("wsExtension") ? { wsExtension: str("wsExtension")! } : {}),
      ...(args["castPort"] !== undefined ? { port: num("castPort", 5000) } : {}),
      scale: scale as 1 | 2 | 3 | 4 | 5,
      frameRate: frameRate as 15 | 30 | 60 | 120,
    },
  };
}

/** Opens the URL in the platform's default browser; failure is not fatal. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is printed either way.
  }
}

export interface LiveRun {
  server: LiveServer;
  url: string;
  /** Stops the server and releases the device. */
  close(): Promise<void>;
}

/**
 * Opens the device, starts the page, and resolves once it is listening.
 *
 * Split from `liveMain` so a test can drive the same wiring without a browser
 * and without owning the process's signals.
 */
export async function startLive(
  deviceOptions: DeviceOptions,
  opts: LiveCommandOptions,
  over: { stateDir?: string; task?: string } = {},
): Promise<LiveRun> {
  const device = await Device.connect(deviceOptions);
  let session: Session;
  try {
    session = await Session.open(device, {
      task: over.task ?? "live",
      ...(over.stateDir ? { stateDir: over.stateDir } : {}),
    });
  } catch (e) {
    await device.dispose().catch(() => undefined);
    throw e;
  }

  const readScreen = async (redact: boolean): Promise<Screen> => {
    session.reader.builder.setRedact(redact);
    return session.reader.read();
  };

  // A screenshot goes through the session, so it is masked the same way the
  // node table is: a password the page hides in text must not be readable in
  // the saved pixels. The session already owns that rule (`saveShot`), and a
  // second implementation here would be a second place to get it wrong.
  const stateDir = over.stateDir ?? ".uitest-phone";
  const capture = async (): Promise<string> => {
    const out = join(stateDir, "shots", `live-${Date.now()}.jpg`);
    await mkdir(dirname(out), { recursive: true });
    await session.observe({ out });
    return out;
  };

  // Each page gets its own daemons: a fixed socket name lets a second `live`
  // on the same device take over the first one's socket, and the two then
  // fight over it. The suffix is the process id, which is unique on this host.
  const socketSuffix = String(process.pid);
  const streamCast: CastOptions = {
    mode: "stream",
    ...opts.cast,
    ...(opts.cast.transport === "ws" ? {} : { socketName: `uitest_live_${socketSuffix}` }),
  };

  // Recording lives in its own module: the record daemon has to run beside the
  // stream daemon, and the client is already recording when it is created, so
  // opening a stream on it would start a second `onStart` the extension refuses.
  const recording = new Recording({
    stateDir,
    socketName: `uitest_live_record_${socketSuffix}`,
    createCast: (castOpts) => createCast(device, castOpts),
    streamCast,
  });

  const source: LiveServerOptions["source"] = {
    createCast: () => createCast(device, streamCast),
    // Takeover is always offered: a read-only viewer never triggers it, and
    // the server opens the lane at startup so the first take does not wait on
    // an fport. A second forward and socket keep input out of the layout
    // queue, which is what makes a tap land in tens of milliseconds.
    openInput: () => openInput(device),
    ...(opts.layout ? { readScreen } : {}),
    // Even with the layout off the page needs the display size: a half-size
    // frame (--scale 2, every MJPEG device) would otherwise make every click
    // land at half coordinates. `getDisplaySize` is one agent call, not a
    // layout read.
    displaySize: () => device.agent.getDisplaySize(),
    capture,
    startRecording: () => recording.start(),
    stopRecording: () => recording.stop(),
  };

  let server: LiveServer;
  try {
    server = await LiveServer.start({
      port: opts.httpPort,
      host: opts.host,
      privacy: opts.privacy,
      source,
    });
  } catch (e) {
    await session.release().catch(() => undefined);
    await device.dispose().catch(() => undefined);
    throw e;
  }

  const shown = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  return {
    server,
    url: `http://${shown}:${server.port}/`,
    async close() {
      await server.close();
      await session.release();
      await device.dispose();
    },
  };
}

export async function liveMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone live [--port 7000] [--privacy on|off] [--no-open]\n" +
        "                          [--no-layout] [--scale 1..5] [--fps 15|30|60|120]\n" +
        "                          [--transport grpc|ws] [--ws-extension path]\n" +
        "                          [--cast-port 5000] [--host 127.0.0.1]\n" +
        "                          [--device id] [--state-dir dir]\n\n" +
        "Serves the phone's screen and layout in a browser tab. The page mirrors\n" +
        "the device, boxes every node, and copies a node's ref or JSON when you\n" +
        "click it. Credentials are masked unless --privacy off.\n\n" +
        "The device is held for the life of the page: agent commands stop with\n" +
        "lease_held until you close it. The server listens on 127.0.0.1 unless\n" +
        "--host says otherwise; anyone who can reach the port can watch the\n" +
        "phone.\n",
    );
    return 0;
  }

  let opts: LiveCommandOptions;
  try {
    opts = liveOptions(parsed.args);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let run: LiveRun;
  try {
    run = await startLive(
      { deviceId: parsed.options.device },
      opts,
      {
        ...(parsed.options.stateDir ? { stateDir: parsed.options.stateDir } : {}),
        ...(parsed.options.task ? { task: parsed.options.task } : {}),
      },
    );
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  process.stdout.write(
    `live · ${run.url}\n` +
      `  ${opts.layout ? "video + layout" : "video only"} · privacy ${opts.privacy ? "on" : "off"}\n` +
      `  the device is held until this process exits (Ctrl-C)\n`,
  );
  if (opts.open) openBrowser(run.url);

  let stopping = false;
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // A window that closes its tab leaves the server alone: this process is the
    // session, and it ends when the person ends it.
  });

  await run.close().catch(() => undefined);
  return 0;
}
