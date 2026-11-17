/**
 * `uitest-sdk/commands` — the agent command surface without the CLI.
 *
 * A product that wants the same commands (over MCP, a socket, a test runner)
 * imports this; it does not need `bin.ts` or `cli-main.ts`, which belong to a
 * product, not to the SDK.
 */
export { COMMANDS, CommandRunner } from "../operations/commands.js";
export type { CommandSpec, ArgType, RunnerOptions, RunResult } from "../operations/commands.js";
export { EXIT_CODE } from "../driver/agent/result.js";
export { exitCodeForError, parseArgv } from "../operations/argv.js";
export type { ParsedArgv } from "../operations/argv.js";
export type { Session as CoreSession } from "../operations/session.js";
