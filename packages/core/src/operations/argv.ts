import { DeviceStateError, LeaseHeldError } from "../transport/errors.js";
import { EXIT_CODE } from "../driver/agent/result.js";

export interface ParsedArgv {
  command: string | null;
  /** Every word that was not a flag, after the command. */
  positionals: string[];
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
    approvalScope?: string;
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
  "approval-scope",
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
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      if (command === null) command = token;
      else positionals.push(token);
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
    positionals,
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
      approvalScope: str(global["approvalScope"]),
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
