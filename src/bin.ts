#!/usr/bin/env node
import { CommandRunner } from "./commands.js";
import { main, parseArgv } from "./cli-main.js";
import { Device } from "./device.js";
import { installSkill } from "./install-skill.js";
import { McpServer } from "./mcp.js";
import { Session } from "./session.js";
import { UitestError } from "./errors.js";
import { VERSION } from "./version.js";

/**
 * The published entry point.
 *
 * `mcp` and `install-skill` are long-lived or host-modifying, so they cannot be
 * one more command in `COMMANDS` — a command opens a device, runs one step and
 * exits. Everything else is handed to the normal CLI.
 */
async function run(argv: string[]): Promise<number> {
  const [first] = argv;
  if (first === "mcp") return mcpMain(argv.slice(1));
  if (first === "install-skill") return installSkillMain(argv.slice(1));
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  return main(argv);
}

/**
 * Serves MCP over stdio for the life of the process.
 *
 * Unlike a CLI command, the session is opened once: an MCP client sends many
 * tool calls, and reconnecting the device per call would pay the agent startup
 * and lease churn on every step. Global flags on this subcommand configure the
 * session (`uitest-phone mcp --device 123 --read-only`).
 */
async function mcpMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone mcp [--task name] [--state-dir dir] [--device id] [--read-only]\n" +
        "                       [--confirm rules] [--apps bundles] [--settle-ms n]\n\n" +
        "Serves the uitest-phone commands as MCP tools over stdio.\n",
    );
    return 0;
  }

  const device = await Device.connect({
    deviceId: parsed.options.device,
  });
  const stateDir = parsed.options.stateDir ?? ".uitest-phone";
  const session = await Session.open(device, {
    task: parsed.options.task ?? "mcp",
    stateDir,
    policy: {
      readOnly: parsed.options.readOnly,
      confirm: parsed.options.confirm,
      apps: parsed.options.apps?.split(",").map((s) => s.trim()).filter(Boolean),
    },
    settleMs: parsed.options.settleMs,
    traceShots: parsed.options.traceShots,
  });
  try {
    const runner = new CommandRunner(session, { stateDir, device });
    await new McpServer(runner).serve();
    return 0;
  } finally {
    await session.release();
    await device.dispose();
  }
}

/** `uitest-phone install-skill [--dir <path>] [--force]` */
async function installSkillMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const force = parsed.args["force"] === true;
  const dir = typeof parsed.args["dir"] === "string" ? parsed.args["dir"] : undefined;
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone install-skill [--dir <path>] [--force]\n\n" +
        "Writes the bundled skill into an agent skills directory. The default is\n" +
        "<home>/.claude/skills/uitest-phone; an existing SKILL.md is kept unless\n" +
        "--force is given.\n",
    );
    return 0;
  }
  try {
    const result = await installSkill({ dir, force });
    process.stdout.write(`installed skill in ${result.dir}\n`);
    for (const path of result.written) process.stdout.write(`  ${path}\n`);
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${message}\n`);
    return e instanceof UitestError ? 2 : 1;
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
