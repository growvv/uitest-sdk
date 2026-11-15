import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../theme";

/** 440–560: the casting numbers, the loudest thing in the video. */
export const Cast = () => {
  const frame = useCurrentFrame();

  const fps = Math.round(
    interpolate(frame, [4, 92], [15, 89], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const label = interpolate(frame, [12, 34], [0, 1], { extrapolateRight: "clamp" });
  const chips = interpolate(frame, [56, 74], [0, 1], { extrapolateRight: "clamp" });

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
          fontFamily: theme.mono,
          fontSize: 430,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: "-0.04em",
          color: theme.accent,
        }}
      >
        {fps}
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: theme.mono,
          fontSize: 44,
          color: theme.fg,
          opacity: label,
        }}
      >
        fps · H.264 投流
      </div>
      <div
        style={{
          display: "flex",
          gap: 16,
          marginTop: 34,
          opacity: chips,
          transform: `translateY(${interpolate(chips, [0, 1], [18, 0])}px)`,
        }}
      >
        {["gRPC over abstract socket", "stream · 15–89 fps", "record · MP4"].map((chip) => (
          <div
            key={chip}
            style={{
              padding: "12px 24px",
              border: `1px solid ${theme.border}`,
              borderRadius: 999,
              backgroundColor: theme.card,
              fontFamily: theme.mono,
              fontSize: 24,
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
