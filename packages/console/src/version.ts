import { readFileSync } from "node:fs";
import { VERSION as CORE_VERSION } from "uitest-sdk";

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("uitest-console: package.json has no version");
  }
  return pkg.version;
}

/** This product's version, independent of the core library it runs on. */
export const VERSION = readVersion();

export { CORE_VERSION };
