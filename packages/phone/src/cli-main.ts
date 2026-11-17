import { COMMANDS, CommandRunner, exitCodeForError, parseArgv } from "uitest-sdk/commands";
import type { ParsedArgv, RunResult } from "uitest-sdk/commands";
import { connect, DeviceStateError, LeaseHeldError, UitestError } from "uitest-sdk";
import type { ConnectOptions, DeviceOptions, Session } from "uitest-sdk";
import { AppManager, HdcRunner, resolveAppList } from "uitest-sdk/drivers";

export { exitCodeForError, parseArgv };
export type { ParsedArgv };

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
    "  --approval-scope <s> with the id: once (default), task, or always",
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
    "  approvals            list, allow or deny a step waiting for a person",
    "  connect              register the MCP server in an agent's settings and install the skill",
    "  handoff              ask a person to take the phone for a step only they can do",
    "  hold                 take the device for yourself; agent commands then stop with lease_held",
    "  install-skill        write the bundled skill into the directories agents read",
    "  mcp                  serve every command as an MCP tool over stdio",
    "  resume               hand a held device back to agents",
    "",
    "The browser mirror moved to the console product: npm i -g uitest-console",
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
 * `open` is a seam for tests; it defaults to core's `connect`, which opens the
 * device and the session together and disposes the device when either fails.
 */
export async function runCommand(
  parsed: ParsedArgv,
  deviceOptions: DeviceOptions = {},
  open: (opts: ConnectOptions) => Promise<Session> = connect,
): Promise<RunResult> {
  if (!parsed.command) {
    throw new UitestError("no command; run `uitest-phone --help`", "ENOCOMMAND");
  }
  const stateDir = parsed.options.stateDir ?? ".uitest-phone";
  const deviceId = parsed.options.device ?? deviceOptions.deviceId;

  // The allow-list is written by a person and can name apps the way `launch`
  // does — "settings", not only "com.huawei.hmos.settings". Resolve it before
  // the session opens: a list that matches nothing would otherwise block every
  // app while looking correct. Resolution needs only hdc, not a session, so a
  // bad name fails before the device is taken.
  let appList: string[] | undefined;
  if (parsed.options.apps) {
    const names = parsed.options.apps.split(",").map((s) => s.trim()).filter(Boolean);
    const hdc = new HdcRunner({ ...deviceOptions, ...(deviceId ? { deviceId } : {}) });
    appList = await resolveAppList(new AppManager(hdc), names);
  }

  const session = await open({
    ...deviceOptions,
    ...(deviceId ? { deviceId } : {}),
    task: parsed.options.task ?? parsed.command,
    stateDir,
    policy: {
      readOnly: parsed.options.readOnly,
      confirm: parsed.options.confirm,
      apps: appList,
    },
    settleMs: parsed.options.settleMs,
    traceShots: parsed.options.traceShots,
  });
  try {
    const runner = new CommandRunner(session.core, { stateDir, device: session.device });
    return await runner.run(parsed.command, {
      ...parsed.args,
      approvalId: parsed.args["approvalId"] ?? parsed.options.approvalId,
      approvalScope: parsed.args["approvalScope"] ?? parsed.options.approvalScope,
    });
  } finally {
    await session.close();
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
