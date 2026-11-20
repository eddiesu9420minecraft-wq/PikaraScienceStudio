import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {progress} from '../lib/anim';
import {Vignette} from '../components/Vignette';
import {resolveAnchors, SchematicTag} from './act03/common';
import {NumberWorld} from './act03/NumberWorld';
import {Hook} from './act03/Hook';
import {Stack} from './act03/Stack';
import {Scale} from './act03/Scale';
import {Training} from './act03/Training';

/**
 * 第 03 幕：大型語言模型到底是什麼
 * 一個連續長鏡頭：模型檔案（鉤子）→ 答案資料庫（誤解）→ 抽屜化為數字 → 權重場 → 矩陣×向量 → 下一層 →
 * Transformer 疊層 → 參數規模（面積比例）→ 記憶體 → 訓練迴圈 → 權重凍結、推理 → 學到的規律。
 */
export const Act03: React.FC<ActProps> = ({frame, durationInFrames, anchors, lines}) => {
  const A = resolveAnchors(anchors, durationInFrames, lines);
  // 角落「示意圖」：抽象畫面時顯示（Transformer、規模圖、熱圖段落已自帶標示時隱藏）
  const tagOn =
    progress(frame, A.numbers - 60, A.numbers - 20) *
    (1 - progress(frame, A.transformer - 60, A.transformer - 30)) +
    progress(frame, A.train - 20, A.train + 10) * (1 - progress(frame, A.patterns - 40, A.patterns - 20));
  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden'}}>
      <AbsoluteFill style={{background: `radial-gradient(ellipse 70% 60% at 50% 45%, ${P.night} 0%, ${P.ink} 100%)`}} />
      <NumberWorld frame={frame} A={A} />
      <Hook frame={frame} A={A} />
      <Stack frame={frame} A={A} />
      <Scale frame={frame} A={A} />
      <Training frame={frame} A={A} />
      <SchematicTag opacity={Math.min(1, tagOn)} />
      <Vignette strength={0.5} />
    </AbsoluteFill>
  );
};
