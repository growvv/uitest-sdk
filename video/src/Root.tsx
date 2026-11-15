import { AbsoluteFill, Audio, Composition, Sequence, staticFile } from "remotion";
import { ApiShot } from "./scenes/ApiShot";
import { Arch } from "./scenes/Arch";
import { Bench } from "./scenes/Bench";
import { Cast } from "./scenes/Cast";
import { CodeShot } from "./scenes/CodeShot";
import { Outro } from "./scenes/Outro";
import { Terminal } from "./scenes/Terminal";
import { Title } from "./scenes/Title";
import { theme } from "./theme";

/** Eight scenes, 900 frames: 2.5–4.5 s each, cut on the beat. */
export const Main = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Audio src={staticFile("bgm.wav")} volume={0.7} />
      <Sequence from={0} durationInFrames={75}>
        <Title />
      </Sequence>
      <Sequence from={75} durationInFrames={125}>
        <Terminal />
      </Sequence>
      <Sequence from={200} durationInFrames={120}>
        <CodeShot />
      </Sequence>
      <Sequence from={320} durationInFrames={120}>
        <Bench />
      </Sequence>
      <Sequence from={440} durationInFrames={120}>
        <Cast />
      </Sequence>
      <Sequence from={560} durationInFrames={120}>
        <ApiShot />
      </Sequence>
      <Sequence from={680} durationInFrames={120}>
        <Arch />
      </Sequence>
      <Sequence from={800} durationInFrames={100}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="UiTestSdkDemo"
      component={Main}
      durationInFrames={900}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
