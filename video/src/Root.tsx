import { AbsoluteFill, Composition, Sequence } from "remotion";
import { Cast } from "./scenes/Cast";
import { CodeShot } from "./scenes/CodeShot";
import { Outro } from "./scenes/Outro";
import { Terminal } from "./scenes/Terminal";
import { Title } from "./scenes/Title";
import { theme } from "./theme";

export const Main = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Sequence from={0} durationInFrames={120}>
        <Title />
      </Sequence>
      <Sequence from={120} durationInFrames={180}>
        <Terminal />
      </Sequence>
      <Sequence from={300} durationInFrames={240}>
        <CodeShot />
      </Sequence>
      <Sequence from={540} durationInFrames={240}>
        <Cast />
      </Sequence>
      <Sequence from={780} durationInFrames={120}>
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
