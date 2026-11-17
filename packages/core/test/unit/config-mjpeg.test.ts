import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastConfig, castConfigPath } from "../../src/cast/config.js";

describe("CastConfig: transport", () => {
  it("remembers mjpeg as a transport a person chose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-config-"));
    const config = await CastConfig.load(castConfigPath(dir));
    await config.set({ transport: "mjpeg" });

    expect(config.get().transport).toBe("mjpeg");
  });
});
