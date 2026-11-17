import { existsSync } from "node:fs";
import { join } from "node:path";

export const CASTING_EXTENSION = "libscreen_casting.z.so";

/**
 * Locates the casting extension for an ABI. x86_64 has no build at all — Huawei
 * publishes no emulator variant and there is no public source — so callers on
 * that ABI must use the MJPEG path.
 */
export function resolveCastingExtension(
  abi: "arm64" | "x86_64",
  extDir?: string,
): string | null {
  if (abi === "x86_64") return null;
  if (!extDir) return null;
  const p = join(extDir, "arm64", CASTING_EXTENSION);
  return existsSync(p) ? p : null;
}
