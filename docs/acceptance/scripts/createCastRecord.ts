/**
 * Minimal reproduction for "createCastRecord".
 * Run: npx tsx docs/acceptance/scripts/createCastRecord.ts --target <deviceId>
 */
import { Device } from "../../../src/device.js";

const i = process.argv.indexOf("--target");
const target = i >= 0 ? process.argv[i + 1] : process.env.UITEST_TARGET;

const dev = await Device.connect({ deviceId: target });
try {
  // See the "run" branch for this capability in scripts/acceptance.ts.
  const size = await dev.agent.getDisplaySize();
  console.log("display", size);
} finally {
  await dev.dispose();
}
