import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CastOptions } from "./types.js";
import { UitestError } from "../transport/errors.js";

/** Cast defaults, one field per `start-daemon` flag the SDK passes through. */
export interface CastSettings {
  screenId?: number;
  /** Same values `CastOptions` accepts. */
  scale?: 1 | 2 | 3 | 4 | 5;
  frameRate?: 15 | 30 | 60 | 120;
  bitRate?: number;
  iFrameInterval?: number;
  /** Device-side listening port, ws transport only. */
  port?: number;
  transport?: "grpc" | "ws" | "mjpeg";
  /** Local path to the 7.0 extension, ws transport only. */
  wsExtension?: string;
}

const KEYS: (keyof CastSettings)[] = [
  "screenId",
  "scale",
  "frameRate",
  "bitRate",
  "iFrameInterval",
  "port",
  "transport",
  "wsExtension",
];

/** The file a state directory uses for cast defaults. */
export function castConfigPath(stateDir: string): string {
  return join(stateDir, "cast.json");
}

function invalid(key: string, value: unknown, why: string): UitestError {
  return new UitestError(`cast setting ${key}=${JSON.stringify(value)} ${why}`, "EBADARG");
}

/** Validates one setting; returns the value to store, or throws. */
function check(key: keyof CastSettings, value: unknown): CastSettings[keyof CastSettings] {
  if (value === undefined) return undefined;
  if (key === "transport") {
    if (value !== "grpc" && value !== "ws" && value !== "mjpeg") {
      throw invalid(key, value, 'must be "grpc", "ws" or "mjpeg"');
    }
    return value;
  }
  if (key === "wsExtension") {
    if (typeof value !== "string" || !value) throw invalid(key, value, "must be a non-empty string");
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(key, value, "must be a number");
  }
  if (key === "frameRate") {
    if (value !== 15 && value !== 30 && value !== 60 && value !== 120) {
      throw invalid(key, value, "must be 15, 30, 60 or 120");
    }
    return value;
  }
  if (key === "scale") {
    if (!Number.isInteger(value) || value < 1 || value > 5) throw invalid(key, value, "must be 1..5");
    return value as 1 | 2 | 3 | 4 | 5;
  }
  if (key === "screenId") {
    if (!Number.isInteger(value) || value < 0) throw invalid(key, value, "must be a non-negative integer");
    return value;
  }
  if (value <= 0) throw invalid(key, value, "must be a positive number");
  if (key === "port") {
    if (!Number.isInteger(value) || value > 65_535) throw invalid(key, value, "must be 1..65535");
  }
  return value;
}

/**
 * Cast defaults persisted as JSON next to the other per-device state.
 *
 * `load` is forgiving — a missing or hand-broken file is an empty config, not a
 * failed run. `set` is strict: a bad value is a programming error, so it
 * throws instead of being silently dropped. Nothing here is implicit: the
 * caller spreads `toCastOptions()` into `createCast`, so a config file can
 * never change a cast the caller did not ask it to change.
 */
export class CastConfig {
  private constructor(
    readonly path: string,
    private settings: CastSettings,
  ) {}

  static async load(path: string): Promise<CastConfig> {
    if (!existsSync(path)) return new CastConfig(path, {});
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return new CastConfig(path, {});
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new CastConfig(path, {});
    const settings: CastSettings = {};
    for (const key of KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      try {
        const checked = check(key, value);
        if (checked !== undefined) (settings as Record<string, unknown>)[key] = checked;
      } catch {
        // A hand-edited file must not fail a run; the bad key is ignored.
      }
    }
    return new CastConfig(path, settings);
  }

  get(): CastSettings {
    return { ...this.settings };
  }

  /** Merges a patch, validates it, and writes the file. */
  async set(patch: CastSettings): Promise<CastSettings> {
    const next: CastSettings = { ...this.settings };
    for (const key of KEYS) {
      if (!(key in patch)) continue;
      const value = check(key, patch[key]);
      if (value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2) + "\n", "utf8");
    this.settings = next;
    return this.get();
  }

  /** Settings as `createCast` options; explicit arguments still win when spread last. */
  toCastOptions(mode: "stream" | "record"): CastOptions {
    return { ...this.settings, mode };
  }
}
