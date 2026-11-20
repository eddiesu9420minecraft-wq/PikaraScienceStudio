import React, {useMemo} from 'react';
import {AbsoluteFill} from 'remotion';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {Vignette} from '../components/Vignette';
import {keyOf, resolveA5} from './act05/timing';
import {StackScene} from './act05/StackScene';
import {HookScene} from './act05/HookScene';
import {FlowScene} from './act05/FlowScene';
import {MemoryScene} from './act05/MemoryScene';
import {BoardWorld} from './act05/BoardWorld';
import {BoardLabels} from './act05/BoardLabels';
import {boardTimes, makeBoardRig} from './act05/board';

/**
 * 第 05 幕：llama.cpp 如何運作
 * A 終端機 → 軟體堆疊（2D）→ B 筆電螢幕拉遠、主機板爆炸圖、SSD→RAM、GPU offload（3D）
 * → C 俯視轉成示意圖：頻寬與瓶頸、類比（2D）→ D KV Cache、Context 與 VRAM 取捨（2D）
 */
export const Act05: React.FC<ActProps> = ({frame, durationInFrames, anchors, lines}) => {
  const a0 = resolveA5(anchors, durationInFrames, lines);
  const key = keyOf(a0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const a = useMemo(() => a0, [key]);
  const rig = useMemo(() => makeBoardRig(a), [a]);
  const T = boardTimes(a);
  const f = frame;
  const show3d = f >= T.xfadeIn - 2 && f <= T.xfadeOutEnd + 2;
  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden'}}>
      {show3d ? (
        <>
          <BoardWorld f={f} a={a} rig={rig} />
          <BoardLabels f={f} a={a} rig={rig} />
        </>
      ) : null}
      <FlowScene f={f} a={a} rig={rig} />
      <MemoryScene f={f} a={a} />
      <StackScene f={f} a={a} />
      <HookScene f={f} a={a} />
      <Vignette strength={0.4} />
    </AbsoluteFill>
  );
};
