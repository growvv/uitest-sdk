import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../theme";

/** 680–800: two channels — one long connection for input, one gRPC for video. */
export const Arch = () => {
  const frame = useCurrentFrame();
  const drawTop = interpolate(frame, [8, 30], [0, 1], { extrapolateRight: "clamp" });
  const drawBottom = interpolate(frame, [16, 38], [0, 1], { extrapolateRight: "clamp" });
  const boxes = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const labels = interpolate(frame, [30, 48], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: theme.sans,
        color: theme.fg,
      }}
    >
      <div style={{ width: 1560, marginBottom: 18 }}>
        <div style={{ fontSize: 52, fontWeight: 700, letterSpacing: "-0.01em" }}>双通道架构</div>
        <div style={{ marginTop: 8, fontSize: 27, color: theme.muted }}>
          一条长连接做 UI 自动化，一条 gRPC 通道做投流与录制
        </div>
      </div>

      <svg
        viewBox="0 0 1500 600"
        style={{ width: 1560, height: 624, opacity: boxes }}
        role="img"
      >
        <defs>
          <marker
            id="arch-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={theme.muted} />
          </marker>
        </defs>

        <rect x="30" y="240" width="300" height="120" rx="14" fill={theme.bg} stroke={theme.border} />
        <text x="180" y="292" textAnchor="middle" fontSize="27" fontWeight="600" fill={theme.fg}>
          Node 进程
        </text>
        <text x="180" y="326" textAnchor="middle" fontSize="18" fill={theme.muted} fontFamily={theme.mono}>
          uitest-sdk
        </text>

        <rect x="490" y="240" width="260" height="120" rx="14" fill={theme.bg} stroke={theme.border} />
        <text x="620" y="292" textAnchor="middle" fontSize="25" fill={theme.fg}>
          hdc fport
        </text>
        <text x="620" y="326" textAnchor="middle" fontSize="18" fill={theme.muted} fontFamily={theme.mono}>
          TCP 隧道
        </text>

        <rect x="960" y="60" width="470" height="130" rx="14" fill={theme.bg} stroke={theme.accent} />
        <text x="1195" y="118" textAnchor="middle" fontSize="24" fontWeight="600" fill={theme.fg}>
          agent.so · :8012
        </text>
        <text x="1195" y="152" textAnchor="middle" fontSize="18" fill={theme.muted} fontFamily={theme.mono}>
          JSON + JPEG · 长连接
        </text>

        <rect x="960" y="410" width="470" height="130" rx="14" fill={theme.bg} stroke={theme.border} />
        <text x="1195" y="468" textAnchor="middle" fontSize="21" fontWeight="600" fill={theme.fg}>
          libscreen_casting.z.so
        </text>
        <text x="1195" y="502" textAnchor="middle" fontSize="18" fill={theme.muted} fontFamily={theme.mono}>
          gRPC · H.264
        </text>

        <path
          d="M330 300 H490"
          fill="none"
          stroke={theme.muted}
          strokeWidth="2.5"
          markerEnd="url(#arch-arrow)"
        />
        <path
          d="M750 300 C840 300 860 125 960 125"
          fill="none"
          stroke={theme.muted}
          strokeWidth="2.5"
          markerEnd="url(#arch-arrow)"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={1 - drawTop}
        />
        <path
          d="M750 300 C840 300 860 475 960 475"
          fill="none"
          stroke={theme.muted}
          strokeWidth="2.5"
          markerEnd="url(#arch-arrow)"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={1 - drawBottom}
        />

        <g opacity={labels} fontFamily={theme.mono} fontSize="17" fill={theme.accent}>
          <text x="760" y="170">
            点击 / 截图 / UI 树
          </text>
          <text x="760" y="440">
            15–89 fps
          </text>
        </g>
      </svg>
    </AbsoluteFill>
  );
};
