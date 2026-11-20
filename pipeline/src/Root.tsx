import React from 'react';
import {Composition, Folder} from 'remotion';
import {ArtTest} from './scenes/test/ArtTest';
import {FPS, SHOT} from './scenes/test/shots';
import {GpuProbe} from './diagnostics/GpuProbe';
import {getTimeline} from './data/timeline';
import {ActPreview, Episode} from './episode/Episode';
import {getAct} from './acts/actData';
import {actsFor, compPrefix, episodeIds, hasCustomActs} from './episode/registry';

const tl = getTimeline('arttest');
const total = tl?.totalFrames ?? SHOT.total;
const a = (name: string, fallback: number) => tl?.anchors[name]?.frame ?? fallback;

// 第一階段測試片的單獨鏡頭：依旁白錨點切分（實際影格）
const shots = [
  {id: 'Shot1-Desk', from: 0, to: a('gpu', 300) - 60},
  {id: 'Shot2-GPU', from: a('gpu', 300) - 60, to: a('chip', 538)},
  {id: 'Shot3-Matrix', from: a('chip', 538), to: a('brand', 734) - 20},
  {id: 'Shot4-Brand', from: a('brand', 734) - 20, to: total},
];

export const RemotionRoot: React.FC = () => (
  <>
    {/* 每一集（時間軸中的 sequences.epNN）：<EP>（60fps）、<EP>-30fps、<EP>-YT15；有手工幕的集數另有 <EP>-ActNN */}
    {episodeIds().map((epId) => {
      const EP = compPrefix(epId);
      const total = getTimeline(epId)?.totalFrames ?? 600;
      return (
        <Folder key={epId} name={EP}>
          <Composition id={EP} component={Episode} durationInFrames={total} fps={FPS} width={1920} height={1080} defaultProps={{epId, withAudio: true, showSubtitles: true, frameScale: 1}} />
          {/* YouTube 1.5 倍速版：30fps，每幀取 60fps 時間軸的第 3n 幀（動畫與字幕同步加速，音訊另以 atempo=1.5 保持音調） */}
          <Composition id={`${EP}-YT15`} component={Episode} durationInFrames={Math.ceil(total / 3)} fps={30} width={1920} height={1080} defaultProps={{epId, withAudio: false, showSubtitles: true, frameScale: 3}} />
          <Composition id={`${EP}-30fps`} component={Episode} durationInFrames={Math.ceil(total / 2)} fps={30} width={1920} height={1080} defaultProps={{epId, withAudio: false, showSubtitles: true, frameScale: 2}} />
          {hasCustomActs(epId)
            ? actsFor(epId).map((act, i) => (
                <Composition
                  key={act.id}
                  id={`${EP}-Act${String(i + 1).padStart(2, '0')}`}
                  component={ActPreview}
                  durationInFrames={Math.max(1, getAct(act.id, epId).durationFrames)}
                  fps={FPS}
                  width={1920}
                  height={1080}
                  defaultProps={{actId: act.id, epId, withAudio: true}}
                />
              ))
            : null}
        </Folder>
      );
    })}
    <Folder name="Phase1-ArtTest">
      <Composition id="ArtTest" component={ArtTest} durationInFrames={total} fps={FPS} width={1920} height={1080} defaultProps={{frameOffset: 0, showSubtitles: true, withAudio: true}} />
      {shots.map((s) => (
        <Composition key={s.id} id={s.id} component={ArtTest} durationInFrames={s.to - s.from} fps={FPS} width={1920} height={1080} defaultProps={{frameOffset: s.from, showSubtitles: true, withAudio: true}} />
      ))}
    </Folder>
    <Folder name="Diagnostics">
      <Composition id="GpuProbe" component={GpuProbe} durationInFrames={1} fps={FPS} width={1280} height={720} />
    </Folder>
  </>
);
