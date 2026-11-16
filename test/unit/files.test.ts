import { describe, it, expect } from "vitest";
import { Files } from "../../src/files.js";
import { UitestError } from "../../src/errors.js";
import type { HdcRunner } from "../../src/hdc.js";

function fakeHdc(output: string | ((cmd: string) => string) = "") {
  const calls: string[] = [];
  const pushed: string[] = [];
  const pulled: string[] = [];
  const hdc = {
    async shell(cmd: string) {
      calls.push(cmd);
      return typeof output === "string" ? output : output(cmd);
    },
    async push(local: string, remote: string) {
      pushed.push(`${local}->${remote}`);
    },
    async pull(remote: string, local: string) {
      pulled.push(`${remote}->${local}`);
    },
  };
  return { files: new Files(hdc as unknown as HdcRunner), calls, pushed, pulled };
}

const listing = [
  "total 8",
  "-rw-r--r-- 1 shell shell 4096 2026-11-16 14:00 mytest.mp4",
  "drwxr-xr-x 2 shell shell 4096 2026-11-16 14:01 a folder",
].join("\n");

describe("Files", () => {
  it("lists a directory with names, sizes and types", async () => {
    const { files, calls } = fakeHdc(listing);
    const entries = await files.list("/data/local/tmp");
    expect(calls).toEqual(["ls -l '/data/local/tmp'"]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: "mytest.mp4",
      path: "/data/local/tmp/mytest.mp4",
      size: 4096,
      isDir: false,
      mode: "-rw-r--r--",
      mtime: "2026-11-16 14:00",
    });
    expect(entries[1]!.name).toBe("a folder");
    expect(entries[1]!.isDir).toBe(true);
    expect(entries[1]!.path).toBe("/data/local/tmp/a folder");
  });

  it("stats one path and returns null when it is missing", async () => {
    const { files } = fakeHdc("-rw-r--r-- 1 shell shell 12 2026-11-16 14:00 /data/local/tmp/x");
    expect((await files.stat("/data/local/tmp/x"))?.size).toBe(12);

    const missing = fakeHdc(() => {
      throw new Error("ls: /nope: No such file or directory");
    });
    expect(await missing.files.stat("/nope")).toBeNull();
    expect(await missing.files.exists("/nope")).toBe(false);
  });

  it("quotes paths with spaces and single quotes", async () => {
    const { files, calls } = fakeHdc("");
    await files.mkdir("/data/local/tmp/it's here", { parents: true });
    expect(calls[0]).toBe(`mkdir -p '/data/local/tmp/it'\\''s here'`);
  });

  it("recurses only when asked", async () => {
    const { files, calls } = fakeHdc("");
    await files.remove("/data/local/tmp/a");
    await files.remove("/data/local/tmp/b", { recursive: true });
    expect(calls).toEqual(["rm -f '/data/local/tmp/a'", "rm -rf '/data/local/tmp/b'"]);
  });

  it("refuses to delete an empty path or the root", async () => {
    const { files, calls } = fakeHdc("");
    await expect(files.remove("")).rejects.toThrow(UitestError);
    await expect(files.remove("/")).rejects.toThrow(UitestError);
    expect(calls).toEqual([]);
  });

  it("moves a file with both paths quoted", async () => {
    const { files, calls } = fakeHdc("");
    await files.move("/data/local/tmp/a b", "/data/local/tmp/c d");
    expect(calls).toEqual(["mv '/data/local/tmp/a b' '/data/local/tmp/c d'"]);
  });

  it("delegates transfers to hdc", async () => {
    const { files, pushed, pulled } = fakeHdc("");
    await files.push("./local.mp4", "/data/local/tmp/x.mp4");
    await files.pull("/data/local/tmp/x.mp4", "./out.mp4");
    expect(pushed).toEqual(["./local.mp4->/data/local/tmp/x.mp4"]);
    expect(pulled).toEqual(["/data/local/tmp/x.mp4->./out.mp4"]);
  });

  it("caps readText so a huge file cannot exhaust memory", async () => {
    const { files, calls } = fakeHdc("hello");
    expect(await files.readText("/data/local/tmp/x")).toBe("hello");
    expect(calls).toEqual(["head -c 1048576 '/data/local/tmp/x'"]);
    await files.readText("/data/local/tmp/x", 100);
    expect(calls[1]).toBe("head -c 100 '/data/local/tmp/x'");
  });

  it("clamps readText's cap to a sane range", async () => {
    const { files, calls } = fakeHdc("");
    await files.readText("/x", 0);
    expect(calls[0]).toBe("head -c 1 '/x'");
  });

  it("skips the total line and anything unparsable", async () => {
    const { files } = fakeHdc("total 4\nls: cannot access /x/*: No such file or directory\n");
    expect(await files.list("/x")).toEqual([]);
  });
});
