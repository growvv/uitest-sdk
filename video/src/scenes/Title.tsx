import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** 0–120: name, promise, stack — the first three seconds. */
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
          marginTop: 34,
          fontSize: 108,
          fontWeight: 700,
          lineHeight: 1.16,
          letterSpacing: "-0.02em",
          opacity: enter(10),
          transform: `translateY(${rise(10, 50)}px)`,
        }}
      >
        用一条长连接，
        <br />
        控制鸿蒙设备
      </div>

      <div
        style={{
          marginTop: 46,
          fontFamily: theme.mono,
          fontSize: 38,
          color: theme.muted,
          opacity: enter(24),
          transform: `translateY(${rise(24, 30)}px)`,
        }}
      >
        Node.js · TypeScript · HarmonyOS
      </div>
    </AbsoluteFill>
  );
};
