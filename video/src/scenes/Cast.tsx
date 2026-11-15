import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../theme";

/** 540–780: the casting numbers, the loudest thing in the video. */
export const Cast = () => {
  const frame = useCurrentFrame();

  const fps = Math.round(
    interpolate(frame, [10, 130], [15, 89], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const label = interpolate(frame, [20, 50], [0, 1], { extrapolateRight: "clamp" });
  const second = interpolate(frame, [90, 130], [0, 1], { extrapolateRight: "clamp" });

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
          fontSize: 460,
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
          marginTop: 10,
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
          marginTop: 26,
          fontFamily: theme.sans,
          fontSize: 32,
          color: theme.muted,
          opacity: second,
        }}
      >
        gRPC · 15–89 fps 随 frameRate · 同一特性也能直接录制 MP4
      </div>
    </AbsoluteFill>
  );
};
