// The 30-line tour: connect, measure, tap, swipe, capture.
//
// Run it from this repository after `npm run build` (the import is the package
// referring to itself through its "exports"), or from any project after
// `npm install uitest-sdk`.
//
//   node examples/quickstart.mjs
//
// No device serial lives here: connect() picks the only attached target.
import { connect } from "uitest-sdk";

const t0 = performance.now();
const session = await connect();
const tConnect = Math.round(performance.now() - t0);

try {
  const screen = await session.observe.layout();
  const { width, height } = screen.display;
  console.log(`✓ connected  ${width}×${height}  (${tConnect} ms)`);

  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);

  const t1 = performance.now();
  // A coordinate is not a target: tap takes a ref, text, selector or On.
  // The centre of the screen has no label, so this presses the keypad instead.
  await session.act.tap({ text: "7" });
  console.log(`✓ tap({ text: "7" })  ${Math.round(performance.now() - t1)} ms`);

  const t2 = performance.now();
  await session.act.swipe({
    from: { x: cx, y: Math.round(height * 0.7) },
    to: { x: cx, y: Math.round(height * 0.3) },
    durationMs: 300,
  });
  console.log(`✓ swipe()  ${Math.round(performance.now() - t2)} ms`);

  const t3 = performance.now();
  const shot = await session.observe.screenshot({ out: "screen.jpg" });
  console.log(`✓ screenshot() → ${shot.path}  ${Math.round(performance.now() - t3)} ms`);
} finally {
  await session.close();
}
