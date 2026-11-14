import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
