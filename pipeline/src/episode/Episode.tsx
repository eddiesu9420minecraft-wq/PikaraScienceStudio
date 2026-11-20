import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {getAct, rawEp} from '../acts/actData';
import {Subtitles} from '../components/Subtitles';
import {getTimeline} from '../data/timeline';
import {ensureFonts} from '../theme/fonts';
import {IrisFrame, irisRadius} from './IrisTransition';
import {ChapterTag} from './ChapterTag';
import {actsFor, episodeTitle, hasCustomActs} from './registry';

ensureFonts();

/** 單一幕（含轉場遮罩）。Episode 與單幕預覽共用。epId 預設 ep01。 */
export const ActSlot: React.FC<{index: number; frame: number; epId?: string}> = ({index, frame, epId = 'ep01'}) => {
  const acts = actsFor(epId);
  const a = acts[index];
  const next = acts[index + 1];
  const span = getAct(a.id, epId);
  const r = irisRadius(frame, span.durationFrames, a.transitionIn === 'iris', !!next && next.transitionIn === 'iris');
  const Comp = a.component;
  const custom = hasCustomActs(epId);
  return (
    <IrisFrame radius={r}>
      <Comp
        frame={frame}
        durationInFrames={span.durationFrames}
        fps={60}
        anchors={span.anchors}
        lines={span.lines}
        {...(custom ? {} : {title: span.title, index, total: acts.length, episodeId: epId, episodeTitle: episodeTitle(epId), anchorWords: span.anchorWords})}
      />
      {/* 手工幕的章節標記；通用樣板自己畫常駐標題 */}
      {custom && index > 0 ? <ChapterTag frame={frame} index={index + 1} total={acts.length} title={span.title} /> : null}
    </IrisFrame>
  );
};

/** 一整集：各幕依旁白時間軸排列；音訊用後製混音（尚未混音則逐句播放旁白）。 */
/** frameScale=2 用於 1080p30 輸出：每個 30fps 影格對應 60fps 時間軸的第 2n 幀（動畫內容完全相同）。 */
export const Episode: React.FC<{epId?: string; withAudio?: boolean; showSubtitles?: boolean; frameScale?: number}> = ({epId = 'ep01', withAudio = true, showSubtitles = true, frameScale = 1}) => {
  const frame = useCurrentFrame() * frameScale;
  const tl = getTimeline(epId);
  const raw = rawEp(epId);
  const acts = actsFor(epId);
  return (
    <AbsoluteFill style={{background: '#090D18'}}>
      {acts.map((a, i) => {
        const span = getAct(a.id, epId);
        const local = frame - span.startFrame;
        if (local < 0 || local >= span.durationFrames) return null;
        return <ActSlot key={a.id} index={i} frame={local} epId={epId} />;
      })}
      {showSubtitles && tl ? <Subtitles frame={frame} cues={tl.cues} /> : null}
      {withAudio && tl && raw ? (
        tl.mix ? (
          <Audio src={staticFile(tl.mix)} />
        ) : (
          raw.lines.filter((l) => !(l as unknown as {estimated?: boolean}).estimated).map((l) => (
            <Sequence key={l.id} from={l.startFrame} durationInFrames={l.durationFrames + 20}>
              <Audio src={staticFile(l.audio)} />
            </Sequence>
          ))
        )
      ) : null}
    </AbsoluteFill>
  );
};

/** 單幕預覽：只渲染一幕，附該幕旁白與字幕（供各幕獨立檢查、渲染）。 */
export const ActPreview: React.FC<{actId: string; epId?: string; withAudio?: boolean}> = ({actId, epId = 'ep01', withAudio = true}) => {
  const frame = useCurrentFrame();
  const index = actsFor(epId).findIndex((a) => a.id === actId);
  const span = getAct(actId, epId);
  const raw = rawEp(epId);
  return (
    <AbsoluteFill style={{background: '#090D18'}}>
      <ActSlot index={index} frame={frame} epId={epId} />
      <Subtitles frame={frame} cues={span.cues} />
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
