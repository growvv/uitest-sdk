import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

const CHIPS = ["点击 9 ms", "截图 184 ms", "投流 89 fps", "录制 MP4", "多实例", "失败即报错"];

/** 800–900: the six capabilities flash in, then the address. */
export const Outro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const urlIn = spring({ frame: frame - 26, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        background: `radial-gradient(900px 500px at 50% 38%, ${theme.card} 0%, ${theme.bg} 70%)`,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.sans,
        color: theme.fg,
      }}
    >
      <div style={{ display: "flex", gap: 16 }}>
        {CHIPS.map((chip, i) => {
          const enter = spring({ frame: frame - i * 4, fps, config: { damping: 200 } });
          return (
            <div
              key={chip}
              style={{
                padding: "14px 26px",
                border: `1px solid ${theme.border}`,
                borderRadius: 999,
                backgroundColor: theme.card,
                fontSize: 29,
                opacity: enter,
                transform: `translateY(${interpolate(enter, [0, 1], [26, 0])}px)`,
              }}
            >
              {chip}
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 62,
          fontFamily: theme.mono,
          fontSize: 68,
          color: theme.accent,
          opacity: urlIn,
          transform: `translateY(${interpolate(urlIn, [0, 1], [30, 0])}px)`,
        }}
      >
        github.com/growvv/uitest-sdk
      </div>
      <div
        style={{
          marginTop: 16,
          fontFamily: theme.mono,
          fontSize: 28,
          color: theme.muted,
          opacity: urlIn,
        }}
      >
        npm install uitest-sdk · MIT
      </div>
    </AbsoluteFill>
  );
};
