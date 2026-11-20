import React, {useMemo} from 'react';
import {AbsoluteFill} from 'remotion';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {fontStack, type} from '../theme/fonts';
import {ease, lerp, progress} from '../lib/anim';
import {makeWarp, WarpPair} from '../lib/timewarp';
import {DeskScene} from '../scenes/test/DeskScene';
import {GpuWorld} from '../scenes/test/GpuWorld';
import {GpuLabels} from '../scenes/test/GpuLabels';
import {Vignette} from '../components/Vignette';
import {SHOT} from '../scenes/test/shots';

/**
 * 第一幕：AI 就在你的電腦裡。
 *
 * 0. 冷開場（前 5 秒抓住觀眾）：直接從晶片上的乘加波前開始，大字「數十億次乘法」在旁白念到「幾十億」時落下；
 *    然後鏡頭猛然拉遠，切回安靜的深夜房間（23:00），形成反差。
 * 1. 之後沿用第一階段測試片的連續鏡頭（桌前提問 → 穿過側透玻璃 → 3D 顯示卡 → X 光透視 → 潛入晶片 → 權重矩陣），
 *    由 EP01 旁白錨點驅動；品牌片尾留到第七幕。
 *
 * 樣板影格 ↔ 錨點：14 打字開始（「晚上」）、128 送出（「答案」）、150 轉向主機（「按下」）、210 進入 3D（「沒有連上」）、
 *   300 顯示卡轉正（「GPU」）、470 VRAM（「顯示記憶體」）、500 資料流（「流進」）、538 潛入晶片（「晶片」）、
 *   645 乘加波前（「相乘」）、716 拉遠（「從頭」）。
 */
const TPL = {open: 14, answer: 128, enter: 150, offline: 210, gpu: 300, vram: 470, flow: 500, chip: 538, multiply: 645, outro: 716};
const TPL_END = 772;

const ColdOpen: React.FC<{frame: number; end: number; hook: number}> = ({frame, end, hook}) => {
  // 晶片上的矩陣運算：以樣板 612→706 的區段放慢播放
  const tpl = lerp(612, 706, progress(frame, 0, end + 20));
  const l1 = ease.out(progress(frame, 8, 34));
  const punch = progress(frame, hook - 8, hook + 10);
  const k = ease.out(punch);
  return (
    <AbsoluteFill>
      <GpuWorld frame={tpl} width={1920} height={1080} />
      {/* 左側壓暗讓文字可讀 */}
      <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(9,13,24,0.88) 0%, rgba(9,13,24,0.55) 42%, rgba(9,13,24,0) 70%)'}} />
      <div style={{position: 'absolute', left: 130, top: 300, fontFamily: fontStack}}>
        <div style={{...type.label, fontSize: 34, color: P.mist, opacity: l1, transform: `translateY(${(1 - l1) * 16}px)`}}>
          本機 AI 每吐出一個字
        </div>
        <div style={{display: 'flex', alignItems: 'baseline', gap: 18, marginTop: 18, opacity: Math.min(1, punch * 2.2)}}>
          <span
            style={{
              ...type.display,
              fontSize: 150,
              color: P.amber,
              lineHeight: 1,
              display: 'inline-block',
              transform: `scale(${1.35 - 0.35 * k})`,
              transformOrigin: 'left bottom',
              letterSpacing: '-0.01em',
            }}
          >
            數十億次
          </span>
          <span style={{...type.display, fontSize: 92, color: P.paper, lineHeight: 1}}>乘法</span>
        </div>
        <div style={{...type.label, fontSize: 22, color: P.mist, marginTop: 26, opacity: ease.out(progress(frame, hook + 20, hook + 50))}}>
          以數十億參數的模型為例 · 畫面為示意
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Act01: React.FC<ActProps> = ({frame, durationInFrames, anchors}) => {
  // 冷開場在第一句「晚上十一點…」開始前結束
  const coldEnd = anchors.open !== undefined ? Math.max(90, anchors.open - 14) : 0;
  const hook = anchors.hook ?? 60;

  const warp = useMemo(() => {
    const pairs: WarpPair[] = [[coldEnd, 0]];
    for (const [k, tpl] of Object.entries(TPL)) {
      const a = anchors[k];
      if (a !== undefined && a > coldEnd) pairs.push([a, tpl]);
    }
    pairs.push([durationInFrames, TPL_END]);
    pairs.sort((x, y) => x[0] - y[0]);
    return makeWarp(pairs, 16);
  }, [anchors, durationInFrames, coldEnd]);

  const t = frame < coldEnd ? 0 : warp(frame);
  const deskVisible = t < SHOT.deskEnd;
  const gpuVisible = t >= SHOT.gpuStart;
  const deskFade = 1 - progress(t, 212, SHOT.deskEnd);
  const scrim = progress(t, SHOT.pullStart + 10, TPL_END);

  // 冷開場 → 房間：猛拉遠（冷開場放大淡出、房間由稍小放大到正常）
  const cut = progress(frame, coldEnd - 16, coldEnd + 10);
  const cutK = ease.inOut(cut);

  const think =
    anchors.answer !== undefined && anchors.enter !== undefined
      ? progress(frame, anchors.answer + 90, anchors.enter - 30) * (1 - progress(frame, anchors.enter - 6, anchors.enter + 30))
      : 0;
  const clock = ease.out(progress(frame, coldEnd + 6, coldEnd + 30)) * (1 - progress(t, 110, 140));

  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden'}}>
      {frame >= coldEnd - 16 && gpuVisible ? (
        <>
          <GpuWorld frame={t} width={1920} height={1080} />
          <GpuLabels frame={t} />
        </>
      ) : null}
      {frame >= coldEnd - 16 && deskVisible ? (
        <div style={{position: 'absolute', inset: 0, opacity: deskFade * Math.min(1, cutK * 1.6), transform: `scale(${lerp(1.18, 1, cutK)})`}}>
          <DeskScene
            frame={t}
            override={{
              reply: '當你按下 Enter，模型會先把這句話切成一個個 token，再一路算下去……',
              replyChars: Math.floor(Math.max(0, (t - 132) * 0.55)),
              pose: {think},
            }}
          />
          <div style={{position: 'absolute', left: 120, top: 92, fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 40, color: P.paper, opacity: clock * 0.85, letterSpacing: '0.12em'}}>
            23:00
          </div>
        </div>
      ) : null}
      {frame < coldEnd + 10 ? (
        <div style={{position: 'absolute', inset: 0, opacity: 1 - cutK, transform: `scale(${1 + cutK * 0.5})`}}>
          <ColdOpen frame={frame} end={coldEnd} hook={hook} />
        </div>
      ) : null}
      <div style={{position: 'absolute', inset: 0, background: P.ink, opacity: scrim * 0.92, pointerEvents: 'none'}} />
      <Vignette />
    </AbsoluteFill>
  );
};
