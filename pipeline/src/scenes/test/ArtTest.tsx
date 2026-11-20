import React, {useMemo} from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {palette as P} from '../../theme/palette';
import {ensureFonts} from '../../theme/fonts';
import {progress} from '../../lib/anim';
import {makeWarp, WarpPair} from '../../lib/timewarp';
import {DeskScene} from './DeskScene';
import {GpuWorld} from './GpuWorld';
import {GpuLabels} from './GpuLabels';
import {BrandCard} from '../../components/PikaraBrand';
import {Vignette} from '../../components/Vignette';
import {Subtitles} from '../../components/Subtitles';
import {SHOT, TEMPLATE_ANCHORS} from './shots';
import {getTimeline} from '../../data/timeline';
import {TEST_CUES} from '../../data/voiceover';

ensureFonts();

/** 由旁白錨點建立「實際影格 → 樣板影格」映射；沒有時間軸時退回 1:1（無聲版）。 */
export const useArtTestWarp = () =>
  useMemo(() => {
    const tl = getTimeline('arttest');
    if (!tl) return {tl: null, warp: (f: number) => f, total: SHOT.total};
    const pairs: WarpPair[] = [[0, 0]];
    for (const [name, tpl] of Object.entries(TEMPLATE_ANCHORS)) {
      const a = tl.anchors[name];
      if (a) pairs.push([a.frame, tpl]);
    }
    pairs.push([tl.totalFrames, SHOT.total]);
    return {tl, warp: makeWarp(pairs), total: tl.totalFrames};
  }, []);

/**
 * 第一階段美術測試（有聲版）。
 * 鏡頭語言：桌面人物 → 穿過側透玻璃 → 3D 顯示卡 → X 光透視 → 潛入晶片 → 晶片表面化為權重矩陣 → 拉遠 → 品牌
 * 所有畫面事件都由旁白錨點驅動（念到「GPU」才轉出顯示卡、念到「相乘」才開始乘加波前）。
 */
export const ArtTest: React.FC<{frameOffset?: number; showSubtitles?: boolean; withAudio?: boolean}> = ({
  frameOffset = 0,
  showSubtitles = true,
  withAudio = true,
}) => {
  const real = useCurrentFrame() + frameOffset;
  const {tl, warp} = useArtTestWarp();
  const frame = warp(real); // 樣板影格（可為小數，所有動畫皆為連續函式）

  const deskVisible = frame < SHOT.deskEnd;
  const gpuVisible = frame >= SHOT.gpuStart && frame < SHOT.gpuEnd + 30;
  const deskFade = 1 - progress(frame, 212, SHOT.deskEnd);
  const brandVisible = frame >= SHOT.brandStart;
  const scrim = progress(frame, SHOT.pullStart + 6, SHOT.brandStart + 4);
  const cues = tl ? tl.cues : TEST_CUES;

  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden'}}>
      {gpuVisible ? (
        <>
          <GpuWorld frame={frame} width={1920} height={1080} />
          <GpuLabels frame={frame} />
        </>
      ) : null}
      {deskVisible ? (
        <div style={{position: 'absolute', inset: 0, opacity: deskFade}}>
          <DeskScene frame={frame} />
        </div>
      ) : null}
      <div style={{position: 'absolute', inset: 0, background: P.ink, opacity: scrim * 0.9}} />
      {brandVisible ? (
        <BrandCard
          frame={frame - SHOT.brandStart}
          duration={SHOT.total - SHOT.brandStart}
          episode="EP01"
          title="AI 是怎麼在你的電腦上運行的？"
          subtitle="從 llama.cpp 看本地大型語言模型"
        />
      ) : null}
      <Vignette />
      {showSubtitles ? <Subtitles frame={real} cues={cues} /> : null}
      {withAudio && tl ? (
        tl.mix ? (
          <Sequence from={-frameOffset}>
            <Audio src={staticFile(tl.mix)} />
          </Sequence>
        ) : (
          tl.lines.map((l) => (
            <Sequence key={l.id} from={l.startFrame - frameOffset} durationInFrames={l.durationFrames + 30}>
              <Audio src={staticFile(l.audio)} />
            </Sequence>
          ))
        )
      ) : null}
    </AbsoluteFill>
  );
};
