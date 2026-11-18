import { UitestError } from "../../transport/errors.js";

/**
 * The device's string matching modes. The numbers are the enum the extension
 * accepts as the optional second argument to `On.text` and friends.
 */
export type MatchMode =
  | "exact"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "regex_i";

const MATCH_MODES: Record<MatchMode, number> = {
  exact: 0,
  contains: 1,
  starts_with: 2,
  ends_with: 3,
  regex: 4,
  regex_i: 5,
};

function matchArg(mode: MatchMode): number {
  const value = MATCH_MODES[mode];
  if (value === undefined) {
    throw new UitestError(
      `unknown match mode ${JSON.stringify(mode)}; use exact, contains, starts_with, ends_with, regex or regex_i`,
      "EINVALIDSELECTOR",
    );
  }
  return value;
}

function matchSymbol(mode: MatchMode): string {
  return mode === "exact" ? "=" : "~=";
}

/**
 * A device-side `On` predicate, as the extension expects it: an API name, its
 * arguments, and the object to call it on.
 *
 * The extension's `On` objects are chainable — calling `On.type("Button")` with
 * another `On` as `this` narrows it. `toArgs()` returns exactly what
 * `callHypiumApi` needs, and `toString()` describes the predicate for error
 * messages and approval text.
 */
export class On {
  private constructor(
    /** Null only for a raw reference the caller built themselves. */
    readonly api: string | null,
    readonly args: unknown[],
    /** A raw reference, or the parent selector this one narrows. */
    readonly target: string | On,
    readonly text: string,
  ) {}

  /** Text matching `value`. Exact by default. */
  static text(value: string, mode: MatchMode = "exact", parent?: On): On {
    return On.make("On.text", [value, matchArg(mode)], `text${matchSymbol(mode)}${JSON.stringify(value)}`, parent);
  }

  /**
   * Component type. Names are case-sensitive on the device: `"Button"` matches,
   * `"button"` finds nothing.
   */
  static type(value: string, parent?: On): On {
    return On.make("On.type", [value], `type=${value}`, parent);
  }

  /** Component id. Exact by default. */
  static id(value: string, mode: MatchMode = "exact", parent?: On): On {
    return On.make("On.id", [value, matchArg(mode)], `id${matchSymbol(mode)}${JSON.stringify(value)}`, parent);
  }

  /** Accessibility description. */
  static description(value: string, mode: MatchMode = "exact", parent?: On): On {
    return On.make(
      "On.description",
      [value, matchArg(mode)],
      `description${matchSymbol(mode)}${JSON.stringify(value)}`,
      parent,
    );
  }

  /** Placeholder / hint text. */
  static hint(value: string, mode: MatchMode = "exact", parent?: On): On {
    return On.make("On.hint", [value, matchArg(mode)], `hint${matchSymbol(mode)}${JSON.stringify(value)}`, parent);
  }

  /** Accessibility id, as reported by the device. */
  static accessibilityId(value: string, mode: MatchMode = "exact", parent?: On): On {
    return On.make(
      "On.accessibilityId",
      [value, matchArg(mode)],
      `accessibilityId${matchSymbol(mode)}${JSON.stringify(value)}`,
      parent,
    );
  }

  /** The text before any formatter or obfuscation was applied. */
  static originalText(value: string, mode: MatchMode = "exact", parent?: On): On {
    return On.make(
      "On.originalText",
      [value, matchArg(mode)],
      `originalText${matchSymbol(mode)}${JSON.stringify(value)}`,
      parent,
    );
  }

  static selected(value = true, parent?: On): On {
    return On.make("On.selected", [value], `selected=${value}`, parent);
  }

  static longClickable(value = true, parent?: On): On {
    return On.make("On.longClickable", [value], `longClickable=${value}`, parent);
  }

  static checkable(value = true, parent?: On): On {
    return On.make("On.checkable", [value], `checkable=${value}`, parent);
  }

  static clickable(value = true, parent?: On): On {
    return On.make("On.clickable", [value], `clickable=${value}`, parent);
  }

  static scrollable(value = true, parent?: On): On {
    return On.make("On.scrollable", [value], `scrollable=${value}`, parent);
  }

  static enabled(value = true, parent?: On): On {
    return On.make("On.enabled", [value], `enabled=${value}`, parent);
  }

  static checked(value = true, parent?: On): On {
    return On.make("On.checked", [value], `checked=${value}`, parent);
  }

  static focused(value = true, parent?: On): On {
    return On.make("On.focused", [value], `focused=${value}`, parent);
  }

  /** A reference the caller obtained from the device directly. */
  static raw(ref: string, text = ref): On {
    return new On(null, [], ref, text);
  }

  /** Narrows this predicate with another. */
  and(next: On): On {
    return next.chainedOnto(this);
  }

  /**
   * `callHypiumApi` arguments: [api, args, this]. A chained predicate's `this`
   * is its parent, which must be resolved on the device first.
   */
  toArgs(): [string | null, unknown[], string | On] {
    return [this.api, this.args, this.target];
  }

  toString(): string {
    return this.text;
  }

  private chainedOnto(parent: On): On {
    return new On(this.api, this.args, parent, `${parent.text} & ${this.text}`);
  }

  private static make(api: string, args: unknown[], text: string, parent?: On): On {
    return parent
      ? new On(api, args, parent, `${parent.text} & ${text}`)
      : new On(api, args, "On#seed", text);
  }
}

export function selectorText(selector: On | string | number): string {
  if (typeof selector === "string") return selector;
  if (typeof selector === "number") return `ref ${selector}`;
  return selector.toString();
}

/**
 * Parses the one-line selector form used by the CLI and MCP tools:
 *
 *     text=WLAN             exact text
 *     text~=WLAN            text contains
 *     type=Button           component type (case-sensitive on the device)
 *     id=id_content         component id
 *     clickable             a bare predicate means "true"
 *     type=Button&text=Save chain with &
 *
 * Values may be quoted, which is the only way to include `&` or `=` in one.
 * Splitting is done by hand rather than with a regex because quotes have to be
 * respected.
 */
export function parseOn(spec: string): On {
  const text = String(spec ?? "").trim();
  if (!text) {
    throw new UitestError("empty selector; use e.g. text=WLAN or type=Button&clickable", "EINVALIDSELECTOR");
  }

  let selector: On | undefined;
  for (const part of splitOutsideQuotes(text, "&")) {
    const term = part.trim();
    if (!term) continue;
    const eq = indexOutsideQuotes(term, "=");
    if (eq < 0) {
      selector = applyPredicate(term, null, selector);
      continue;
    }
    const contains = term[eq - 1] === "~";
    const name = term.slice(0, contains ? eq - 1 : eq).trim().toLowerCase();
    const value = unquote(term.slice(eq + 1).trim());
    selector = applyPredicate(name, value, selector, contains);
  }
  if (!selector) {
    throw new UitestError(`empty selector: ${JSON.stringify(spec)}`, "EINVALIDSELECTOR");
  }
  return selector;
}

function applyPredicate(name: string, value: string | null, parent?: On, contains = false): On {
  const mode = contains ? "contains" : "exact";
  switch (name) {
    case "text":
      if (value === null) throw new UitestError("text= needs a value", "EINVALIDSELECTOR");
      return On.text(value, mode, parent);
    case "type":
      if (value === null) throw new UitestError("type= needs a value", "EINVALIDSELECTOR");
      return On.type(value, parent);
    case "id":
      if (value === null) throw new UitestError("id= needs a value", "EINVALIDSELECTOR");
      return On.id(value, mode, parent);
    case "clickable":
      return On.clickable(flag(value), parent);
    case "scrollable":
      return On.scrollable(flag(value), parent);
    case "enabled":
      return On.enabled(flag(value), parent);
    case "checked":
      return On.checked(flag(value), parent);
    case "focused":
      return On.focused(flag(value), parent);
    case "description":
      if (value === null) throw new UitestError("description= needs a value", "EINVALIDSELECTOR");
      return On.description(value, mode, parent);
    case "hint":
      if (value === null) throw new UitestError("hint= needs a value", "EINVALIDSELECTOR");
      return On.hint(value, mode, parent);
    case "accessibilityid":
    case "accessibility_id":
      if (value === null) throw new UitestError("accessibilityId= needs a value", "EINVALIDSELECTOR");
      return On.accessibilityId(value, mode, parent);
    case "originaltext":
    case "original_text":
      if (value === null) throw new UitestError("originalText= needs a value", "EINVALIDSELECTOR");
      return On.originalText(value, mode, parent);
    case "selected":
      return On.selected(flag(value), parent);
    case "longclickable":
      return On.longClickable(flag(value), parent);
    case "checkable":
      return On.checkable(flag(value), parent);
    default:
      throw new UitestError(
        `unknown predicate "${name}"; use text=, text~=, type=, id=, ` +
          `description=, hint=, accessibilityId=, originalText=, clickable, ` +
          `longClickable, scrollable, enabled, focused, selected, checked or checkable`,
        "EINVALIDSELECTOR",
      );
  }
}

function flag(value: string | null): boolean {
  if (value === null) return true;
  return !/^(false|0|no)$/i.test(value);
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

function splitOutsideQuotes(text: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === sep) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function indexOutsideQuotes(text: string, needle: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === needle) {
      return i;
    }
  }
  return -1;
}

/**
 * Named keys → key codes accepted by `Driver.triggerKey`.
 *
 * Values come from `oh_key_code.h`, except `power`: the header declares 18, but
 * the extension is measured to wake the display with 26, so 26 is what this SDK
 * sends. Both codes are accepted here.
 */
const KEYS: Record<string, number> = {
  home: 1,
  back: 2,
  search: 9,
  media_play_pause: 10,
  media_stop: 11,
  media_next: 12,
  media_previous: 13,
  volume_up: 16,
  volume_down: 17,
  power: 26,
  camera: 19,
  mute: 23,
  alt_left: 2045,
  alt_right: 2046,
  shift_left: 2047,
  shift_right: 2048,
  tab: 2049,
  space: 2050,
  enter: 2054,
  page_up: 2068,
  page_down: 2069,
  ctrl_left: 2072,
  ctrl_right: 2073,
  meta_left: 2076,
  meta_right: 2077,
  move_home: 2081,
  insert: 2083,
  del: 2055,
  backspace: 2055,
  menu: 2067,
  escape: 2070,
  esc: 2070,
  forward_del: 2071,
  delete: 2071,
  move_end: 2082,
  dpad_up: 2012,
  dpad_down: 2013,
  dpad_left: 2014,
  dpad_right: 2015,
};

// Letters A–Z are 2017–2042 in oh_key_code.h; useful for shortcuts like META+A.
for (let i = 0; i < 26; i++) KEYS[String.fromCharCode(97 + i)] = 2017 + i;

export type KeyName = keyof typeof KEYS;

export const KEY_NAMES = Object.keys(KEYS).sort();

/** Accepts a name, a numeric string, or a number; anything else is an error. */
export function parseKeyName(key: string | number): number {
  if (typeof key === "number") {
    if (!Number.isInteger(key) || key < 0) {
      throw new UitestError(`invalid key code: ${key}`, "EINVALIDKEY");
    }
    return key;
  }
  const raw = String(key ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const code = KEYS[normalized];
  if (code === undefined) {
    throw new UitestError(
      `unknown key "${raw}"; use a name (${KEY_NAMES.join(", ")}) or a numeric key code`,
      "EINVALIDKEY",
    );
  }
  return code;
}
