import { readFileSync } from "node:fs";

/**
 * The package version, read from the package's own `package.json`.
 *
 * `--version` and the MCP `serverInfo` must report the version that was
 * actually published. A literal in the source drifts the first time a release
 * bumps `package.json` and forgets the copy, and a wrong version in an MCP
 * handshake is hard to notice.
 */
function readVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  const version = String(pkg.version ?? "").trim();
  if (!version) throw new Error("package.json has no version");
  return version;
}

export const VERSION = readVersion();
