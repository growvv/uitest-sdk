import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DaemonStartError, DeviceNotConnectedError } from "./errors.js";

export interface HdcOptions {
  hdcPath?: string;
  deviceId?: string;
  timeoutMs?: number;
}

/** What `hdc list targets -v` says about one attached target. */
export interface HdcTarget {
  id: string;
  state: "connected" | "offline" | "unauthorized" | "connecting" | "unknown";
}

const TARGET_STATES = new Set(["connected", "offline", "unauthorized", "connecting", "unknown"]);

/** `serial \t\t USB \t Connected \t localhost \t hdc` (or just the serial). */
function parseTargetLine(line: string): HdcTarget {
  const parts = line.split(/\s+/).filter(Boolean);
  const id = parts[0]!;
  const raw = parts.find((part) => TARGET_STATES.has(part.toLowerCase()));
  return { id, state: (raw?.toLowerCase() as HdcTarget["state"]) ?? "connected" };
}

const DEVECO_HINTS = [
  "D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe",
  "C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe",
  "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc",
];

const PORT_FAILURE = /TCP Port listen failed|port.*(in use|already)/i;

interface RunResult {
  stdout: string;
  stderr: string;
}

export class HdcRunner {
  private readonly hdcPath: string;
  private readonly deviceId?: string;
  private readonly timeoutMs: number;
  /** Local port → remote rule, so `fportRemove` can issue the full rm command. */
  private readonly forwards = new Map<number, string>();

  constructor(opts: HdcOptions = {}) {
    this.hdcPath = opts.hdcPath ?? this.resolveHdcPath();
    this.deviceId = opts.deviceId ?? process.env.HDC_TARGET;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  resolveHdcPath(): string {
    const candidates: string[] = [];
    if (process.env.HDC_PATH) candidates.push(process.env.HDC_PATH);

    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      candidates.push(join(dir, "hdc"), join(dir, "hdc.exe"));
    }
    candidates.push(...DEVECO_HINTS);

    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new DeviceNotConnectedError(
      "hdc not found: pass hdcPath, set HDC_PATH, or put hdc on PATH",
      "ENOHDC",
    );
  }

  /** Runs `hdc <args>` and resolves with stdout; rejects with stderr in the message. */
  private exec(args: string[], label: string): Promise<RunResult> {
    const full = this.deviceId ? ["-t", this.deviceId, ...args] : args;
    return new Promise<RunResult>((resolve, reject) => {
      execFile(
        this.hdcPath,
        full,
        { timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const detail = `${stderr}${stdout}`.trim();
            reject(
              new DeviceNotConnectedError(
                `hdc ${label} failed: ${detail || (err as Error).message}`,
                "EHDC",
                err,
              ),
            );
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  async shell(cmd: string): Promise<string> {
    const { stdout } = await this.exec(["shell", cmd], `shell ${cmd}`);
    return stdout;
  }

  async push(local: string, remote: string): Promise<void> {
    await this.exec(["file", "send", local, remote], `file send ${local} ${remote}`);
  }

  async pull(remote: string, local: string): Promise<void> {
    await this.exec(["file", "recv", remote, local], `file recv ${remote} ${local}`);
  }

  /** Reads a file that was previously pulled. Kept here so CliRunner can be tested without fs. */
  async readLocal(path: string): Promise<string> {
    return readFileSync(path, "utf8");
  }

  /**
   * Forwards a local TCP port to a device endpoint, walking forward from
   * `localPort` while the port is taken. Returns the port actually used.
   */
  async fportAdd(localPort: number, remote: string): Promise<number> {
    const maxAttempts = 20;
    let lastDetail = "";
    for (let i = 0; i < maxAttempts; i++) {
      const port = localPort + i;
      try {
        const { stdout, stderr } = await this.exec(
          ["fport", `tcp:${port}`, remote],
          `fport tcp:${port} ${remote}`,
        );
        const out = `${stdout}${stderr}`;
        if (PORT_FAILURE.test(out)) {
          lastDetail = out.trim();
          continue;
        }
        this.forwards.set(port, remote);
        return port;
      } catch (e) {
        lastDetail = (e as Error).message;
        if (!PORT_FAILURE.test(lastDetail)) throw e;
      }
    }
    throw new DaemonStartError(
      `no free local port in ${localPort}..${localPort + maxAttempts - 1}: ${lastDetail}`,
      "EPORT",
    );
  }

  /**
   * Removes a forward. `hdc fport rm` needs both the local and remote rules, so
   * the remote is remembered from `fportAdd`; callers that passed a different
   * remote can supply it explicitly.
   */
  async fportRemove(localPort: number, remote?: string): Promise<void> {
    const target = remote ?? this.forwards.get(localPort);
    const args = target
      ? ["fport", "rm", `tcp:${localPort}`, target]
      : ["fport", "rm", `tcp:${localPort}`];
    await this.exec(args, `fport rm tcp:${localPort}`);
    this.forwards.delete(localPort);
  }

  /**
   * Attached targets with their state.
   *
   * `-v` is the only form that distinguishes a usable phone from one that is
   * merely plugged in: an unauthorized target answers no shell command, and an
   * offline one is halfway through connecting. Both used to surface as a
   * generic shell failure, which reads as "retry" instead of "ask the person".
   */
  async listTargetDetails(): Promise<HdcTarget[]> {
    const { stdout } = await this.exec(["list", "targets", "-v"], "list targets");
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("[Empty]"))
      .map(parseTargetLine);
  }

  async listTargets(): Promise<string[]> {
    return (await this.listTargetDetails()).map((target) => target.id);
  }
}
