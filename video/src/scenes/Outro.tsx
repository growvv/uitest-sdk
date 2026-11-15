import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

const CHIPS = ["点击", "截图", "UI 树", "投流", "录制", "多实例"];

/** 780–900: the six capabilities flash in, then the address. */
export const Outro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const urlIn = spring({ frame: frame - 40, fps, config: { damping: 200 } });

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
      <div style={{ display: "flex", gap: 18 }}>
        {CHIPS.map((chip, i) => {
          const enter = spring({ frame: frame - i * 5, fps, config: { damping: 200 } });
          return (
            <div
              key={chip}
              style={{
                padding: "16px 30px",
                border: `1px solid ${theme.border}`,
                borderRadius: 999,
                backgroundColor: theme.card,
                fontSize: 32,
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
          marginTop: 70,
          fontFamily: theme.mono,
          fontSize: 62,
          color: theme.accent,
          opacity: urlIn,
          transform: `translateY(${interpolate(urlIn, [0, 1], [30, 0])}px)`,
        }}
      >
        github.com/growvv/uitest-sdk
      </div>
      <div
        style={{
          marginTop: 18,
          fontFamily: theme.mono,
          fontSize: 28,
          color: theme.muted,
          opacity: urlIn,
        }}
      >
        MIT · npm install uitest-sdk
      </div>
    </AbsoluteFill>
  );
};
