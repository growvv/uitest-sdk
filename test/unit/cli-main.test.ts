import { describe, it, expect } from "vitest";
import { parseArgv, formatHelp, formatResult } from "../../src/cli-main.js";
import { COMMANDS } from "../../src/commands.js";

describe("parseArgv", () => {
  it("parses a command with --key value flags", () => {
    const parsed = parseArgv(["tap", "--ref", "3", "--long"]);
    expect(parsed.command).toBe("tap");
    expect(parsed.args).toEqual({ ref: "3", long: true });
    expect(parsed.json).toBe(false);
  });

  it("accepts --key=value", () => {
    expect(parseArgv(["type", "--text=hello world"]).args).toEqual({ text: "hello world" });
  });

  it("accepts a leading -- before the command", () => {
    expect(parseArgv(["--json", "observe"]).json).toBe(true);
  });

  it("collects repeated flags into an array", () => {
    expect(parseArgv(["batch", "--step", "a", "--step", "b"]).args).toEqual({
      step: ["a", "b"],
    });
  });

  it("returns no command for an empty argv", () => {
    expect(parseArgv([]).command).toBeNull();
  });

  it("reads --trace-shots as a session option, not a command argument", () => {
    const parsed = parseArgv(["tap", "--ref", "3", "--trace-shots"]);
    expect(parsed.options.traceShots).toBe(true);
    // It configures the session, so it must not leak into the command's args.
    expect(parsed.args).toEqual({ ref: "3" });
  });

  it("reads a kebab-case boolean flag as its camelCase option", () => {
    // A flag stored under its raw spelling is silently ignored by the reader,
    // so `--read-only` would have driven a device without read-only protection.
    expect(parseArgv(["tap", "--ref", "3", "--read-only"]).options.readOnly).toBe(true);
    expect(parseArgv(["tap", "--read-only", "--ref", "3"]).args).toEqual({ ref: "3" });
  });
});

describe("formatHelp", () => {
  it("lists every command with its arguments", () => {
    const help = formatHelp();
    for (const command of COMMANDS) expect(help).toContain(command.name);
    expect(help).toContain("--ref");
    expect(help).toContain("--approval-id");
  });
});

describe("formatResult", () => {
  it("prints the status line first", () => {
    const text = formatResult({ status: "settled", code: 0, text: "screen 1\nline" });
    expect(text.split("\n")[0]).toMatch(/^settled/);
  });

  it("prints a JSON document when asked", () => {
    const text = formatResult(
      { status: "not_found", code: 1, text: "nope", data: { query: "x" } },
      { json: true },
    );
    expect(JSON.parse(text)).toMatchObject({ status: "not_found", text: "nope", data: { query: "x" } });
  });
});
