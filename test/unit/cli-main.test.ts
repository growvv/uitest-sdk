import { describe, it, expect } from "vitest";
import { parseArgv, formatHelp, formatResult, exitCodeForError } from "../../src/cli-main.js";
import { COMMANDS } from "../../src/operations/commands.js";
import { DeviceStateError, LeaseHeldError, UitestError } from "../../src/transport/errors.js";
import { runCommand } from "../../src/cli-main.js";
import { Lease } from "../../src/governance/lease.js";
import { tagOf } from "../../src/operations/session.js";
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
  it("disposes the device when the session cannot open", async () => {
    // A held lease throws out of Session.open, which is *after* Device.connect.
    // Without this the open socket keeps the process alive: a `lease_held`
    // command hung until it was killed instead of exiting with code 2.
    const dir = await mkdtemp(join(tmpdir(), "uitest-rc-"));
    try {
      // Another task owns this device, so Session.open throws on the lease.
      // The lock is filed under the tag Session derives from the device id.
      await mkdir(join(dir, "leases"), { recursive: true });
      await Lease.acquire({ path: join(dir, "leases", `${tagOf("abc")}.lock`), task: "someone else" });

      let disposed = false;
      const parsed = parseArgv(["status"]);
      const err = await runCommand(
        { ...parsed, options: { ...parsed.options, stateDir: dir, task: "mine" } },
        {},
        async () =>
          ({
            deviceId: "abc",
            dispose: async () => {
              disposed = true;
            },
          }) as never,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseHeldError);
      expect(disposed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
