import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {fontStack} from '../theme/fonts';
import {Vignette} from '../components/Vignette';
import {QuestionScene} from './act06/QuestionScene';
import {EmbedWorld} from './act06/EmbedWorld';
import {EmbedLabels} from './act06/EmbedLabels';
import {embedTimes} from './act06/embedRig';
import {vis} from './act06/common';
import {AttentionScene, attTimes} from './act06/AttentionScene';
import {GenScene} from './act06/GenScene';

/**
 * 第 06 幕：AI 如何一個字一個字地回答你。
 * 一條連續的旅程：問題 → token → 編號 → 向量 → 嵌入空間（3D）→ Transformer 層（3D）
 * → 進入一層看 Attention → logits → 取樣（Temperature）→ 自回歸 → Prefill / Decode → token/s。
 */
export const Act06: React.FC<ActProps> = ({frame, anchors}) => {
  const E = embedTimes(anchors);
  const show3d = frame >= E.start - 2 && frame <= E.end;
  const o3d = vis(frame, E.start, E.flyA - 10, E.example - 50, E.example - 8);
  const att = attTimes(anchors);
  return (
    <AbsoluteFill style={{background: P.ink, fontFamily: fontStack, overflow: 'hidden'}}>
      {show3d ? (
        <div style={{position: 'absolute', inset: 0, opacity: o3d}}>
          <EmbedWorld frame={frame} anchors={anchors} />
          <EmbedLabels frame={frame} anchors={anchors} />
        </div>
      ) : null}
      <QuestionScene frame={frame} anchors={anchors} />
      {frame >= att.start ? <AttentionScene frame={frame} anchors={anchors} /> : null}
      <GenScene frame={frame} anchors={anchors} />
      <Vignette strength={0.5} />
    </AbsoluteFill>
  );
};
