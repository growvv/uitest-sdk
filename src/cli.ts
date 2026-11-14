import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HdcRunner } from "./hdc.js";
import { AgentProtocolError } from "./errors.js";
import type { UiNode } from "./model.js";

export interface DumpLayoutOptions {
  windowId?: number;
  bundleName?: string;
  withFontAttrs?: boolean;
}

/**
 * `uitest dumpLayout` writes to a file, so this path costs a shell command plus
 * a pull. It is the only way to scope the tree to a single window: the agent's
 * `captureLayout` always returns the whole screen.
 */
export class CliRunner {
  constructor(private readonly hdc: HdcRunner) {}

  async dumpLayout(opts: DumpLayoutOptions = {}): Promise<UiNode> {
    const remote = `/data/local/tmp/uitest_sdk_${randomUUID()}.json`;
    const local = join(tmpdir(), basename(remote));

    let cmd = `uitest dumpLayout -p ${remote}`;
    if (opts.windowId !== undefined) cmd += ` -w ${opts.windowId}`;
    if (opts.bundleName !== undefined) cmd += ` -b ${opts.bundleName}`;
    if (opts.withFontAttrs) cmd += " -a";

    await this.hdc.shell(cmd);
    try {
      await this.hdc.pull(remote, local);
      const raw = await this.hdc.readLocal(local);
      try {
        return JSON.parse(raw) as UiNode;
      } catch (e) {
        throw new AgentProtocolError(
          `dumpLayout produced non-JSON output: ${raw.slice(0, 200)}`,
          "EBADJSON",
          e,
        );
      }
    } finally {
      // Best effort: a leftover temp file is harmless, a masked error is not.
      await this.hdc.shell(`rm -f ${remote}`).catch(() => undefined);
    }
  }
}
