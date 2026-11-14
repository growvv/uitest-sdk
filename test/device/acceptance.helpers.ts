import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export const ROOT = "docs/acceptance";

export async function ensureDirs(): Promise<void> {
  for (const d of ["", "screenshots", "logs", "scripts"]) {
    await mkdir(join(ROOT, d), { recursive: true });
  }
}

export class Evidence {
  constructor(
    readonly capability: string,
    readonly env: string,
  ) {}

  private get logPath(): string {
    return join(ROOT, "logs", `${this.capability}-${this.env}.log`);
  }

  private get shotPath(): string {
    return join(ROOT, "screenshots", `${this.capability}-${this.env}.png`);
  }

  async log(line: string): Promise<void> {
    await appendFile(this.logPath, `[${new Date().toISOString()}] ${line}\n`);
  }

  /** Writes a capture as evidence. The bytes are JPEG; the name says .png only
   *  because the acceptance convention is image-per-capability. */
  async screenshot(image: Buffer): Promise<string> {
    await writeFile(this.shotPath, image);
    return this.shotPath;
  }
}

export interface Result {
  capability: string;
  env: string;
  status: "PASS" | "FAIL" | "SKIP";
  ms?: number;
  detail?: string;
  screenshot?: string;
  log?: string;
}
