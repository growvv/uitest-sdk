import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { HdcRunner } from "../../src/hdc.js";

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
