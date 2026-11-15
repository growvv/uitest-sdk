import { describe, it, expect } from "vitest";
import { AppManager } from "../../src/apps.js";
import { AppNotFoundError, LaunchError } from "../../src/errors.js";

const APPS = [
  "com.huawei.hmos.settings",
  "com.huawei.hmos.calculator",
  "com.demo.calculator",
  "com.demo.notes",
].join("\n");

const SETTINGS_DUMP = `com.huawei.hmos.settings:
{
  "entryModuleName": "entry",
  "hapModuleInfos": [
    {
      "name": "entry",
      "mainAbility": "com.huawei.hmos.settings.MainAbility",
      "abilityInfos": [
        { "name": "com.huawei.hmos.settings.MainAbility", "type": 1 }
      ]
    }
  ]
}`;

const CALC_DUMP = `com.huawei.hmos.calculator:
{
  "entryModuleName": "entry",
  "hapModuleInfos": [
    {
      "name": "entry",
      "mainAbility": "CalculatorAbility",
      "abilityInfos": [
        { "name": "CalculatorAbility", "type": 1 }
      ]
    }
  ]
}`;

function fakeHdc(extra: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    async shell(command: string): Promise<string> {
      calls.push(command);
      if (command in extra) return extra[command]!;
      if (command === "bm dump -a") return APPS;
      if (command.startsWith("bm dump -n com.huawei.hmos.settings")) return SETTINGS_DUMP;
      if (command.startsWith("bm dump -n com.huawei.hmos.calculator")) return CALC_DUMP;
      if (command.startsWith("bm dump -n com.demo.calculator")) return CALC_DUMP;
      if (command.startsWith("aa start")) return "start ability successfully.";
      if (command.startsWith("aa force-stop")) return "";
      if (command.startsWith("bm uninstall")) return "uninstall successfully.";
      if (command.startsWith("bm install")) return "install successfully.";
      if (command.startsWith("bm clean")) return "clean data successfully.";
      if (command === "aa dump -l") {
        return `  current mission lists:{
    Mission ID #160  mission name #[#com.demo.notes:EntryAbility]
      AbilityRecord ID #8951
        app name [com.demo.notes]
        main name [EntryAbility]
        bundle name [com.demo.notes]
        state #BACKGROUND
        app state #BACKGROUND
    Mission ID #170  mission name #[#com.huawei.hmos.settings:EntryAbility]
      AbilityRecord ID #9503
        app name [com.huawei.hmos.settings]
        main name [com.huawei.hmos.settings.MainAbility]
        bundle name [com.huawei.hmos.settings]
        state #FOREGROUND
        app state #FOREGROUND
  }`;
      }
      return extra[command] ?? "";
    },
  };
}

describe("AppManager", () => {
  it("lists installed bundles, dropping non-bundle lines", async () => {
    const apps = new AppManager(fakeHdc());
    expect(await apps.list()).toEqual([
      "com.demo.calculator",
      "com.demo.notes",
      "com.huawei.hmos.calculator",
      "com.huawei.hmos.settings",
    ]);
  });

  it("finds bundles by exact name, last segment, then substring", async () => {
    const apps = new AppManager(fakeHdc());
    expect(await apps.find("com.demo.notes")).toEqual(["com.demo.notes"]);
    expect(await apps.find("calculator")).toEqual([
      "com.demo.calculator",
      "com.huawei.hmos.calculator",
    ]);
    expect(await apps.find("note")).toEqual(["com.demo.notes"]);
    expect(await apps.find("nothing-like-this")).toEqual([]);
  });

  it("resolves a known alias after verifying it is installed", async () => {
    const hdc = fakeHdc();
    const apps = new AppManager(hdc);
    expect(await apps.resolveBundle("settings")).toBe("com.huawei.hmos.settings");
    expect(await apps.resolveBundle("Calculator")).toBe("com.huawei.hmos.calculator");
    // One listing for both names: the result is cached for the session.
    expect(hdc.calls.filter((c) => c === "bm dump -a")).toHaveLength(1);
  });

  it("falls through to a name match when the alias is not installed", async () => {
    const hdc = fakeHdc();
    // Only the demo calculator exists, so the Huawei alias must not win.
    hdc.shell = async (command: string) => {
      hdc.calls.push(command);
      if (command === "bm dump -a") return "com.demo.calculator\ncom.demo.notes";
      return "";
    };
    const apps = new AppManager(hdc);
    expect(await apps.resolveBundle("calculator")).toBe("com.demo.calculator");
  });

  it("refuses an ambiguous short name instead of guessing", async () => {
    const apps = new AppManager(fakeHdc());
    const err = await apps.resolveBundle("demo").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppNotFoundError);
    expect((err as Error).message).toContain("com.demo.calculator");
    expect((err as Error).message).toContain("com.demo.notes");
  });

  it("rejects a bundle id that is not installed", async () => {
    const apps = new AppManager(fakeHdc());
    await expect(apps.resolveBundle("com.no.such.app")).rejects.toThrow(/not installed/);
  });

  it("accepts an installed bundle id unchanged", async () => {
    const apps = new AppManager(fakeHdc());
    expect(await apps.resolveBundle("com.demo.notes")).toBe("com.demo.notes");
  });

  it("reads the entry ability in both full and short forms", async () => {
    const apps = new AppManager(fakeHdc());
    expect(await apps.entryAbility("com.huawei.hmos.settings"))
      .toBe("com.huawei.hmos.settings.MainAbility");
    expect(await apps.entryAbility("com.huawei.hmos.calculator")).toBe("CalculatorAbility");
  });

  it("launches with the resolved bundle and ability", async () => {
    const hdc = fakeHdc();
    const apps = new AppManager(hdc);
    const r = await apps.launch("settings");
    expect(r).toMatchObject({
      bundle: "com.huawei.hmos.settings",
      ability: "com.huawei.hmos.settings.MainAbility",
    });
    expect(hdc.calls).toContain(
      "aa start -b com.huawei.hmos.settings -a com.huawei.hmos.settings.MainAbility",
    );
  });

  it("surfaces aa failures instead of reporting success", async () => {
    const hdc = fakeHdc({ "aa start -b com.demo.notes -a EntryAbility": "error: ability does not exist" });
    const apps = new AppManager(hdc);
    await expect(apps.launch("com.demo.notes", { ability: "EntryAbility" }))
      .rejects.toBeInstanceOf(LaunchError);
  });

  it("reports the foreground app from the mission list", async () => {
    const apps = new AppManager(fakeHdc());
    expect(await apps.current()).toEqual({
      bundle: "com.huawei.hmos.settings",
      ability: "com.huawei.hmos.settings.MainAbility",
    });
  });

  it("returns null when nothing is foreground", async () => {
    const apps = new AppManager(fakeHdc({ "aa dump -l": " User ID #100\n current mission lists:{}" }));
    expect(await apps.current()).toBeNull();
  });

  it("stops, uninstalls and clears data with the documented commands", async () => {
    const hdc = fakeHdc();
    const apps = new AppManager(hdc);
    await apps.stop("com.demo.notes");
    await apps.uninstall("com.demo.notes");
    await apps.clearData("com.demo.notes");
    expect(hdc.calls).toContain("aa force-stop com.demo.notes");
    expect(hdc.calls).toContain("bm uninstall -n com.demo.notes");
    expect(hdc.calls).toContain("bm clean -n com.demo.notes -d");
  });

  it("validates a bundle id before running it through a shell", async () => {
    const hdc = fakeHdc();
    const apps = new AppManager(hdc);
    await expect(apps.stop("com.demo.notes; rm -rf /")).rejects.toThrow(/invalid bundle/);
    expect(hdc.calls.some((c) => c.includes("rm -rf"))).toBe(false);
  });

  it("forgets the installed list when asked to refresh", async () => {
    const hdc = fakeHdc();
    const apps = new AppManager(hdc);
    await apps.list();
    await apps.list();
    expect(hdc.calls.filter((c) => c === "bm dump -a")).toHaveLength(1);
    await apps.list({ refresh: true });
    expect(hdc.calls.filter((c) => c === "bm dump -a")).toHaveLength(2);
  });
});
