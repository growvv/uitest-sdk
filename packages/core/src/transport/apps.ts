import type { HdcRunner } from "./hdc.js";
import { AppNotFoundError, LaunchError, UitestError } from "./errors.js";

/** The subset of HdcRunner AppManager needs; keeps tests free of the real hdc. */
export interface ShellRunner {
  shell(command: string): Promise<string>;
}

export interface AppInfo {
  bundle: string;
  ability?: string;
}

export interface LaunchOptions {
  /** Ability name as declared in module.json5. Resolved when omitted. */
  ability?: string;
}

export interface LaunchResult {
  bundle: string;
  ability: string;
  output: string;
}

export interface ListOptions {
  /** Drop the cached `bm dump -a` result and ask the device again. */
  refresh?: boolean;
}

/**
 * Common short names. Only used when the caller passed a name with no dot, and
 * only returned when the alias is actually installed — an alias is a hint, not
 * an assertion about what the device has.
 */
const ALIASES: Record<string, string> = {
  settings: "com.huawei.hmos.settings",
  launcher: "com.huawei.hmos.sceneboard",
  home: "com.huawei.hmos.sceneboard",
  camera: "com.huawei.hmos.camera",
  photos: "com.huawei.hmos.photos",
  gallery: "com.huawei.hmos.photos",
  clock: "com.huawei.hmos.clock",
  calendar: "com.huawei.hmos.calendar",
  calculator: "com.huawei.hmos.calculator",
};

const BUNDLE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

/** Bundle ids reach the device through a shell, so anything else is refused. */
function assertBundle(bundle: string): string {
  if (!BUNDLE_RE.test(bundle)) {
    throw new UitestError(
      `invalid bundle id: ${JSON.stringify(bundle)}`,
      "EINVALIDBUNDLE",
    );
  }
  return bundle;
}

interface AbilityInfo {
  name?: string;
  type?: number;
}

interface ModuleInfo {
  name?: string;
  mainAbility?: string;
  abilityInfos?: AbilityInfo[];
}

interface BundleDump {
  entryModuleName?: string;
  hapModuleInfos?: ModuleInfo[];
}

/** Pulls the JSON object out of `bm dump -n`, which prefixes a header line. */
function parseDump(output: string): BundleDump | null {
  const start = output.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start)) as BundleDump;
  } catch {
    return null;
  }
}

/** One `Mission ID #...` block from `aa dump -l`. */
function missionBlocks(output: string): string[] {
  return output.split(/Mission ID #/).slice(1);
}

/**
 * Installed apps on one device: listing, name resolution, launch, and the
 * lifecycle commands an agent needs around a test.
 *
 * `aa start -a` wants the ability name *as declared*, which is not always the
 * full `mainAbility` string: Settings declares
 * `com.huawei.hmos.settings.MainAbility`, Calculator declares
 * `CalculatorAbility`. Resolution tries the exact declared name, then the last
 * segment, then any PAGE ability, then anything.
 */
export class AppManager {
  private cache: string[] | null = null;
  private labels: { bundle: string; label: string }[] | null = null;

  constructor(private readonly hdc: ShellRunner) {}

  async list(opts: ListOptions = {}): Promise<string[]> {
    if (this.cache && !opts.refresh) return [...this.cache];
    const out = await this.hdc.shell("bm dump -a");
    const bundles = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => BUNDLE_RE.test(line));
    this.cache = [...new Set(bundles)].sort();
    return [...this.cache];
  }

  /**
   * Installed bundles with the name the launcher shows under each icon.
   *
   * `bm dump -a` lists ids only, which is not what an agent has to go on: a
   * task written in Chinese names the app the way the launcher does ("天气",
   * "微博"), and those names appear nowhere in a bundle id. Measured on the
   * test phone, 13 of the first 24 `launch` calls failed this way.
   */
  async labelsOf(): Promise<{ bundle: string; label: string }[]> {
    if (this.labels) return this.labels;
    const out = await this.hdc.shell("bm dump -a -l");
    const start = out.indexOf("[");
    if (start < 0) return (this.labels = []);
    let parsed: { bundleName?: unknown; label?: unknown }[];
    try {
      parsed = JSON.parse(out.slice(start)) as typeof parsed;
    } catch {
      return (this.labels = []);
    }
    const rows: { bundle: string; label: string }[] = [];
    for (const row of Array.isArray(parsed) ? parsed : []) {
      const bundle = typeof row?.bundleName === "string" ? row.bundleName : "";
      const label = typeof row?.label === "string" ? row.label.trim() : "";
      // A label that is still a resource reference (`$string:app_name`) says
      // nothing to a person, so it is not a name to match on.
      if (bundle && label && !label.startsWith("$")) rows.push({ bundle, label });
    }
    return (this.labels = rows);
  }

  /** Bundles whose launcher label is exactly `name`. */
  async byLabel(name: string): Promise<string[]> {
    const needle = name.trim();
    if (!needle) return [];
    const rows = await this.labelsOf();
    const exact = rows.filter((r) => r.label === needle).map((r) => r.bundle);
    if (exact.length) return exact;
    // Case-insensitive, then a label that contains the name — the launcher
    // truncates long names, so "美团外卖" may read "美团外…".
    const lower = needle.toLowerCase();
    const folded = rows.filter((r) => r.label.toLowerCase() === lower).map((r) => r.bundle);
    if (folded.length) return folded;
    return rows
      .filter((r) => r.label.toLowerCase().includes(lower) || lower.includes(r.label.toLowerCase()))
      .map((r) => r.bundle);
  }

  /**
   * Bundles matching `query`, best match first: exact bundle, last segment,
   * then substring. Case-insensitive; an empty query lists everything.
   */
  async find(query: string): Promise<string[]> {
    const needle = query.trim().toLowerCase();
    const all = await this.list();
    if (!needle) return all;
    const exact: string[] = [];
    const segment: string[] = [];
    const partial: string[] = [];
    for (const bundle of all) {
      const lower = bundle.toLowerCase();
      if (lower === needle) exact.push(bundle);
      else if (lower.endsWith(`.${needle}`)) segment.push(bundle);
      else if (lower.includes(needle)) partial.push(bundle);
    }
    return [...exact, ...segment, ...partial];
  }

  async has(bundle: string): Promise<boolean> {
    const needle = bundle.trim().toLowerCase();
    return (await this.list()).some((b) => b.toLowerCase() === needle);
  }

  /**
   * Turns a user-facing app name into an installed bundle id.
   *
   * A full bundle id must be installed. A short name resolves through the
   * alias table first (no device call), then by suffix match. More than one
   * match is an error that names the candidates: picking one silently would
   * launch an app the caller did not ask for.
   */
  async resolveBundle(app: string): Promise<string> {
    const raw = String(app ?? "").trim();
    if (!raw) throw new AppNotFoundError("not_found: an app name or bundle id is required", "ENOAPP");
    const lower = raw.toLowerCase();

    if (raw.includes(".")) {
      assertBundle(raw);
      if (await this.has(raw)) return raw;
      throw new AppNotFoundError(
        `not_found: ${raw} is not installed. Run apps to list bundles.`,
        "ENOAPP",
      );
    }

    const alias = ALIASES[lower];
    if (alias && (await this.has(alias))) return alias;

    const matches = await this.find(raw);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      // Not part of any bundle id — try the name the launcher shows, which is
      // what a task written in Chinese names the app by.
      const byLabel = await this.byLabel(raw);
      if (byLabel.length === 1) return byLabel[0]!;
      if (byLabel.length > 1) {
        throw new AppNotFoundError(
          `not_found: "${raw}" is ambiguous; candidates: ${byLabel.join(", ")}. Pass the full bundle id.`,
          "EAMBIGUOUS",
        );
      }
      throw new AppNotFoundError(
        `not_found: no installed app matches "${raw}". Run apps to list bundles.`,
        "ENOAPP",
      );
    }
    // More than one bundle id matched. A display-name match narrows it: "笔记"
    // is not a substring of any bundle id, but it is the label of exactly one.
    if (matches.length > 1) {
      const byLabel = (await this.byLabel(raw)).filter((b) => matches.includes(b));
      if (byLabel.length === 1) return byLabel[0]!;
    }
    throw new AppNotFoundError(
      `not_found: "${raw}" is ambiguous; candidates: ${matches.join(", ")}. Pass the full bundle id.`,
      "EAMBIGUOUS",
    );
  }

  /** The ability `aa start -a` should receive for a bundle, or null. */
  async entryAbility(bundle: string): Promise<string | null> {
    assertBundle(bundle);
    const dump = parseDump(await this.hdc.shell(`bm dump -n ${bundle}`));
    if (!dump) return null;
    const modules = Array.isArray(dump.hapModuleInfos) ? dump.hapModuleInfos : [];
    const entry = modules.find((m) => m?.name === dump.entryModuleName) ?? modules[0];
    const abilities = (entry?.abilityInfos ?? []).filter((a) => a?.name);
    const main = entry?.mainAbility ?? "";
    const exact = abilities.find((a) => a.name === main);
    if (exact?.name) return exact.name;
    const tail = main.includes(".") ? main.slice(main.lastIndexOf(".") + 1) : main;
    const byTail = abilities.find((a) => a.name === tail);
    if (byTail?.name) return byTail.name;
    const page = abilities.find((a) => a.type === 1);
    if (page?.name) return page.name;
    for (const module of modules) {
      const list = (module?.abilityInfos ?? []).filter((a) => a?.name);
      if (list.length) return (list.find((a) => a.type === 1) ?? list[0])!.name!;
    }
    return null;
  }

  /**
   * Starts an app. The ability is resolved from `bm dump` unless supplied, and
   * an `aa start` failure is surfaced — `aa` can print an error on stdout while
   * still exiting 0.
   */
  async launch(app: string, opts: LaunchOptions = {}): Promise<LaunchResult> {
    const bundle = await this.resolveBundle(app);
    const ability = opts.ability ?? (await this.entryAbility(bundle));
    if (!ability) {
      throw new LaunchError(
        `launch failed: no entry ability found for ${bundle}; pass an ability name`,
        "ENOABILITY",
      );
    }
    const output = await this.hdc.shell(`aa start -b ${bundle} -a ${ability}`);
    if (/error|fail|not found|does not exist/i.test(output) && !/success/i.test(output)) {
      throw new LaunchError(
        `launch failed: ${output.trim() || "aa returned no output"}`,
        "ELAUNCH",
      );
    }
    return { bundle, ability, output };
  }

  /**
   * The foreground mission, or null. `aa dump -l` lists missions newest first
   * and marks the visible one `state #FOREGROUND`; a device that has just been
   * unlocked may report none.
   */
  async current(): Promise<AppInfo | null> {
    const out = await this.hdc.shell("aa dump -l");
    // More than one mission can say FOREGROUND: the device leaves the state
    // on a mission it pushed to the background and reports the same word for
    // both. The one on top is the one started last, so take the greatest
    // `start time` rather than the first block in the dump — taking the first
    // reported WPS while Zhihu was on screen.
    let best: { at: number; info: AppInfo } | null = null;
    for (const block of missionBlocks(out)) {
      const state = /state #(\w+)/.exec(block)?.[1];
      const bundle = /bundle name \[([^\]]+)\]/.exec(block)?.[1];
      if (!bundle || state !== "FOREGROUND") continue;
      const ability = /main name \[([^\]]+)\]/.exec(block)?.[1];
      // A dump without a start time still beats "none found": fall back to the
      // first foreground mission, which is what older builds did.
      const at = Number(/start time \[(\d+)\]/.exec(block)?.[1] ?? 0);
      const info = ability ? { bundle, ability } : { bundle };
      if (!best || at > best.at) best = { at, info };
    }
    return best?.info ?? null;
  }

  async stop(bundle: string): Promise<void> {
    await this.hdc.shell(`aa force-stop ${assertBundle(bundle)}`);
  }

  async uninstall(bundle: string): Promise<string> {
    const out = await this.hdc.shell(`bm uninstall -n ${assertBundle(bundle)}`);
    this.cache = null;
    return out.trim();
  }

  async install(hapPath: string): Promise<string> {
    const out = await this.hdc.shell(`bm install -p ${hapPath}`);
    this.cache = null;
    return out.trim();
  }

  /** Clears app data without uninstalling. `-d` keeps the bundle's debug state. */
  async clearData(bundle: string): Promise<string> {
    const out = await this.hdc.shell(`bm clean -n ${assertBundle(bundle)} -d`);
    return out.trim();
  }
}

export type { HdcRunner };

/**
 * Turns an allow-list of names into the bundle ids it means.
 *
 * `--apps` used to take bundle ids only, while `launch` takes a short name or a
 * bundle id. On a real device `--apps calculator` therefore matched nothing and
 * blocked the calculator along with everything else: the list was correct and
 * the app was still refused. Resolving through the same path `launch` uses
 * makes the two agree, and an entry that resolves to nothing is an error rather
 * than a silently narrower (or wider) list.
 */
export async function resolveAppList(apps: AppManager, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const bundle = await apps.resolveBundle(name);
    if (!out.includes(bundle)) out.push(bundle);
  }
  return out;
}
