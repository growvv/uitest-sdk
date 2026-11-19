import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { HdcRunner } from "../../src/transport/hdc.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

type Reply = { code?: number; stdout?: string; stderr?: string };

function fakeHdc(handler: (file: string, args: string[]) => Reply) {
  execFileMock.mockImplementation(
    (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void,
    ) => {
      const r = handler(file, args);
      if (r.code) {
        const err = Object.assign(new Error("Command failed"), { code: r.code });
        cb(err, r.stdout ?? "", r.stderr ?? "");
      } else {
        cb(null, r.stdout ?? "", r.stderr ?? "");
      }
    },
  );
}

beforeEach(() => {
  execFileMock.mockReset();
});

/** The hdc subcommand, with the `-t <id>` prefix removed. */
function sub(args: string[]): string[] {
  return args[0] === "-t" ? args.slice(2) : args;
}

describe("HdcRunner", () => {
  it("returns shell output", async () => {
    fakeHdc(() => ({ stdout: "hello\n" }));
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    expect((await r.shell("whatever")).trim()).toBe("hello");
  });

  it("throws on non-zero exit with stderr in the message", async () => {
    fakeHdc(() => ({ code: 1, stderr: "bad thing" }));
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    await expect(r.shell("x")).rejects.toThrow(/bad thing/);
  });

  it("retries with the next port when fport reports a listen failure", async () => {
    fakeHdc((_file, args) => {
      if (args.includes("tcp:8012")) {
        return { code: 1, stdout: "[Fail]TCP Port listen failed at 8012" };
      }
      return { stdout: "Forwardport result:OK" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    const used = await r.fportAdd(8012, "localabstract:test");
    expect(used).toBe(8013);
  });

  it("reuses a forward that already points at the same endpoint", async () => {
    // A client killed without cleanup (an MCP server killed by its host, a
    // crashed agent) leaves its forward behind. Adding another one every time
    // leaks a port per task, and after a few hundred `hdc fport` refuses new
    // ones. An existing forward to the same endpoint is already the tunnel we
    // want.
    const calls: string[][] = [];
    fakeHdc((_file, args) => {
      calls.push(sub(args));
      if (sub(args)[0] === "fport" && sub(args)[1] === "ls") {
        return { stdout: "dev1    tcp:8012 tcp:8012    [Forward]\ndev1    tcp:8014 tcp:8012    [Forward]\n" };
      }
      return { stdout: "Forwardport result:OK" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe", deviceId: "dev1" });
    expect(await r.fportAdd(8012, "tcp:8012")).toBe(8012);
    expect(calls.some((a) => a.includes("tcp:8012") && a[0] === "fport" && a[1] !== "ls")).toBe(false);
  });

  it("does not reuse a forward to a different endpoint", async () => {
    fakeHdc((_file, args) => {
      if (sub(args)[0] === "fport" && sub(args)[1] === "ls") {
        return { stdout: "dev1    tcp:8012 localabstract:other    [Forward]\n" };
      }
      return { stdout: "Forwardport result:OK" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe", deviceId: "dev1" });
    expect(await r.fportAdd(8012, "tcp:8012")).toBe(8013);
  });

  it("adds a forward when none exists", async () => {
    fakeHdc((_file, args) => {
      if (sub(args)[0] === "fport" && sub(args)[1] === "ls") return { stdout: "[Empty]\n" };
      return { stdout: "Forwardport result:OK" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe", deviceId: "dev1" });
    expect(await r.fportAdd(8012, "tcp:8012")).toBe(8012);
  });

  it("parses list targets", async () => {
    fakeHdc(() => ({ stdout: "dev1\ndev2\n" }));
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    expect(await r.listTargets()).toEqual(["dev1", "dev2"]);
  });

  it("keeps each target's connection state", async () => {
    // `hdc list targets -v` is the only form that says whether a listed
    // target is actually usable: an unauthorized phone is attached but cannot
    // run anything until the person taps Allow, and an offline one is gone.
    fakeHdc(() => ({
      stdout: [
        "dev1\t\tUSB\tConnected\tlocalhost\thdc",
        "dev2\t\tUSB\tUnauthorized\tlocalhost\thdc",
        "dev3\t\tUSB\tOffline\tlocalhost\thdc",
        "[Empty]",
      ].join("\n"),
    }));
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    expect(await r.listTargetDetails()).toEqual([
      { id: "dev1", state: "connected" },
      { id: "dev2", state: "unauthorized" },
      { id: "dev3", state: "offline" },
    ]);
    expect(await r.listTargets()).toEqual(["dev1", "dev2", "dev3"]);
  });
});

describe("HdcRunner file transfer", () => {
  it("sends the local file by absolute path", async () => {
    // Measured: `hdc file send` with a relative local path creates a directory
    // at the remote path and puts the file inside it, so the remote ends up a
    // folder rather than the file the caller named.
    const seen: string[][] = [];
    fakeHdc((_file, args) => {
      seen.push(args);
      return { stdout: "FileTransfer finish" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    await r.push(".work-bench/t.txt", "/data/local/tmp/t.txt");
    expect(seen[0]![0]).toBe("file");
    expect(seen[0]![1]).toBe("send");
    expect(seen[0]![2]).toBe(resolve(".work-bench/t.txt"));
    expect(seen[0]![3]).toBe("/data/local/tmp/t.txt");
  });

  it("receives to the local path as given", async () => {
    const seen: string[][] = [];
    fakeHdc((_file, args) => {
      seen.push(args);
      return { stdout: "FileTransfer finish" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    await r.pull("/data/local/tmp/t.txt", ".work-bench/back.txt");
    expect(seen[0]).toEqual(["file", "recv", "/data/local/tmp/t.txt", ".work-bench/back.txt"]);
  });

  it("throws when hdc reports a failed transfer with exit code 0", async () => {
    // `hdc file recv` exits 0 even when it cannot open the local path, printing
    // `[Fail]Error opening file` on stdout instead. Trusting the exit code made
    // a failed pull look like a successful one: the recording's dispose()
    // resolved and the caller had no file.
    fakeHdc(() => ({
      stdout: "[Fail]Error opening file: no such file or directory, path:E:/x/y.mp4\n",
    }));
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    await expect(r.pull("/data/local/tmp/t.mp4", "E:/x/y.mp4")).rejects.toThrow(/Error opening file/);
  });
});

describe("HdcRunner.command", () => {
  it("runs arbitrary hdc connector commands as an argument vector", async () => {
    const seen: string[][] = [];
    fakeHdc((_file, args) => {
      seen.push(args);
      return { stdout: "ok" };
    });
    const r = new HdcRunner({ hdcPath: "C:/fake/hdc.exe" });
    expect(await r.command(["list", "targets"])).toBe("ok");
    expect(seen[0]).toEqual(["list", "targets"]);
  });
});
