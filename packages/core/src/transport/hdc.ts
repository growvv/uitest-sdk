import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { DaemonStartError, DeviceNotConnectedError, UitestError } from "./errors.js";

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
  /**
   * Ports whose forward already existed and was reused. They are not this
   * process's to remove: a second session may be sharing the tunnel, and a
   * leftover from a killed process is harmless — the next run reuses it too.
   */
  private readonly reused = new Set<number>();

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
  private exec(args: string[], label: string, timeoutMs = this.timeoutMs): Promise<RunResult> {
    const full = this.deviceId ? ["-t", this.deviceId, ...args] : args;
    return new Promise<RunResult>((resolve, reject) => {
      execFile(
        this.hdcPath,
        full,
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
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

  async shell(cmd: string, timeoutMs?: number): Promise<string> {
    const { stdout } = await this.exec(["shell", cmd], `shell ${cmd}`, timeoutMs);
    return stdout;
  }

  /**
   * Runs an hdc connector command as an argument vector. Unlike `shell`, this
   * is the hdc client's own subcommand surface (`install`, `list targets`,
   * `file send`, ...), so paths with spaces stay one argument.
   */
  async command(args: string[], timeoutMs?: number): Promise<string> {
    const { stdout, stderr } = await this.exec(args, args.join(" "), timeoutMs);
    return stdout || stderr;
  }

  /**
   * `file send` is given an absolute local path on purpose: measured, a
   * relative one is read as a directory tree, and hdc then creates a *folder*
   * at the remote path with the file inside it instead of writing the file.
   */
  async push(local: string, remote: string): Promise<void> {
    const source = resolve(local);
    await this.exec(["file", "send", source, remote], `file send ${source} ${remote}`);
  }

  /**
   * `file recv` reports a failed transfer on stdout and still exits 0:
   * `[Fail]Error opening file: no such file or directory, path:...` when the
   * local path cannot be opened. Trusting the exit code alone made a failed
   * pull look successful — a recording's `dispose()` resolved and the caller
   * had no file. The status line is therefore read as well.
   */
  async pull(remote: string, local: string): Promise<void> {
    const { stdout, stderr } = await this.exec(
      ["file", "recv", remote, local],
      `file recv ${remote} ${local}`,
    );
    const failure = /\[Fail\]\s*(.+)/.exec(`${stdout}\n${stderr}`);
    if (failure) {
      throw new UitestError(`hdc file recv ${remote} failed: ${failure[1]!.trim()}`, "EHDC");
    }
  }

  /** Reads a file that was previously pulled. Kept here so CliRunner can be tested without fs. */
  async readLocal(path: string): Promise<string> {
    return readFileSync(path, "utf8");
  }

  /**
   * Forwards a local TCP port to a device endpoint, walking forward from
   * `localPort` while the port is taken. Returns the port actually used.
   *
   * An existing forward to the same endpoint is reused rather than duplicated.
   * A client killed without cleanup — an MCP server killed by its host, a
   * crashed agent — leaves its forward behind, and adding one more per task
   * leaks a port until `hdc fport` refuses to add any. Reusing is also correct
   * for a live peer: the tunnel is to the same daemon either way.
   */
  async fportAdd(localPort: number, remote: string): Promise<number> {
    const existing = await this.listForwards().catch(() => new Map<number, string>());
    for (const [port, target] of existing) {
      if (target === remote) {
        this.reused.add(port);
        return port;
      }
    }
    const maxAttempts = 20;
    let lastDetail = "";
    for (let i = 0; i < maxAttempts; i++) {
      const port = localPort + i;
      // A port taken by a different endpoint is not ours to reclaim.
      if (existing.has(port)) continue;
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

  /** The forwards that exist for this target, as local port → remote rule. */
  async listForwards(): Promise<Map<number, string>> {
    const { stdout } = await this.exec(["fport", "ls"], "fport ls");
    const out = new Map<number, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*(\S+)\s+tcp:(\d+)\s+(\S+)\s+\[Forward\]/.exec(line);
      if (!m) continue;
      if (this.deviceId && m[1] !== this.deviceId) continue;
      out.set(Number(m[2]), m[3]!);
    }
    return out;
  }

  /**
   * Removes a forward. `hdc fport rm` needs both the local and remote rules, so
   * the remote is remembered from `fportAdd`; callers that passed a different
   * remote can supply it explicitly.
   *
   * A reused forward is left in place: this process did not create it, and
   * removing it would cut a tunnel a peer may be using.
   */
  async fportRemove(localPort: number, remote?: string): Promise<void> {
    if (this.reused.delete(localPort)) return;
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
