import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {getAct, rawEp01} from '../acts/actData';
import type {ActComponent} from '../acts/types';
import {Subtitles} from '../components/Subtitles';
import {ensureFonts} from '../theme/fonts';

ensureFonts();

/**
 * 單幕獨立預覽（不經過 registry，只 import 這一幕）。
 * 用於 src/entries/actXX.ts：各幕可以獨立 bundle、獨立檢查，不受其他幕的編譯錯誤影響。
 */
export const StandaloneAct: React.FC<{actId: string; Comp: ActComponent; withAudio?: boolean; showSubtitles?: boolean}> = ({
  actId,
  Comp,
  withAudio = true,
  showSubtitles = true,
}) => {
  const frame = useCurrentFrame();
  const span = getAct(actId);
  const raw = rawEp01();
  return (
    <AbsoluteFill style={{background: '#090D18'}}>
      <Comp frame={frame} durationInFrames={span.durationFrames} fps={60} anchors={span.anchors} lines={span.lines} />
      {showSubtitles ? <Subtitles frame={frame} cues={span.cues} /> : null}
      {withAudio && raw
        ? raw.lines
            .filter((l) => l.scene === actId && !(l as unknown as {estimated?: boolean}).estimated)
            .map((l) => (
              <Sequence key={l.id} from={l.startFrame - span.startFrame} durationInFrames={l.durationFrames + 20}>
                <Audio src={staticFile(l.audio)} />
              </Sequence>
            ))
        : null}
    </AbsoluteFill>
  );
};
