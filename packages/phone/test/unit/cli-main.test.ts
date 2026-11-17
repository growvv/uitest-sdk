import { describe, it, expect } from "vitest";
import { parseArgv, formatHelp, formatResult, exitCodeForError } from "../../src/cli-main.js";
import { runCommand } from "../../src/cli-main.js";
import { COMMANDS } from "uitest-sdk/commands";
import { DeviceStateError, LeaseHeldError, UitestError, tagOf } from "uitest-sdk";
import { Lease } from "uitest-sdk/govern";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("collects the words after the command as positionals", () => {
    // `approvals allow abc123` has no flags: the id is positional, and
    // dropping it would make the command silently unusable.
    const parsed = parseArgv(["approvals", "allow", "abc123"]);
    expect(parsed.command).toBe("approvals");
    expect(parsed.positionals).toEqual(["allow", "abc123"]);
  });

  it("reads --trace-shots as a session option, not a command argument", () => {
    const parsed = parseArgv(["tap", "--ref", "3", "--trace-shots"]);
    expect(parsed.options.traceShots).toBe(true);
    // It configures the session, so it must not leak into the command's args.
    expect(parsed.args).toEqual({ ref: "3" });
  });

  it("reads --paste as a bare flag on type", () => {
    // A value-less flag that sits next to --text; if the parser took the
    // following token as its value, --text would lose its argument.
    expect(parseArgv(["type", "--paste", "--text", "hi"]).args).toEqual({
      paste: true,
      text: "hi",
    });
    expect(parseArgv(["type", "--text", "hi", "--paste"]).args).toEqual({
      text: "hi",
      paste: true,
    });
  });

  it("reads a kebab-case boolean flag as its camelCase option", () => {
    // A flag stored under its raw spelling is silently ignored by the reader,
    // so `--read-only` would have driven a device without read-only protection.
    expect(parseArgv(["tap", "--ref", "3", "--read-only"]).options.readOnly).toBe(true);
    expect(parseArgv(["tap", "--read-only", "--ref", "3"]).args).toEqual({ ref: "3" });
  });

  it("reads --approval-scope as a session option", () => {
    const parsed = parseArgv(["tap", "--ref", "3", "--approval-scope", "task"]);
    expect(parsed.options.approvalScope).toBe("task");
    expect(parsed.args).toEqual({ ref: "3" });
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

describe("exitCodeForError", () => {
  it("uses exit code 2 for a held lease", () => {
    // The status table documents lease_held as 2. `Session.open` throws before
    // any command runs, so this mapping is the only thing that can produce it;
    // a blanket `return 1` made the documented code unreachable.
    expect(exitCodeForError(new LeaseHeldError("lease_held · busy", "ELEASE"))).toBe(2);
  });

  it("uses exit code 2 for a device that is not usable", () => {
    // Locked, unauthorized or unplugged: the caller must involve a person,
    // and retrying the same command cannot help. Same code as lease_held.
    for (const state of ["device_locked", "device_needs_setup", "device_offline"] as const) {
      expect(exitCodeForError(new DeviceStateError(state, `x · ${state}`, "ESTATE"))).toBe(2);
    }
  });

  it("keeps 1 for everything else", () => {
    expect(exitCodeForError(new UitestError("boom", "EPROTO"))).toBe(1);
    expect(exitCodeForError(new Error("boom"))).toBe(1);
  });
});

describe("runCommand", () => {
  it("closes the session even when the command throws", async () => {
    // Every command shares one session; a failure that skipped close() would
    // leave the lease and the agent socket behind, and the next command would
    // report lease_held for a task that no longer exists.
    const dir = await mkdtemp(join(tmpdir(), "uitest-rc-"));
    try {
      let closed = false;
      const parsed = parseArgv(["nope"]);
      await expect(
        runCommand(
          { ...parsed, options: { ...parsed.options, stateDir: dir, task: "mine" } },
          {},
          async () =>
            ({
              core: {},
              device: {},
              close: async () => {
                closed = true;
              },
            }) as never,
        ),
      ).rejects.toThrow(/unknown command/);
      expect(closed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens the session through the core facade with the parsed policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uitest-rc-"));
    try {
      let seen: Record<string, unknown> = {};
      const parsed = parseArgv(["status", "--task", "mine", "--read-only"]);
      await runCommand(
        { ...parsed, options: { ...parsed.options, stateDir: dir } },
        {},
        async (opts) => {
          seen = opts as Record<string, unknown>;
          return {
            core: {
              assertLease: async () => undefined,
              record: () => undefined,
              reader: { read: async () => null },
            },
            device: {},
            close: async () => undefined,
          } as never;
        },
      ).catch(() => undefined);
      expect(seen["task"]).toBe("mine");
      expect(seen["stateDir"]).toBe(dir);
      expect((seen["policy"] as Record<string, unknown>)["readOnly"]).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
