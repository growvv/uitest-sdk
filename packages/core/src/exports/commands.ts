/**
 * `uitest-sdk/commands` — the agent command surface without the CLI.
 *
 * A product that wants the same commands (over MCP, a socket, a test runner)
 * imports this; it does not need `bin.ts` or `cli-main.ts`, which belong to a
 * product, not to the SDK.
 */
export { COMMANDS, CommandRunner } from "../operations/commands.js";
export type { CommandSpec, ArgType, RunnerOptions, RunResult } from "../operations/commands.js";
export { EXIT_CODE, statusOf, actionText, isOk } from "../driver/agent/result.js";
export { exitCodeForError, parseArgv } from "../operations/argv.js";
export type { ParsedArgv } from "../operations/argv.js";
// The class, not just its type: `CoreSession.open()` is how a product that
// brings its own `Device` builds a session, and the API reference documents
// exactly that. Exported as a type only, the recipe it printed did not compile.
export { Session as CoreSession } from "../operations/session.js";
export type { Session as CoreSessionType } from "../operations/session.js";
// The device probe is a library capability: a product's `doctor` command is a
// formatter around this, not its own copy of the capability checks.
export { doctor, renderDoctor, deviceTagOf } from "../operations/doctor.js";
export type { Capabilities, DoctorReport, TargetLister } from "../operations/doctor.js";
