import { COMMANDS, CommandRunner } from "./commands.js";
import type { RunResult } from "./commands.js";
import { Device } from "./device.js";
import { Session } from "./session.js";
import { DeviceStateError, LeaseHeldError, UitestError } from "./errors.js";
import { EXIT_CODE } from "./agent/result.js";
import type { DeviceOptions } from "./device.js";

export interface ParsedArgv {
  command: string | null;
  args: Record<string, string | boolean | string[]>;
  json: boolean;
  help: boolean;
  /** Global flags that configure the session rather than the command. */
  options: {
    task?: string;
    stateDir?: string;
    device?: string;
    readOnly?: boolean;
    confirm?: string;
    apps?: string;
    approvalId?: string;
    settleMs?: number;
    traceShots?: boolean;
  };
}

const GLOBAL_FLAGS = new Set([
  "task",
  "state-dir",
  "device",
  "read-only",
  "confirm",
  "apps",
  "settle-ms",
  "approval-id",
  "trace-shots",
  "json",
  "help",
]);

/** Flags that take no value. A value after one of these belongs to the next flag. */
const BOOLEAN_FLAGS = new Set(["json", "help", "read-only", "trace-shots"]);

/** `--read-only` → `readOnly`; `--state-dir` → `stateDir`. */
function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Parses the CLI's argv. Flags before and after the command are both accepted,
 * because a caller that writes `uitest-phone --json tap --ref 3` should not
 * have to know where the command belongs.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const args: Record<string, string | boolean | string[]> = {};
  const global: Record<string, string | boolean> = {};
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      if (command === null) command = token;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const flag = eq >= 0 ? body.slice(0, eq) : body;
    const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

    if (!inline && BOOLEAN_FLAGS.has(flag)) {
      // The same camelCase key the value-taking path below writes, or
      // `--read-only` would be stored as `read-only` and read as `readOnly`.
      (GLOBAL_FLAGS.has(flag) ? global : args)[camel(flag)] = true;
      continue;
    }
    const next = inline ?? argv[i + 1];
    const hasValue = inline !== undefined || (next !== undefined && !next.startsWith("--"));
    if (inline === undefined && hasValue) i++;
    const value = hasValue ? String(next) : true;

    const target = GLOBAL_FLAGS.has(flag) ? global : args;
    const key = camel(flag);
    const existing = target[key];
    if (existing === undefined) target[key] = value as string | boolean;
    else if (Array.isArray(existing)) existing.push(String(value));
    else target[key] = [String(existing), String(value)];
  }

  const settle = global["settleMs"];
  return {
    command,
    args,
    json: global["json"] === true,
    help: global["help"] === true,
    options: {
      task: str(global["task"]),
      stateDir: str(global["stateDir"]),
      device: str(global["device"]),
      readOnly: global["readOnly"] === true,
      confirm: str(global["confirm"]),
      apps: str(global["apps"]),
      approvalId: str(global["approvalId"]),
      settleMs: settle === undefined ? undefined : Number(settle),
      traceShots: global["traceShots"] === true,
    },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The exit code for a failure that never produced a status.
 *
 * `Session.open` takes the lease before any command runs, so a held device
 * throws instead of returning `lease_held`. Mapping that throw here is what
 * makes the documented exit code 2 reachable at all; every other failure stays
 * 1, the code for "something went wrong, read the message".
 */
export function exitCodeForError(e: unknown): number {
  if (e instanceof LeaseHeldError) return EXIT_CODE.lease_held;
  // Locked, unauthorized or offline: the person has to act, and retrying the
  // same command is futile. 2 is the documented "device is not yours" code.
  if (e instanceof DeviceStateError) return EXIT_CODE[e.state];
  return 1;
}

export function formatHelp(): string {
  const lines = [
    "uitest-phone — drive a HarmonyOS device from a shell or an agent",
    "",
    "usage: uitest-phone <command> [--flag value ...]",
    "",
    "global flags:",
    "  --task <name>        name this task (shown in the lease and the trace)",
    "  --state-dir <dir>    traces, shots and leases (default .uitest-phone)",
    "  --device <id>        hdc target, when several are attached",
    "  --read-only          refuse anything that would change data",
    "  --confirm <rules>    payments,finance,deletes,sends,commits | all | none",
    "  --apps <bundles>     comma-separated allow-list; other apps are blocked",
    "  --approval-id <id>   run one step a person approved",
    "  --settle-ms <n>      how long to wait for the UI to go quiet",
    "  --trace-shots        save a screenshot with every step (+~180 ms each)",
    "  --json               print one JSON document",
    "  --help               this text",
    "",
    "commands:",
  ];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name}`);
    lines.push(`      ${command.description}`);
    for (const [name, arg] of Object.entries(command.args)) {
      const flag = `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      const required = arg.required ? " (required)" : "";
      lines.push(`      ${flag} ${arg.type}${required}  ${arg.description}`);
    }
  }
  lines.push(
    "",
    "not commands (they do not open the device the same way):",
    "  connect              register the MCP server in an agent's settings and install the skill",
    "  hold                 take the device for yourself; agent commands then stop with lease_held",
    "  resume               hand a held device back to agents",
    "  mcp                  serve every command as an MCP tool over stdio",
    "  install-skill        write the bundled skill into the directories agents read",
  );
  return lines.join("\n");
}

export function formatResult(result: RunResult, opts: { json?: boolean } = {}): string {
  if (opts.json) {
    return JSON.stringify({ status: result.status, code: result.code, text: result.text, data: result.data ?? {} });
  }
  if (result.text.startsWith(result.status)) return result.text;
  return `${result.status}\n${result.text}`;
}

/**
 * Opens a session from the global flags, runs one command, and releases.
 *
 * `connect` is a seam for tests; it defaults to the real `Device.connect`.
 */
export async function runCommand(
  parsed: ParsedArgv,
  deviceOptions: DeviceOptions = {},
  connect: (opts: DeviceOptions) => Promise<Device> = (opts) => Device.connect(opts),
): Promise<RunResult> {
  if (!parsed.command) {
    throw new UitestError("no command; run `uitest-phone --help`", "ENOCOMMAND");
  }
  const device = await connect({
    ...deviceOptions,
    deviceId: parsed.options.device ?? deviceOptions.deviceId,
  });
  const stateDir = parsed.options.stateDir ?? ".uitest-phone";
  let session: Session;
  try {
    session = await Session.open(device, {
      task: parsed.options.task ?? parsed.command,
      stateDir,
      policy: {
        readOnly: parsed.options.readOnly,
        confirm: parsed.options.confirm,
        apps: parsed.options.apps?.split(",").map((s) => s.trim()).filter(Boolean),
      },
      settleMs: parsed.options.settleMs,
      traceShots: parsed.options.traceShots,
    });
  } catch (e) {
    // The device is already open at this point. A held lease throws here, and
    // leaving the connection open keeps the process alive until something
    // kills it — a `lease_held` command must exit immediately, not hang.
    await device.dispose?.().catch(() => undefined);
    throw e;
  }
  try {
    const runner = new CommandRunner(session, { stateDir, device });
    return await runner.run(parsed.command, {
      ...parsed.args,
      approvalId: parsed.args["approvalId"] ?? parsed.options.approvalId,
    });
  } finally {
    await session.release();
  }
}

/** The real entry point. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help || !parsed.command) {
    process.stdout.write(`${formatHelp()}\n`);
    return parsed.command ? 0 : 2;
  }
  try {
    const result = await runCommand(parsed);
    process.stdout.write(`${formatResult(result, { json: parsed.json })}\n`);
    return result.code;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = exitCodeForError(e);
    const status =
      e instanceof LeaseHeldError
        ? "lease_held"
        : e instanceof DeviceStateError
          ? e.state
          : "error";
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ status, code, text: message })}\n`);
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    return code;
  }
}
