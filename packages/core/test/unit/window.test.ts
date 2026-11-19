import { describe, expect, it } from "vitest";
import {
  appWindowCommand,
  openWindow,
  removeWindowProfile,
  resolveBrowserPath,
} from "../../src/viewer/window.js";

describe("appWindowCommand", () => {
  // The platform is always named here. Reading it from the host made this test
  // pass on Windows and fail on CI's Linux, where the same browser is a shell
  // wrapper called `microsoft-edge` — the assertion measured the machine, not
  // the mapping it was written to pin.
  it("opens Edge as an app window, not a tab", () => {
    const cmd = appWindowCommand("edge", "http://127.0.0.1:7042/", "win32");
    expect(cmd.command).toBe("msedge.exe");
    expect(cmd.args).toContain("--app=http://127.0.0.1:7042/");
    expect(cmd.args).toContain("--window-size=1100,900");
  });

  it("opens Chrome the same way", () => {
    const cmd = appWindowCommand("chrome", "http://127.0.0.1:7042/", "win32");
    expect(cmd.command).toBe("chrome.exe");
    expect(cmd.args).toContain("--app=http://127.0.0.1:7042/");
  });

  it("names the Linux wrappers on Linux", () => {
    expect(appWindowCommand("edge", "http://127.0.0.1:7042/", "linux").command).toBe("microsoft-edge");
    expect(appWindowCommand("chrome", "http://127.0.0.1:7042/", "linux").command).toBe("google-chrome");
  });

  // A phone window wants the device's aspect ratio, so the caller sizes it.
  // Without this the mirror opens at the console's 1100x900 and the picture is
  // letterboxed on a 9:20 device.
  it("takes the window size from the caller", () => {
    const cmd = appWindowCommand("edge", "http://127.0.0.1:7050/", "win32", "500,900");
    expect(cmd.args).toContain("--window-size=500,900");
    expect(cmd.args).not.toContain("--window-size=1100,900");
  });

  it("gives the window its own profile when asked", () => {
    const cmd = appWindowCommand("edge", "http://127.0.0.1:7050/", "win32", "500,900", "C:/tmp/p1");
    expect(cmd.args).toContain("--user-data-dir=C:/tmp/p1");
    expect(cmd.args).toContain("--no-first-run");
  });

  it("uses the shared profile when no profile is asked for", () => {
    const cmd = appWindowCommand("edge", "http://127.0.0.1:7050/", "win32");
    expect(cmd.args.some((a) => a.startsWith("--user-data-dir="))).toBe(false);
  });

  /**
   * A browser that joins an already-running instance hands the URL over and
   * the launched process exits within a few hundred milliseconds. Its exit is
   * therefore not the window closing — which is why the mirror, whose whole
   * lifetime is the window's, asks for a profile of its own.
   */
  it("gives each profiled window a different profile directory", () => {
    const profiles: string[] = [];
    // A fake name per call: the real `mkdtemp` touches the disk, and a test
    // that only checks the names should not leave directories behind.
    let n = 0;
    const makeProfile = () => `C:/tmp/uitest-window-${++n}`;
    for (let i = 0; i < 2; i++) {
      openWindow("http://127.0.0.1:7042/", {
        platform: "win32",
        browser: "edge",
        exists: () => false,
        profile: true,
        makeProfile,
        spawn: (_command, args) => {
          profiles.push(args.find((a) => a.startsWith("--user-data-dir="))!);
          return { on: () => undefined };
        },
        print: () => undefined,
      });
    }
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatch(/^--user-data-dir=/);
    expect(profiles[0]).not.toBe(profiles[1]);
  });

  /**
   * A profile directory is 20 MB to 760 MB of browser cache and it is created
   * per window. The first version of `profile: true` never removed it: sixty
   * runs of the mirror acceptance left 65 of them under the temp directory and
   * filled the machine's disk. It must go when the window does.
   */
  it("removes the profile directory when the window closes", async () => {
    const { EventEmitter } = await import("node:events");
    const child = new EventEmitter() as unknown as { unref(): void };
    child.unref = () => undefined;
    let profile = "";
    const removed: string[] = [];
    openWindow("http://127.0.0.1:7042/", {
      platform: "win32",
      browser: "edge",
      exists: () => false,
      profile: true,
      makeProfile: () => "C:/tmp/uitest-window-a",
      spawn: (_command, args) => {
        profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
        return child;
      },
      removeDir: (dir) => removed.push(dir),
      print: () => undefined,
    });
    expect(profile).not.toBe("");
    child.emit("spawn");
    child.emit("exit", 0, null);
    expect(removed).toEqual([profile]);
  });

  it("removes the profile directory when the product closes the window", async () => {
    let profile = "";
    const removed: string[] = [];
    const result = openWindow("http://127.0.0.1:7042/", {
      platform: "win32",
      browser: "edge",
      exists: () => false,
      profile: true,
      makeProfile: () => "C:/tmp/uitest-window-b",
      spawn: (_command, args) => {
        profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
        return { on: () => undefined, pid: 99 };
      },
      kill: () => undefined,
      removeDir: (dir) => removed.push(dir),
      print: () => undefined,
    });
    await result.close?.();
    expect(removed).toEqual([profile]);
  });

  /**
   * Removing the directory right after the kill is not enough. Measured on
   * Windows: `rmSync` of a just-killed Edge profile fails with EPERM for about
   * 590 ms, and the retry used to be a `setTimeout(...).unref()` — an unref'd
   * timer does not hold the event loop, so a product that finishes closing
   * exits first and the retry never runs. A mirror run therefore left one
   * profile per stop, 20-760 MB each, and eventually filled the disk.
   */
  it("retries a removal that fails while the browser is still shutting down", async () => {
    const calls: string[] = [];
    let attempt = 0;
    await removeWindowProfile(
      "C:/tmp/p1",
      (dir) => {
        attempt += 1;
        calls.push(dir);
        if (attempt === 1) {
          const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
      },
      { wait: async () => undefined },
    );
    expect(calls).toEqual(["C:/tmp/p1", "C:/tmp/p1"]);
  });

  it("gives up after a few attempts instead of retrying forever", async () => {
    let attempt = 0;
    await removeWindowProfile(
      "C:/tmp/p1",
      () => {
        attempt += 1;
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
      { wait: async () => undefined },
    );
    expect(attempt).toBe(4);
  });

  /**
   * A browser that is not on PATH does not throw from `spawn`; the failure
   * arrives asynchronously as `error` followed by `close` with a negative exit
   * code. Counting that `close` as the person shutting the window made
   * `uitest-mirror` exit the moment it started on a bench without Edge.
   */
  it("does not report a close for a browser that never launched", async () => {
    const { EventEmitter } = await import("node:events");
    let closes = 0;
    const child = new EventEmitter() as unknown as { unref(): void };
    child.unref = () => undefined;
    openWindow("http://127.0.0.1:7042/", {
      platform: "win32",
      browser: "edge",
      spawn: () => child,
      onClose: () => (closes += 1),
      print: () => undefined,
    });
    // What Node emits for `spawn("msedge.exe")` with no such file.
    (child as unknown as EventEmitter).emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    (child as unknown as EventEmitter).emit("close", -4058, null);
    expect(closes).toBe(0);
  });

  it("reports a close once the browser really ran and exited", async () => {
    const { EventEmitter } = await import("node:events");
    let closes = 0;
    const child = new EventEmitter() as unknown as { unref(): void };
    child.unref = () => undefined;
    openWindow("http://127.0.0.1:7042/", {
      platform: "win32",
      browser: "edge",
      spawn: () => child,
      onClose: () => (closes += 1),
      print: () => undefined,
    });
    (child as unknown as EventEmitter).emit("spawn");
    (child as unknown as EventEmitter).emit("exit", 0, null);
    expect(closes).toBe(1);
  });

  /**
   * `msedge.exe` is not on PATH on a normal Windows install. The product used
   * to spawn the bare name, get an asynchronous `ENOENT`, and open nothing —
   * a mirror that printed a URL and showed no window.
   */
  it("uses the installed path for Edge when it is not on PATH", () => {
    const installed = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    expect(resolveBrowserPath("edge", "win32", (p) => p === installed)).toBe(installed);
  });

  it("falls back to the bare name when no install is found", () => {
    expect(resolveBrowserPath("chrome", "win32", () => false)).toBe("chrome.exe");
  });

  it("opens the browser from its installed path", () => {
    const spawned: string[] = [];
    const result = openWindow("http://127.0.0.1:7042/", {
      platform: "win32",
      browser: "chrome",
      exists: (p) => p === "C:/Program Files/Google/Chrome/Application/chrome.exe",
      spawn: (command) => {
        spawned.push(command);
        return { on: () => undefined };
      },
      print: () => undefined,
    });
    expect(result.opened).toBe(true);
    expect(spawned).toEqual(["C:/Program Files/Google/Chrome/Application/chrome.exe"]);
  });

  /**
   * A product that stops for any reason other than the window — stdin closed,
   * Ctrl+C — must not leave the window it opened pointing at a dead server.
   */
  it("closes the window it opened", async () => {
    const { EventEmitter } = await import("node:events");
    const child = new EventEmitter() as unknown as { unref(): void; pid: number };
    child.unref = () => undefined;
    child.pid = 4242;
    const killed: number[] = [];
    const result = openWindow("http://127.0.0.1:7042/", {
      platform: "win32",
      browser: "edge",
      exists: () => false,
      spawn: () => child,
      kill: (pid) => killed.push(pid),
      print: () => undefined,
    });
    await result.close?.();
    expect(killed).toEqual([4242]);
  });

  it("has nothing to close when no window opened", () => {
    const result = openWindow("http://127.0.0.1:7042/", {
      platform: "linux",
      spawn: () => {
        throw new Error("ENOENT");
      },
      print: () => undefined,
    });
    expect(result.opened).toBe(false);
    expect(result.close).toBeUndefined();
  });

  it("reports the URL when no window can be opened", () => {
    const printed: string[] = [];
    const result = openWindow("http://127.0.0.1:7042/", {
      platform: "linux",
      spawn: () => {
        throw new Error("ENOENT");
      },
      print: (line) => printed.push(line),
    });
    expect(result.opened).toBe(false);
    expect(printed[0]).toContain("http://127.0.0.1:7042/");
  });
});
