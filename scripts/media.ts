/**
 * Captures the two marketing screenshots for the site: the home screen and the
 * app drawer, straight off the device with the SDK itself.
 *
 * The acceptance screenshots all landed on the same system dialog, so they
 * cannot be used for promotion. This script first sends the Back key to leave
 * whatever is in front, then captures.
 *
 * Usage:
 *   npx tsx scripts/media.ts --target <deviceId>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Device, HdcRunner } from "uitest-sdk/drivers";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "site", "assets");

function parseTarget(): string {
  const i = process.argv.indexOf("--target");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.UITEST_TARGET) return process.env.UITEST_TARGET;
  throw new Error("pass --target <deviceId> or set UITEST_TARGET");
}

async function main(): Promise<void> {
  const deviceId = parseTarget();
  mkdirSync(OUT, { recursive: true });

  // Home always lands on the desktop; Back would only pop one screen of
  // whatever the acceptance run left in front.
  await new HdcRunner({ deviceId }).shell("uitest uiInput keyEvent Home");

  const dev = await Device.connect({ deviceId });
  try {
    const { width, height } = await dev.agent.getDisplaySize();

    const home = await dev.agent.captureScreen();
    writeFileSync(join(OUT, "screen-home.jpg"), home);
    console.log(`screen-home.jpg ${home.length} bytes`);

    // This launcher has no app drawer — a swipe up opens search instead — so
    // the second shot is the next desktop page, full of app icons. The settle
    // delay keeps the capture from racing the page animation.
    await dev.agent.swipe(width * 0.85, height * 0.5, width * 0.15, height * 0.5, { durationMs: 200 });
    await new Promise((r) => setTimeout(r, 1200));
    const apps = await dev.agent.captureScreen();
    writeFileSync(join(OUT, "screen-apps.jpg"), apps);
    console.log(`screen-apps.jpg ${apps.length} bytes`);
  } finally {
    await dev.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
