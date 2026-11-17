import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { envName, renderReport, type EnvInfo } from "../../../../scripts/acceptance.js";
import { tagOf } from "../../src/operations/session.js";

// A made-up serial. The point of the test is that whatever string is passed as
// --targets must not survive into report.md, which is committed.
const SERIAL_A = "FMR0223B13001234";
const SERIAL_B = "127.0.0.1:5555";

function info(target: string, env: string): EnvInfo {
  return {
    target,
    env,
    abi: "arm64-v8a",
    model: "BRA-AL00",
    osVersion: "26",
    size: "1216x2688",
    agentMd5: "ebd787f91a55c968d837f09e80ad10cd  /data/local/tmp/agent.so",
  };
}

describe("acceptance report", () => {
  it("writes the device tag instead of the serial", () => {
    const md = renderReport([info(SERIAL_A, "device")], []);

    expect(md).not.toContain(SERIAL_A);
    expect(md).toContain(tagOf(SERIAL_A));
    // The tag belongs in the 设备 ID row, not merely somewhere in the file.
    expect(md).toMatch(/\| 设备 ID \| [0-9a-f]{8} \|/);
  });

  it("tags each target separately", () => {
    const md = renderReport([info(SERIAL_A, "device"), info(SERIAL_B, "emulator")], []);

    expect(md).not.toContain(SERIAL_A);
    expect(md).not.toContain(SERIAL_B);
    expect(md).toContain(`| 设备 ID | ${tagOf(SERIAL_A)} | ${tagOf(SERIAL_B)} |`);
  });

  it("gives two physical devices a column each", () => {
    // `envName()` used to be "device" for every serial and "emulator" for
    // loopback, so two phones attached at once produced two columns with the
    // same key: the second target's results overwrote the first's, and one
    // whole column of the capability table came back empty or wrong.
    const second = "SECOND-SERIAL-0001";
    const md = renderReport(
      [info(SERIAL_A, envName(SERIAL_A)), info(second, envName(second))],
      [
        { capability: "click", env: envName(SERIAL_A), status: "PASS", ms: 38, detail: "38 ms" },
        { capability: "click", env: envName(second), status: "PASS", ms: 51, detail: "51 ms" },
      ],
    );
    const header = /^\| 能力 \| .* \|$/m.exec(md)?.[0] ?? "";
    const cells = [...header.matchAll(/([0-9a-f]{8})/g)].map((m) => m[1]);
    expect(cells).toContain(tagOf(SERIAL_A));
    expect(cells).toContain(tagOf(second));
    expect(md).not.toContain(SERIAL_A);
    expect(md).not.toContain(second);
    expect(md).toContain("38 ms");
    expect(md).toContain("51 ms");
  });

  // The committed report is what a reader actually sees. It says "generated,
  // do not edit", so it has to be a real generator output — an id that is not
  // the tag means someone hand-edited it, and the next run would put a serial
  // back into the repository.
  it("keeps the committed report free of a raw device id", () => {
    const md = readFileSync(new URL("../../../../docs/acceptance/report.md", import.meta.url), "utf8");

    expect(md).toMatch(/\| 设备 ID \| ([0-9a-f]{8}) \|/);
    expect(md).not.toMatch(/<your-device-id>/);
  });
});
