import { describe, expect, it } from "vitest";
import { appWindowCommand, openWindow } from "../../src/viewer/window.js";

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
