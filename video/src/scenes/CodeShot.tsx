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

type Segment = { text: string; color?: string };

const CODE: Segment[][] = [
  [
    { text: "import { Device } from " },
    { text: '"uitest-sdk"', color: theme.ok },
    { text: ";" },
  ],
  [],
  [
    { text: "const dev = await " },
    { text: "Device.connect", color: theme.accent },
    { text: "({ deviceId });" },
  ],
  [
    { text: "const jpeg = await dev.agent." },
    { text: "captureScreen", color: theme.accent },
    { text: "();" },
  ],
  [
    { text: "await dev.agent." },
    { text: "click", color: theme.accent },
    { text: "(608, 1344);" },
    { text: "   // 32 ms", color: theme.muted },
  ],
  [
    { text: "await dev.agent." },
    { text: "swipe", color: theme.accent },
    { text: "(608, 1900, 608, 900);" },
  ],
];

/** 300–540: real code on the left, the phone it drives on the right. */
export const CodeShot = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phone = spring({ frame: frame - 20, fps, config: { damping: 200 } });
  const phoneY = interpolate(phone, [0, 1], [720, 0]);
  const codeIn = spring({ frame, fps, config: { damping: 200 } });
  const codeX = interpolate(codeIn, [0, 1], [-80, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 90,
        padding: "0 120px",
        fontFamily: theme.sans,
        color: theme.fg,
      }}
    >
      <div style={{ opacity: codeIn, transform: `translateX(${codeX}px)` }}>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 24,
            letterSpacing: "0.08em",
            color: theme.muted,
            marginBottom: 22,
          }}
        >
          quickstart.mjs
        </div>
        <div
          style={{
            width: 900,
            padding: "44px 48px",
            border: `1px solid ${theme.border}`,
            borderRadius: 18,
            backgroundColor: theme.card,
            fontFamily: theme.mono,
            fontSize: 31,
            lineHeight: 1.85,
            whiteSpace: "pre",
          }}
        >
          {CODE.map((line, i) => (
            <div key={i} style={{ minHeight: 57 }}>
              {line.map((seg, j) => (
                <span key={j} style={{ color: seg.color ?? theme.fg }}>
                  {seg.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          width: 470,
          padding: 16,
          border: `1px solid ${theme.border}`,
          borderRadius: 46,
          backgroundColor: theme.card,
          boxShadow: "0 50px 140px rgba(0,0,0,0.65)",
          transform: `translateY(${phoneY}px)`,
          opacity: phone,
        }}
      >
        <Img
          src={staticFile("screen-home.jpg")}
          style={{ display: "block", width: "100%", borderRadius: 34 }}
        />
      </div>
    </AbsoluteFill>
  );
};
