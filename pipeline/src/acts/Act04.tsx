import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {ease} from '../lib/anim';
import {cam2dAt, CameraLayer, type Cam2D} from '../lib/camera2d';
import type {Key} from '../lib/anim';
import {Vignette} from '../components/Vignette';
import {an, env, SchematicTag, Station} from './act04/common';
import {Bits} from './act04/Bits';
import {Memory} from './act04/Memory';
import {Quant} from './act04/Quant';
import {Params} from './act04/Params';
import {MixStrip} from './act04/MixStrip';
import {BAR4, CH, SizeChart, gbToY} from './act04/SizeChart';
import {GgufFile} from './act04/GgufFile';

/**
 * 第 04 幕：量化與 GGUF。
 * 一個連續的 2D 世界，鏡頭依旁白在七個站點間移動：
 *   位元 → 記憶體/VRAM → 量化機制 → INT8 vs 4 位元 → 參數數量不變 → Q4_K_M 混合 → 大小圖表 → GGUF 檔案解剖
 */
const S = {
  bits: [0, 0],
  mem: [0, 1300],
  quant: [2400, 1300],
  params: [4800, 1300],
  mix: [4800, 2600],
  chart: [7200, 2600],
  gguf: [7200, 3900],
} as const;
const c = (s: readonly [number, number], dx = 0, dy = 0, zoom = 1): Cam2D => ({cx: s[0] + 960 + dx, cy: s[1] + 540 + dy, zoom});

export const Act04: React.FC<ActProps> = ({frame, durationInFrames, anchors}) => {
  const f = frame;
  const A = (k: string, fb: number) => an(anchors, k, fb);
  const q = A('q', 45);
  const fp32 = A('fp32', 508);
  const calc = A('calc', 968);
  const vram6 = A('vram6', 1594);
  const approx = A('approx', 1974);
  const int8 = A('int8', 3121);
  const notdelete = A('notdelete', 3651);
  const same = A('same', 3790);
  const q4km = A('q4km', 4144);
  const formula = A('formula', 4730);
  const b70 = A('b70', 5874);
  const actual = A('actual', 6129);
  const gguf = A('gguf', 6855);
  const header = A('header', 7098);
  const meta = A('meta', 7305);
  const tensors = A('tensors', 7431);
  const onefile = A('onefile', 7580);
  const container = A('container', 7984);
  const end = durationInFrames;

  const keys: Key<Cam2D>[] = [
    {f: 0, v: c(S.bits, 0, 0, 1.18)},
    {f: q + 60, v: c(S.bits, 0, 0, 1.08), ease: ease.out},
    {f: fp32 - 150, v: c(S.bits, 0, 0, 0.96)},
    {f: fp32 - 30, v: c(S.bits, 0, 0, 1.0), ease: ease.camera},
    {f: calc + 20, v: c(S.bits, 0, 10, 1.02)},
    {f: calc + 95, v: c(S.mem, 0, 0, 1.0), ease: ease.camera},
    {f: vram6 - 60, v: c(S.mem, 0, 0, 1.03)},
    {f: vram6 + 40, v: c(S.mem, -40, 20, 1.06), ease: ease.camera},
    {f: approx - 170, v: c(S.mem, -20, 10, 1.04)},
    {f: approx - 80, v: c(S.quant, 0, 0, 1.0), ease: ease.camera},
    {f: int8 - 50, v: c(S.quant, 0, 0, 1.03)},
    {f: int8 + 10, v: c(S.quant, 0, 0, 1.0), ease: ease.camera},
    {f: notdelete - 80, v: c(S.quant, 0, 0, 1.02)},
    {f: notdelete - 10, v: c(S.params, 0, 0, 1.0), ease: ease.camera},
    {f: same + 40, v: c(S.params, 0, 20, 1.04)},
    {f: q4km - 90, v: c(S.params, 0, 20, 1.04)},
    {f: q4km - 20, v: c(S.mix, 0, 0, 1.0), ease: ease.camera},
    {f: formula - 80, v: c(S.mix, 0, 0, 1.03)},
    {f: formula - 10, v: c(S.chart, 0, 0, 1.0), ease: ease.camera},
    {f: b70 - 40, v: c(S.chart, 0, 0, 1.0)},
    {f: b70 + 30, v: c(S.chart, 60, -20, 1.03), ease: ease.camera},
    {f: actual + 10, v: c(S.chart, 0, 0, 1.0)},
    {f: actual + 80, v: c(S.chart, 80, 20, 1.08), ease: ease.camera},
    {f: gguf - 110, v: c(S.chart, 60, 10, 1.06)},
    {f: gguf - 20, v: c(S.gguf, 0, 0, 1.0), ease: ease.camera},
    {f: header - 30, v: c(S.gguf, 20, -10, 1.02)},
    {f: header + 10, v: c(S.gguf, -470, -140, 1.3), ease: ease.camera},
    {f: meta - 25, v: c(S.gguf, -430, -140, 1.3)},
    {f: meta + 10, v: c(S.gguf, -80, -140, 1.3), ease: ease.camera},
    {f: tensors - 20, v: c(S.gguf, -60, -140, 1.3)},
    {f: tensors + 20, v: c(S.gguf, 190, -60, 1.12), ease: ease.camera},
    {f: onefile - 10, v: c(S.gguf, 210, -60, 1.12)},
    {f: onefile + 50, v: c(S.gguf, 0, 0, 1.0), ease: ease.camera},
    {f: container - 40, v: c(S.gguf, 0, 0, 1.0)},
    {f: container + 20, v: c(S.gguf, 30, -50, 1.06), ease: ease.camera},
    {f: end, v: c(S.gguf, 30, -40, 1.1)},
  ];
  const cam = cam2dAt(f, keys);

  // 背景點陣（視差 0.5）
  const depth = 0.5;
  const z = Math.pow(cam.zoom, depth);
  const gs = 64 * z;
  const bx = 960 - (cam.cx * depth) * z;
  const by = 540 - (cam.cy * depth) * z;

  // 各站只在需要時渲染
  const vis = (a: number, b: number) => f >= a && f <= b;

  // 尺寸圖的 4 位元長條（給 GGUF 站變形用；在 GGUF 站座標中）
  const barTop = gbToY(4 + BAR4.extraGb, 9);
  const from = {x: BAR4.x + S.chart[0] - S.gguf[0], y: barTop + S.chart[1] - S.gguf[1], w: BAR4.w, h: CH.yB - barTop};

  const schematic = Math.max(
    env(f, approx - 80, approx - 40, notdelete - 60, notdelete - 20),
    env(f, notdelete - 20, notdelete + 10, q4km - 60, q4km - 30),
    env(f, q4km - 40, q4km, formula - 60, formula - 30),
    env(f, actual + 60, actual + 100, gguf - 80, gguf - 40),
    env(f, gguf - 10, gguf + 30, end + 10, end + 20),
  );

  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(circle, rgba(138,151,180,0.16) 1.3px, transparent 1.6px)`,
          backgroundSize: `${gs}px ${gs}px`,
          backgroundPosition: `${bx}px ${by}px`,
        }}
      />
      <div style={{position: 'absolute', inset: 0, background: `radial-gradient(ellipse 60% 55% at 50% 45%, rgba(28,39,64,0.55), rgba(9,13,24,0) 70%)`}} />
      <CameraLayer cam={cam}>
        <Station x={S.bits[0]} y={S.bits[1]} show={vis(0, calc + 120)}>
          <Bits f={f} anchors={anchors} />
        </Station>
        <Station x={S.mem[0]} y={S.mem[1]} show={vis(calc - 10, approx - 60)}>
          <Memory f={f} anchors={anchors} />
        </Station>
        <Station x={S.quant[0]} y={S.quant[1]} show={vis(approx - 180, notdelete)}>
          <Quant f={f} anchors={anchors} />
        </Station>
        <Station x={S.params[0]} y={S.params[1]} show={vis(notdelete - 90, q4km)}>
          <Params f={f} anchors={anchors} />
        </Station>
        <Station x={S.mix[0]} y={S.mix[1]} show={vis(q4km - 100, formula)}>
          <MixStrip f={f} anchors={anchors} />
        </Station>
        <Station x={S.chart[0]} y={S.chart[1]} show={vis(formula - 100, gguf)}>
          <SizeChart f={f} anchors={anchors} />
        </Station>
        <Station x={S.gguf[0]} y={S.gguf[1]} show={vis(gguf - 115, end)}>
          <GgufFile f={f} anchors={anchors} from={from} />
        </Station>
      </CameraLayer>
      <SchematicTag t={schematic} text={f > gguf - 20 ? '示意圖（比例未按實際）' : '示意圖'} />
      <Vignette strength={0.5} />
    </AbsoluteFill>
  );
};
