import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { theme, TYPE_MS } from "../theme";

const LINES: { text: string; kind: "cmd" | "ok" }[] = [
  { text: "$ npm install uitest-sdk", kind: "cmd" },
  { text: "$ node quickstart.mjs", kind: "cmd" },
  { text: "✓ connected  BRA-AL00 · 1216×2688", kind: "ok" },
  { text: "✓ click(608, 1344)                 9 ms", kind: "ok" },
  { text: "✓ captureScreen() → 608×1344 JPEG  118 ms", kind: "ok" },
  { text: "✓ createCast() → H.264 · 60 fps", kind: "ok" },
];

const START_MS = 100;
const LINE_GAP_MS = 90;

/** 75–200: the install-to-cast loop, typed out twice as fast. */
export const Terminal = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1000;

  let lineStart = START_MS;
  const typed = LINES.map((line) => {
    const chars = Math.floor(
      Math.min(Math.max(elapsedMs - lineStart, 0) / TYPE_MS, line.text.length),
    );
    lineStart += line.text.length * TYPE_MS + LINE_GAP_MS;
    return line.text.slice(0, chars);
  });
  const activeLine = typed.findIndex((text, i) => text.length < LINES[i].text.length);
  const cursorOn = activeLine >= 0 && Math.floor(elapsedMs / 400) % 2 === 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.sans,
        color: theme.fg,
      }}
    >
      <div
        style={{
          width: 1320,
          border: `1px solid ${theme.border}`,
          borderRadius: 20,
          backgroundColor: theme.card,
          overflow: "hidden",
          boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "18px 26px",
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: theme.border }}
            />
          ))}
          <div
            style={{
              marginLeft: "auto",
              fontFamily: theme.mono,
              fontSize: 22,
              color: theme.muted,
            }}
          >
            quickstart.mjs
          </div>
        </div>
        <div
          style={{
            padding: "34px 44px 42px",
            fontFamily: theme.mono,
            fontSize: 32,
            lineHeight: 1.85,
          }}
        >
          {LINES.map((line, i) => (
            <div
              key={i}
              style={{
                whiteSpace: "pre",
                color: line.kind === "ok" ? theme.ok : theme.fg,
                minHeight: 59,
              }}
            >
              {typed[i]}
              {i === activeLine && cursorOn && <span style={{ color: theme.accent }}>▍</span>}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
