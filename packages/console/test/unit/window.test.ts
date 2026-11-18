import { describe, expect, it } from "vitest";
import { appWindowCommand, openWindow } from "../../src/window.js";

describe("appWindowCommand", () => {
  // The platform is always named here. Reading it from the host made this test
  // pass on Windows and fail on CI's Linux, where the same browser is a shell
  // wrapper called `microsoft-edge` — the assertion measured the machine, not
  // the mapping it was written to pin.
  it("opens Edge as an app window, not a tab", () => {
    // A tab brings the address bar and the tab strip, which is what makes a
    // mirror feel like a browser page rather than a device window.
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

  it("reports the URL when no window can be opened", () => {
    // A bench without Edge or Chrome must still be usable: the URL is printed
    // and the person opens it themselves.
    const printed: string[] = [];
    const result = openWindow("http://127.0.0.1:7042/", {
      platform: "linux",
      spawn: () => {
        throw new Error("ENOENT");
      },
      print: (line) => printed.push(line),
    });
    expect(result.opened).toBe(false);
    expect(printed.join("\n")).toContain("http://127.0.0.1:7042/");
  });
});
