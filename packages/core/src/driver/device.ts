import net from "node:net";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentClient, isBusyException } from "./agent/client.js";
import { CliRunner } from "./cli.js";
import { Files } from "../transport/files.js";
import { connectTcp, pids } from "../transport/helpers.js";
import { HdcRunner } from "../transport/hdc.js";
import { HypiumDriver } from "./hypium/driver.js";
import { deviceTag } from "../governance/trace.js";
import { CASTING_EXTENSION, resolveCastingExtension } from "../cast/resolve.js";
import {
  AgentBusyError,
  AgentConnectionError,
  DaemonStartError,
  DeviceNotConnectedError,
  DeviceStateError,
  ExtensionMissingError,
} from "../transport/errors.js";

export interface DeviceOptions {
  hdcPath?: string;
  deviceId?: string;
  agentPort?: number;
  autoRestart?: boolean;
  extensionDir?: string;
  requestTimeoutMs?: number;
  ownDaemon?: boolean;
  retryOnBusy?: boolean;
}

/**
 * The assets directory that ships with the package. Resolved from the module
 * itself — an installed package lives in node_modules, where a cwd-relative
 * default would be the consumer's own assets/ or nothing at all. Both `src/`
 * (tsx) and `dist/` (published) sit one level below the package root.
 */
export function defaultExtensionDir(): string {
  return fileURLToPath(new URL("../../assets", import.meta.url));
}

const AGENT_REMOTE = "/data/local/tmp/agent.so";
const CAST_REMOTE = `/data/local/tmp/${CASTING_EXTENSION}`;
const AGENT_PORT_HEX = "1F4C"; // 8012
const START_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


/**
 * Owns one device: pushes the agent extension, makes sure a daemon is
 * listening on 8012, and hands out the protocol clients.
 *
 * Multi-instance rules (measured, see spec §4.6): never kill a daemon blindly —
 * `pidof uitest` returns every uitest process and a sibling may be serving
 * another consumer. A daemon that this instance started is identified only by
 * the pidof before/after difference.
 */
export class Device {
  readonly agent: AgentClient;
  readonly cli: CliRunner;
  /** The device filesystem, through hdc: list, stat, mkdir, rm, mv, push, pull. */
  readonly files: Files;
  /**
   * The hdc target this device drives. Public because the session layer needs a
   * shell for app management, and because a lease and a trace are keyed by it.
   */
  readonly hdc: HdcRunner;
  /** Serial of the target in use; hashed before it reaches a trace or lease. */
  readonly deviceId: string;

  private _state: "connected" | "disconnected" = "connected";
  /** In-flight `dispose()`, so a second caller waits for the same cleanup. */
  private disposePromise: Promise<void> | null = null;
  private _hypium: HypiumDriver | null = null;

  private constructor(
    hdc: HdcRunner,
    private readonly opts: DeviceOptions,
    deviceId: string,
    readonly abi: "arm64" | "x86_64",
    private readonly extDir: string,
    agent: AgentClient,
    private readonly localPort: number,
    private readonly ownPid: string | null,
  ) {
    this.hdc = hdc;
    this.deviceId = deviceId;
    this.agent = agent;
    this.cli = new CliRunner(hdc);
    this.files = new Files(hdc);
  }

  static async connect(opts: DeviceOptions = {}): Promise<Device> {
    const hdc = new HdcRunner(opts);

    const targets = await hdc.listTargetDetails();
    if (targets.length === 0) {
      throw new DeviceStateError(
        "device_offline",
        "device_offline · no hdc target is attached. Connect the phone by USB, unlock it, " +
          "and check that Developer options / USB debugging are on.",
        "ENODEVICE",
      );
    }
    // Prefer a target that can actually run: hdc lists unauthorized and
    // offline entries too, and starting a daemon on one fails obscurely.
    const offline = () =>
      new DeviceStateError(
        "device_offline",
        "device_offline · the phone is not reachable. Reconnect the cable, unlock it, " +
          "and retry; if it stays offline run `hdc kill -r` and plug it in again.",
        "EOFFLINE",
      );
    const needsSetup = () =>
      new DeviceStateError(
        "device_needs_setup",
        "device_needs_setup · the phone has not authorized this computer. Unlock the phone " +
          'and tap "Allow" on the USB debugging prompt; if no prompt appears, revoke the ' +
          "USB debugging authorizations in Developer options and reconnect.",
        "EUNAUTHORIZED",
      );
    const wanted = opts.deviceId ?? process.env.HDC_TARGET;
    const target = wanted ? targets.find((t) => t.id === wanted) : targets.find((t) => t.state === "connected");
    if (!target) {
      // Nothing usable was selected. If any attached target is waiting for
      // authorization, that is the one fact the person can act on.
      if (targets.some((t) => t.state === "unauthorized")) throw needsSetup();
      if (wanted) {
        throw new DeviceStateError(
          "device_offline",
          "device_offline · the device named by --device is not attached. " +
            "Run `hdc list targets -v` to see what is; serials never appear in this SDK's output.",
          "EOFFLINE",
        );
      }
      throw offline();
    }
    if (target.state === "unauthorized") throw needsSetup();
    if (target.state !== "connected") throw offline();
    const abiList = await hdc.shell("param get const.product.cpu.abilist");
    const abi: "arm64" | "x86_64" =
      abiList.includes("x86_64") && !abiList.includes("arm64") ? "x86_64" : "arm64";

    const extDir = opts.extensionDir ?? defaultExtensionDir();
    const agentLocal = join(extDir, abi, "agent.so");
    if (!existsSync(agentLocal)) {
      throw new ExtensionMissingError(
        `agent.so not found for ${abi} at ${agentLocal}`,
        "ENOEXT",
      );
    }

    await ensurePushed(hdc, agentLocal, AGENT_REMOTE);
    // The casting daemon loads its extension from /data/local/tmp too, so
    // selecting H.264 from a local file is only honest if it is also on the device.
    const castLocal = resolveCastingExtension(abi, extDir);
    if (castLocal) await ensurePushed(hdc, castLocal, CAST_REMOTE);

    const listening = await isAgentListening(hdc);
    let ownPid: string | null = null;

    if (!listening) {
      ownPid = await startDaemon(hdc);
      // Inside a guard: a daemon that spawns but never binds is a process this
      // call owns and must not outlive it. Without this, every retry added one
      // more `uitest` process to the phone, and none of them were ever killed.
      try {
        await waitForAgent(hdc);
      } catch (e) {
        if (ownPid !== null) await hdc.shell(`kill -9 ${ownPid}`).catch(() => undefined);
        throw e;
      }
    }

    let localPort = 0;
    let sock: net.Socket | null = null;
    let agent: AgentClient | null = null;
    try {
      localPort = await hdc.fportAdd(opts.agentPort ?? 8012, "tcp:8012");
      sock = await connectTcp(localPort);
      const reconnect =
        opts.autoRestart !== false
          ? async () => {
              if (!(await isAgentListening(hdc))) {
                await startDaemon(hdc);
                await waitForAgent(hdc);
              }
              return connectTcp(localPort);
            }
          : undefined;
      agent = new AgentClient(sock, {
        requestTimeoutMs: opts.requestTimeoutMs,
        retryOnBusy: opts.retryOnBusy,
        reconnect,
      });

      // Health check: proves the tunnel really reaches the extension.
      try {
        await agent.getDisplaySize();
      } catch (e) {
        // A killed client leaves a CLOSE_WAIT socket on the daemon, and that
        // dead socket holds the global lock forever: every request answers
        // "Disallow concurrent use" and waiting does not help. The daemon is
        // alive, so `pidof` cannot tell this from a healthy one — the socket
        // state can. Only restart when nothing else is connected.
        if (!isBusyException(e) || !(await lockHeldByDeadSocket(hdc))) throw e;
        const pids = await agentDaemonPids(hdc);
        if (pids.length === 0) {
          throw new AgentBusyError(
            "the agent daemon's lock is held by a dead connection and its pid cannot be " +
              "identified; run `hdc shell kill -9 $(pidof uitest)` and retry",
            "EBUSY",
            e,
          );
        }
        agent.close();
        agent = null;
        sock = null;
        for (const pid of pids) await hdc.shell(`kill -9 ${pid}`).catch(() => undefined);
        await sleep(200);
        await startDaemon(hdc);
        await waitForAgent(hdc);
        sock = await connectTcp(localPort);
        agent = new AgentClient(sock, {
          requestTimeoutMs: opts.requestTimeoutMs,
          retryOnBusy: opts.retryOnBusy,
          reconnect,
        });
        await agent.getDisplaySize();
      }
    } catch (e) {
      // A half-built tunnel must not outlive the failure: the open socket keeps
      // the event loop alive and a stale port forward blocks the next attempt.
      if (agent) agent.close();
      else if (sock) sock.destroy();
      if (localPort !== 0) await hdc.fportRemove(localPort).catch(() => undefined);
      if (ownPid !== null) await hdc.shell(`kill -9 ${ownPid}`).catch(() => undefined);
      throw e;
    }

    // The target actually in use: an explicit id, the environment's, or the
    // first attached one that is connected. A trace and a lease are keyed by it.
    const deviceId = target.id;
    return new Device(hdc, opts, deviceId, abi, extDir, agent!, localPort, ownPid);
  }

  get state(): "connected" | "disconnected" {
    return this._state;
  }

  get ownsDaemon(): boolean {
    return this.ownPid !== null;
  }

  /**
   * The complete hypium-compatible surface, built lazily so constructing it
   * never touches the device. Actions go through the same agent connection as
   * `Session`, so both share one wire and one lock.
   */
  get hypium(): HypiumDriver {
    this.assertConnected();
    this._hypium ??= new HypiumDriver({
      agent: this.agent,
      hdc: this.hdc,
      deviceTag: deviceTag(this.deviceId),
    });
    return this._hypium;
  }

  /** Path of the casting extension for this device's ABI, or null when none exists. */
  resolveCastExtension(): string | null {
    return resolveCastingExtension(this.abi, this.extDir);
  }

  /** The local port forwarded to the agent daemon, one per connected device. */
  get agentPort(): number {
    return this.opts.agentPort ?? 8012;
  }

  dispose(): Promise<void> {
    // A second caller joins the first cleanup instead of returning at once:
    // returning early told it the device was free while the fport was still
    // being removed, and the process could exit mid-cleanup.
    if (this.disposePromise) return this.disposePromise;
    this._state = "disconnected";
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  private async finishDispose(): Promise<void> {
    this._hypium?.close();
    this._hypium = null;
    this.agent.close();
    await this.hdc.fportRemove(this.localPort).catch(() => undefined);

    // Only a daemon this instance started, and only when explicitly asked for.
    if (this.ownPid !== null && this.ownPid !== "" && this.opts.ownDaemon === true) {
      await this.hdc.shell(`kill -9 ${this.ownPid}`).catch(() => undefined);
    }
  }

  private assertConnected(): void {
    if (this._state !== "connected") {
      throw new DeviceNotConnectedError("device has been disposed", "EDISPOSED");
    }
  }
}

async function ensurePushed(hdc: HdcRunner, local: string, remote: string): Promise<void> {
  const localSize = statSync(local).size;
  const listing = await hdc.shell(`ls -l ${remote}`).catch(() => "");
  const m = /^\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/.exec(listing.trim());
  if (m && Number(m[1]) === localSize) return;
  await hdc.push(local, remote);
  await hdc.shell(`chmod 755 ${remote}`);
}

/**
 * True when something is LISTENing on 8012. A bare `grep 1F4C` is wrong: the
 * hex port also appears as the *remote* address of TIME_WAIT sockets left by a
 * daemon that already died, which makes a dead device look healthy.
 */
async function isAgentListening(hdc: HdcRunner): Promise<boolean> {
  const out = await hdc.shell("cat /proc/net/tcp").catch(() => "");
  return out.split(/\r?\n/).some((line) => {
    // sl local_address rem_address st ...
    const f = line.trim().split(/\s+/);
    if (f.length < 4) return false;
    const local = f[1] ?? "";
    const st = f[3] ?? "";
    return local.endsWith(`:${AGENT_PORT_HEX}`) && st === "0A";
  });
}

/**
 * Starts the agent daemon and returns its pid, located as the pidof difference.
 * Never kills anything here: an unrelated casting daemon may be running.
 */
async function startDaemon(hdc: HdcRunner): Promise<string | null> {
  const before = pids(await hdc.shell("pidof uitest"));
  await hdc.shell(`/system/bin/uitest start-daemon singleness --extension-name agent.so`);
  const after = pids(await hdc.shell("pidof uitest"));
  const fresh = [...after].filter((p) => !before.has(p));
  // Exactly one new pid is attributable to this call. Zero means a sibling won
  // the race and its daemon is the one listening; several means a sibling
  // started one in the same window. Either way ownership is unknown, and
  // claiming it would let dispose() kill someone else's daemon.
  return fresh.length === 1 ? fresh[0]! : null;
}

/**
 * True when the agent's listening socket has a peer in CLOSE_WAIT (state 08)
 * and no live peer at all.
 *
 * Measured on a real device: a client killed mid-request leaves exactly this,
 * and the daemon's global lock stays held until the daemon exits — waiting
 * does not clear it. Two conditions keep the restart safe:
 *
 * - TIME_WAIT (06) is not counted. That peer is gone and the kernel reaps it,
 *   so restarting for it would kill a healthy daemon.
 * - A live peer (01) means someone else is using the daemon. Killing it would
 *   break that task, and the lock will be released when they finish.
 */
async function lockHeldByDeadSocket(hdc: HdcRunner): Promise<boolean> {
  const out = await hdc.shell("cat /proc/net/tcp").catch(() => "");
  let dead = false;
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const local = f[1] ?? "";
    const remote = f[2] ?? "";
    const st = f[3] ?? "";
    if (!local.endsWith(`:${AGENT_PORT_HEX}`)) continue;
    if (remote.startsWith("00000000")) continue; // the listener itself
    if (st === "01") return false; // a live client owns the daemon
    if (st === "08") dead = true;
  }
  return dead;
}

/**
 * The pid(s) of the agent daemon, read from each process's command line.
 *
 * `pidof uitest` is not enough: a casting daemon is the same binary, and
 * killing it would break someone's stream. `--extension-name agent.so` is what
 * tells them apart.
 */
async function agentDaemonPids(hdc: HdcRunner): Promise<string[]> {
  const candidates = pids(await hdc.shell("pidof uitest"));
  const found: string[] = [];
  for (const pid of candidates) {
    const cmdline = await hdc.shell(`cat /proc/${pid}/cmdline`).catch(() => "");
    // The file is NUL-separated and `tr` is missing on this device's shell.
    if (cmdline.includes("agent.so")) found.push(pid);
  }
  return found;
}

async function waitForAgent(hdc: HdcRunner): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (await isAgentListening(hdc)) return;
    if (Date.now() > deadline) {
      throw new DaemonStartError(
        `agent daemon never listened on 8012 within ${START_TIMEOUT_MS} ms`,
        "ENODAEMON",
      );
    }
    await sleep(100);
  }
}

export { AgentConnectionError };
