#!/usr/bin/env node
import { CommandRunner } from "./commands.js";
import { main, parseArgv } from "./cli-main.js";
import { agentConnected, connectAgent, mcpEntry } from "./connect.js";
import type { AgentId } from "./connect.js";
import { Device } from "./device.js";
import { HOLD_TASK, handoffDevice, holdDevice, readHold, resolveTag, resumeDevice } from "./hold.js";
import { installSkill, refreshSkill } from "./install-skill.js";
import { McpServer } from "./mcp.js";
import { Session } from "./session.js";
import { UitestError } from "./errors.js";
import { VERSION } from "./version.js";
import { fileURLToPath } from "node:url";

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
  if (first === "connect") return connectMain(argv.slice(1));
  if (first === "hold") return holdMain(argv.slice(1));
  if (first === "handoff") return handoffMain(argv.slice(1));
  if (first === "resume") return resumeMain(argv.slice(1));
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

  // Before the agent reads anything: if the package was upgraded after the
  // skill was installed, bring the copy forward. The skill names the commands
  // this build implements, and an old copy teaches calls that may not exist.
  await refreshSkillQuietly();

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

/**
 * The skill half of an upgrade, on the way into a serving session.
 *
 * Every failure is swallowed: a permissions problem or another agent rewriting
 * the same directory must not stop the MCP server, which is the job the agent
 * actually launched. On success only a real rewrite says anything, so a normal
 * start stays silent on stderr.
 */
async function refreshSkillQuietly(): Promise<void> {
  try {
    const result = await refreshSkill();
    for (const dir of result.updated) {
      process.stderr.write(`uitest-phone: refreshed skill to ${VERSION} at ${dir}\n`);
    }
  } catch {
    // Documentation is never worth failing the session over.
  }
}

/**
 * `uitest-phone hold [--device id] [--state-dir dir]`
 *
 * Takes the device lease so every agent command stops at `lease_held`. This is
 * the takeover: the person says "I have the phone now" and an agent cannot
 * take it back until `resume`.
 */
async function holdMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone hold [--device id] [--state-dir dir]\n\n" +
        "Takes the device so agent commands stop with lease_held. Run\n" +
        "`uitest-phone resume` to hand it back.\n",
    );
    return 0;
  }
  const stateDir = parsed.options.stateDir ?? ".uitest-phone";
  try {
    const tag = await resolveTag(parsed.options.device);
    const result = await holdDevice({ stateDir, tag });
    process.stdout.write(
      `held · the device is yours\n` +
        `device: ${tag}\n` +
        `lease: ${result.path}\n` +
        (result.tookOverFrom
          ? `took over from task: ${result.tookOverFrom} (it stops at its next command)\n`
          : "") +
        `\nAgent commands now stop with lease_held until you run:\n` +
        `  uitest-phone resume --state-dir ${stateDir}\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/**
 * `uitest-phone handoff --reason "..." [--device id] [--state-dir dir]`
 *
 * The agent-initiated takeover: it reached a step only a person can do and
 * gives the phone up instead of guessing. Same lease as `hold`, so the same
 * `resume` hands it back; the reason is stored for whoever reads the lease.
 */
async function handoffMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone handoff --reason <text> [--device id] [--state-dir dir]\n\n" +
        "Asks the person to take the phone for a step only they can do (sign\n" +
        "in, enter a one-time code, unlock it). The agent stops; `resume`\n" +
        "hands the phone back. Agents call this through the MCP tool\n" +
        "uitest_handoff instead of the command line.\n",
    );
    return 0;
  }
  const reason = typeof parsed.args["reason"] === "string" ? parsed.args["reason"].trim() : "";
  if (!reason) {
    process.stderr.write(`error: handoff needs --reason "what the person must do"\n`);
    return 1;
  }
  const stateDir = parsed.options.stateDir ?? ".uitest-phone";
  try {
    const tag = await resolveTag(parsed.options.device);
    const result = await handoffDevice({ stateDir, tag, reason });
    process.stdout.write(
      `handoff · the device is yours\n` +
        `reason: ${reason}\n` +
        `device: ${tag}\n` +
        `lease: ${result.path}\n` +
        (result.tookOverFrom
          ? `took over from task: ${result.tookOverFrom} (it stops at its next command)\n`
          : "") +
        `\nDo the step on the phone, then run:\n` +
        `  uitest-phone resume --state-dir ${stateDir}\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/** `uitest-phone resume [--device id] [--state-dir dir]` */
async function resumeMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone resume [--device id] [--state-dir dir]\n\n" +
        "Hands a device back to agents. Only a hold is released; a lease that\n" +
        "belongs to another task is left alone.\n",
    );
    return 0;
  }
  const stateDir = parsed.options.stateDir ?? ".uitest-phone";
  try {
    const tag = await resolveTag(parsed.options.device);
    const current = await readHold({ stateDir, tag });
    if (!current) {
      process.stdout.write(`nothing to release · ${tag} is free\n`);
      return 0;
    }
    if (current.task !== HOLD_TASK) {
      // Never end a task this command did not start: an agent's own lease is
      // released when that command exits, and killing it here would corrupt
      // whatever it is in the middle of.
      process.stderr.write(
        `error: ${tag} is held by task "${current.task}", not by a hold\n` +
          `only the task that took the device can release it; stop that task instead\n`,
      );
      return 1;
    }
    const released = await resumeDevice({ stateDir, tag });
    process.stdout.write(
      released
        ? `released · ${tag} is free for the next command\n`
        : `nothing to release · ${tag} is free\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/**
 * `uitest-phone connect [--agent claude|codex|gemini|copilot] [--force]`
 *
 * Makes an agent ready to drive the phone: writes the MCP server entry into
 * that agent's own settings file, and installs the skill where it reads
 * skills. Only this package's entry is touched.
 */
async function connectMain(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(
      "usage: uitest-phone connect [--agent claude|codex|gemini|copilot] [--force]\n\n" +
        "Registers the MCP server in the agent's own settings file (only its\n" +
        "entry; comments and order are kept) and writes the skill into the\n" +
        "directories that agent reads:\n" +
        "  claude   ~/.claude.json  +  ~/.claude/skills and ~/.agents/skills\n" +
        "  codex    ~/.codex/config.toml  +  ~/.agents/skills\n" +
        "  gemini   ~/.gemini/settings.json  +  ~/.agents/skills\n" +
        "  copilot  ~/.copilot/mcp-config.json  +  ~/.agents/skills\n\n" +
        "--force replaces a skill that is already installed. A hand-edited\n" +
        "skill is always kept.\n",
    );
    return 0;
  }
  const agent = (typeof parsed.args["agent"] === "string" ? parsed.args["agent"] : "claude") as AgentId;
  const force = parsed.args["force"] === true;
  try {
    const entry = mcpEntry({
      nodePath: process.execPath,
      binPath: fileURLToPath(new URL("./bin.js", import.meta.url)),
      version: VERSION,
    });
    const result = await connectAgent({ agent, entry, force });
    const where = result.registered.created
      ? `created ${result.registered.file}`
      : result.registered.changed
        ? `updated ${result.registered.file}`
        : `unchanged ${result.registered.file}`;
    process.stdout.write(`mcp server · ${where}\n`);
    process.stdout.write(`  command: ${entry.command} ${entry.args.join(" ")}\n`);
    if (result.registered.backup) process.stdout.write(`  backup:  ${result.registered.backup}\n`);
    if (result.skill) {
      process.stdout.write(`skill · written\n`);
      for (const dir of result.skill.dirs) process.stdout.write(`  ${dir}\n`);
    } else if (result.skillKept) {
      process.stdout.write(`skill · kept the existing copy (${result.skillKept})\n`);
    }
    process.stdout.write(
      `\nStart a new ${agent} session: MCP servers are read when a session starts.\n`,
    );
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${message}\n`);
    return e instanceof UitestError ? 2 : 1;
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
        "Writes the bundled skill into the directories agents read:\n" +
        "  <home>/.claude/skills/uitest-phone   (Claude Code)\n" +
        "  <home>/.agents/skills/uitest-phone   (Codex, Copilot CLI, Gemini CLI)\n\n" +
        "An existing SKILL.md is kept unless --force is given. --dir writes one\n" +
        "directory instead of both.\n",
    );
    return 0;
  }
  try {
    const result = await installSkill({ dir, force });
    process.stdout.write(`installed skill in ${result.dirs.length} director${result.dirs.length === 1 ? "y" : "ies"}\n`);
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
