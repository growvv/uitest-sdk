import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

const TRACK = 760;
const SDK_MS = 9;
const CLI_MS = 531;

/** 320–440: the measured gap against the hdc CLI, the loudest claim we can back. */
export const Bench = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const count = Math.round(
    interpolate(frame, [2, 26], [0, 59], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
  const grow = spring({ frame: frame - 14, fps, config: { damping: 24, stiffness: 80 } });
  const chips = spring({ frame: frame - 48, fps, config: { damping: 200 } });

  const width = (ms: number) => Math.max(10, (ms / CLI_MS) * TRACK) * grow;

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
          fontSize: 26,
          letterSpacing: "0.1em",
          color: theme.muted,
        }}
      >
        真机实测 · 同一台设备 · 同一个脚本
      </div>

      <div
        style={{
          marginTop: 4,
          fontFamily: theme.mono,
          fontSize: 250,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: "-0.04em",
          color: theme.accent,
        }}
      >
        {count}×
      </div>

      <div style={{ marginTop: 2, fontSize: 38, color: theme.fg }}>
        点击延迟 · 9 ms vs hdc CLI 531 ms
      </div>

      <div style={{ marginTop: 44, width: 1100 }}>
        <Bar label="本 SDK" ms={SDK_MS} width={width(SDK_MS)} color={theme.accent} />
        <Bar label="hdc CLI" ms={CLI_MS} width={width(CLI_MS)} color={theme.muted} />
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          marginTop: 44,
          opacity: chips,
          transform: `translateY(${interpolate(chips, [0, 1], [20, 0])}px)`,
        }}
      >
        {["滑动 6.9×", "截图 4.5×", "snapshot_display 651 ms"].map((chip) => (
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

const Bar = ({
  label,
  ms,
  width,
  color,
}: {
  label: string;
  ms: number;
  width: number;
  color: string;
}) => (
  <div style={{ display: "flex", alignItems: "center", marginTop: 18 }}>
    <div
      style={{
        width: 150,
        fontFamily: theme.mono,
        fontSize: 26,
        color: theme.muted,
      }}
    >
      {label}
    </div>
    <div
      style={{
        width: TRACK + 20,
        height: 26,
        borderRadius: 13,
        backgroundColor: theme.card,
        border: `1px solid ${theme.border}`,
        overflow: "hidden",
      }}
    >
      <div style={{ width, height: "100%", backgroundColor: color }} />
    </div>
    <div
      style={{
        marginLeft: 20,
        fontFamily: theme.mono,
        fontSize: 30,
        color,
      }}
    >
      {ms} ms
    </div>
  </div>
);
