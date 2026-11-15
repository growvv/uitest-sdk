import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** 0–75 (2.5 s): name, promise, stack — faster than the first cut. */
export const Title = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = (delay: number) =>
    spring({ frame: frame - delay, fps, config: { damping: 200 } });

  const rise = (delay: number, distance: number) =>
    interpolate(enter(delay), [0, 1], [distance, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        background: `radial-gradient(1200px 700px at 78% 18%, ${theme.card} 0%, ${theme.bg} 62%)`,
        justifyContent: "center",
        padding: "0 140px",
        fontFamily: theme.sans,
        color: theme.fg,
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 30,
          letterSpacing: "0.12em",
          color: theme.accent,
          opacity: enter(0),
          transform: `translateY(${rise(0, 30)}px)`,
        }}
      >
        uitest-sdk
      </div>

      <div
        style={{
          marginTop: 30,
          fontSize: 112,
          fontWeight: 700,
          lineHeight: 1.14,
          letterSpacing: "-0.02em",
          opacity: enter(5),
          transform: `translateY(${rise(5, 50)}px)`,
        }}
      >
        用一条长连接，
        <br />
        控制鸿蒙设备
      </div>

      <div
        style={{
          display: "flex",
          gap: 18,
          marginTop: 42,
          opacity: enter(14),
          transform: `translateY(${rise(14, 24)}px)`,
        }}
      >
        {["Node.js + TypeScript", "点击 9 ms", "零 hdc 轮询"].map((chip) => (
          <div
            key={chip}
            style={{
              padding: "12px 24px",
              border: `1px solid ${theme.border}`,
              borderRadius: 999,
              backgroundColor: theme.card,
              fontFamily: theme.mono,
              fontSize: 26,
              color: theme.muted,
            }}
          >
            {chip}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
