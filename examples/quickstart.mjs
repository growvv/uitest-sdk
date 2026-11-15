// The 30-line tour: connect, measure, click, swipe, capture.
//
// Run it from this repository after `npm run build` (the import is the package
// referring to itself through its "exports"), or from any project after
// `npm install uitest-sdk`.
//
//   node examples/quickstart.mjs
//
// No device serial lives here: Device.connect() picks the only attached target.
import { writeFileSync } from "node:fs";
import { Device } from "uitest-sdk";

const t0 = performance.now();
const dev = await Device.connect();
const tConnect = Math.round(performance.now() - t0);

try {
  const { width, height } = await dev.agent.getDisplaySize();
  console.log(`✓ connected  ${width}×${height}  (${tConnect} ms)`);

  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);

  const t1 = performance.now();
  await dev.agent.click(cx, cy);
  console.log(`✓ click(${cx}, ${cy})  ${Math.round(performance.now() - t1)} ms`);

  const t2 = performance.now();
  await dev.agent.swipe(cx, Math.round(height * 0.7), cx, Math.round(height * 0.3), {
    durationMs: 300,
  });
  console.log(`✓ swipe()  ${Math.round(performance.now() - t2)} ms`);

  const t3 = performance.now();
  const jpeg = await dev.agent.captureScreen();
  console.log(`✓ captureScreen() → ${jpeg.length} bytes JPEG  ${Math.round(performance.now() - t3)} ms`);
  writeFileSync("screen.jpg", jpeg);

  console.log("✓ wrote screen.jpg");
} finally {
  await dev.dispose();
}
