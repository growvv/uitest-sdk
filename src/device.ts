import net from "node:net";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "./agent/client.js";
import { CliRunner } from "./cli.js";
import { HdcRunner } from "./hdc.js";
import { H264CastClient } from "./cast/client.js";
import { MjpegCastClient } from "./cast/mjpeg.js";
import { resolveCastingExtension } from "./cast/resolve.js";
import type { CastClient, CastOptions } from "./cast/types.js";
import {
  AgentConnectionError,
  DaemonStartError,
  DeviceNotConnectedError,
  ExtensionMissingError,
} from "./errors.js";

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

const AGENT_REMOTE = "/data/local/tmp/agent.so";
const AGENT_PORT_HEX = "1F4C"; // 8012
const START_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parses `pidof` output. Multiple pids come back space-separated on one line. */
function pids(output: string): Set<string> {
  return new Set(output.split(/\s+/).filter((t) => /^\d+$/.test(t)));
}

function connectTcp(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, "127.0.0.1");
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
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

  private _state: "connected" | "disconnected" = "connected";

  private constructor(
    private readonly hdc: HdcRunner,
    private readonly opts: DeviceOptions,
    private readonly abi: "arm64" | "x86_64",
    private readonly extDir: string,
    agent: AgentClient,
    private readonly localPort: number,
    private readonly ownPid: string | null,
  ) {
    this.agent = agent;
    this.cli = new CliRunner(hdc);
  }

  static async connect(opts: DeviceOptions = {}): Promise<Device> {
    const hdc = new HdcRunner(opts);

    const targets = await hdc.listTargets();
    if (targets.length === 0) {
      throw new DeviceNotConnectedError("no hdc target attached", "ENODEVICE");
    }

    const abiList = await hdc.shell("param get const.product.cpu.abilist");
    const abi: "arm64" | "x86_64" =
      abiList.includes("x86_64") && !abiList.includes("arm64") ? "x86_64" : "arm64";

    const extDir = opts.extensionDir ?? join(process.cwd(), "assets");
    const agentLocal = join(extDir, abi, "agent.so");
    if (!existsSync(agentLocal)) {
      throw new ExtensionMissingError(
        `agent.so not found for ${abi} at ${agentLocal}`,
        "ENOEXT",
      );
    }

    await ensurePushed(hdc, agentLocal, AGENT_REMOTE);

    const listening = await isAgentListening(hdc);
    let ownPid: string | null = null;

    if (!listening) {
      ownPid = await startDaemon(hdc);
      await waitForAgent(hdc);
    }

    const localPort = await hdc.fportAdd(opts.agentPort ?? 8012, "tcp:8012");
    const sock = await connectTcp(localPort);
    const reconnect =
      opts.autoRestart === true
        ? async () => {
            if (!(await isAgentListening(hdc))) {
              await startDaemon(hdc);
              await waitForAgent(hdc);
            }
            return connectTcp(localPort);
          }
        : undefined;
    const agent = new AgentClient(sock, {
      requestTimeoutMs: opts.requestTimeoutMs,
      retryOnBusy: opts.retryOnBusy,
      reconnect,
    });

    // Health check: proves the tunnel really reaches the extension.
    await agent.getDisplaySize();

    return new Device(hdc, opts, abi, extDir, agent, localPort, ownPid);
  }

  get state(): "connected" | "disconnected" {
    return this._state;
  }

  get ownsDaemon(): boolean {
    return this.ownPid !== null;
  }

  /** Path of the casting extension for this device's ABI, or null when none exists. */
  resolveCastExtension(): string | null {
    return resolveCastingExtension(this.abi, this.extDir);
  }

  /**
   * Chooses the cast transport explicitly: H.264 where the extension exists,
   * MJPEG where it cannot (x86_64 has no build). The choice is reported through
   * `castKind`; it is never a silent downgrade after a failure.
   */
  async createCast(opts: CastOptions): Promise<CastClient> {
    this.assertConnected();
    if (this.resolveCastExtension() !== null) {
      return H264CastClient.start(this.hdc, opts);
    }
    return new MjpegCastClient(this.agent, { scale: opts.scale });
  }

  async dispose(): Promise<void> {
    if (this._state === "disconnected") return;
    this._state = "disconnected";

    this.agent.close();
    await this.hdc.fportRemove(this.localPort).catch(() => undefined);

    // Only a daemon this instance started, and only when explicitly asked for.
    if (this.ownPid !== null && this.opts.ownDaemon === true) {
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
async function startDaemon(hdc: HdcRunner): Promise<string> {
  const before = pids(await hdc.shell("pidof uitest"));
  await hdc.shell(`/system/bin/uitest start-daemon singleness --extension-name agent.so`);
  const after = pids(await hdc.shell("pidof uitest"));
  const fresh = [...after].filter((p) => !before.has(p));
  return fresh[fresh.length - 1] ?? "";
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
