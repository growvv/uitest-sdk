import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme } from "../theme";

const ROWS: { call: string; note: string }[] = [
  { call: "dev.agent.click(x, y)", note: "9 ms" },
  { call: "dev.agent.swipe(x1, y1, x2, y2)", note: "391 ms" },
  { call: "dev.agent.captureScreen()", note: "184 ms" },
  { call: "dev.agent.captureLayout()", note: "UI 树" },
  { call: "dev.agent.cropToWindow({...})", note: "窗口截图" },
  { call: 'dev.createCast({ mode: "stream" })', note: "H.264" },
  { call: 'dev.createCast({ mode: "record" })', note: "MP4" },
];

/** 560–680: the API surface at a glance, beside the second real screenshot. */
export const ApiShot = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phone = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const zoom = interpolate(frame, [0, 120], [1.0, 1.05]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 80,
        padding: "0 110px",
        fontFamily: theme.sans,
        color: theme.fg,
      }}
    >
      <div style={{ width: 1040 }}>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 24,
            letterSpacing: "0.1em",
            color: theme.accent,
          }}
        >
          API 一览
        </div>
        <div style={{ marginTop: 16, fontSize: 40, fontWeight: 600 }}>一个对象，覆盖全部能力</div>
        <div
          style={{
            marginTop: 30,
            border: `1px solid ${theme.border}`,
            borderRadius: 18,
            backgroundColor: theme.card,
            padding: "30px 38px",
            fontFamily: theme.mono,
            fontSize: 27,
            lineHeight: 1.95,
          }}
        >
          {ROWS.map((row, i) => {
            const enter = spring({ frame: frame - 6 - i * 6, fps, config: { damping: 200 } });
            return (
              <div
                key={row.call}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 24,
                  whiteSpace: "pre",
                  opacity: enter,
                  transform: `translateX(${interpolate(enter, [0, 1], [-24, 0])}px)`,
                }}
              >
                <span>{row.call}</span>
                <span style={{ color: theme.accent }}>{row.note}</span>
              </div>
            );
          })}
        </div>
        <div
          style={{
            marginTop: 22,
            fontFamily: theme.mono,
            fontSize: 24,
            color: theme.muted,
            opacity: interpolate(frame, [40, 60], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          全部返回 Promise，失败抛 UitestError 子类
        </div>
      </div>

      <div
        style={{
          width: 400,
          padding: 14,
          border: `1px solid ${theme.border}`,
          borderRadius: 44,
          backgroundColor: theme.card,
          boxShadow: "0 50px 140px rgba(0,0,0,0.65)",
          opacity: phone,
          transform: `translateY(${interpolate(phone, [0, 1], [60, 0])}px)`,
          overflow: "hidden",
        }}
      >
        <Img
          src={staticFile("screen-apps.jpg")}
          style={{
            display: "block",
            width: "100%",
            borderRadius: 32,
            transform: `scale(${zoom})`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
