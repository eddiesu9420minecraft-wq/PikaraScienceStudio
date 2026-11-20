import React from 'react';
import * as THREE from 'three';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {ease} from '../../lib/anim';
import {project} from '../../lib/camera3d';
import type {A5} from './timing';
import {Callout, MONO, Schematic, win} from './ui';
import {
  BoardRig,
  boardTimes,
  camAt,
  CPU_POS,
  CPU_STACK,
  DIMMS,
  GDDR,
  GPU_POS,
  GPU_STACK,
  N_CPU,
  N_GPU,
  N_LAYERS,
  nglValue,
  SSD_POS,
  V,
} from './board';

/** 3D 主機板的 2D 標註層（與 3D 共用攝影機函式，逐幀貼合） */
export const BoardLabels: React.FC<{f: number; a: A5; rig: BoardRig}> = ({f, a, rig}) => {
  const T = boardTimes(a);
  if (f < a.laptop - 20 || f > T.xfadeOutEnd) return null;
  const cam = camAt(rig, f);
  const p = (v: THREE.Vector3) => project(cam, v);

  const cpu = p(V(CPU_POS.x, 0.04, CPU_POS.z));
  const ram = p(V(DIMMS[1].x - 0.2, 0.07, DIMMS[1].z + 0.05));
  const gpu = p(V(GPU_POS.x, 0.042, GPU_POS.z));
  const vram = p(V(GDDR[0].x, 0.024, GDDR[0].z));
  const ssd = p(V(SSD_POS.x + 0.12, 0.05, SSD_POS.z));
  const ramLoad = p(V(DIMMS[0].x + 0.1, 0.07, DIMMS[0].z));
  const gStack = p(V(GPU_STACK.x + 0.25, GPU_STACK.y + (N_GPU - 1) * 0.026, GPU_STACK.z));
  const cStack = p(V(CPU_STACK.x - 0.25, CPU_STACK.y + (N_CPU - 1) * 0.026, CPU_STACK.z));

  const ngl = nglValue(T, f);
  const panelT = win(f, a.offload - 16, a.offload + 24, T.xfadeOut - 24, T.xfadeOut + 6);

  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      <Callout x={cpu.x} y={cpu.y} dx={-150} dy={-170} title="Ryzen 7" sub="處理器 CPU" t={win(f, a.ryzen - 16, a.ryzen + 22, a.rtx - 30, a.rtx)} color={P.amber} />
      <Callout x={ram.x} y={ram.y} dx={-200} dy={-170} title="32 GB" sub="系統記憶體 RAM" t={win(f, a.ram - 16, a.ram + 22, a.rtx - 30, a.rtx)} color={P.paper} />
      <Callout x={gpu.x} y={gpu.y} dx={150} dy={-190} title="RTX 4050 Laptop" sub="顯示卡 GPU" t={win(f, a.rtx - 16, a.rtx + 22, a.ssd - 110, a.ssd - 80)} color={P.ice} />
      <Callout x={vram.x} y={vram.y} dx={-170} dy={150} title="6 GB VRAM" sub="顯示卡專用記憶體" t={win(f, a.rtx + 120, a.rtx + 160, a.ssd - 110, a.ssd - 80)} color={P.ice} />
      <Callout x={ssd.x} y={ssd.y} dx={120} dy={-170} title="SSD" sub="GGUF 檔案存放處" t={win(f, a.ssd - 16, a.ssd + 22, a.load + 40, a.load + 70)} color={P.paper} />
      <Callout x={ramLoad.x} y={ramLoad.y} dx={-120} dy={-170} title="載入 RAM" sub="權重讀進系統記憶體" t={win(f, a.load - 10, a.load + 26, a.offload - 30, a.offload)} color={P.amber} />
      <Callout x={gStack.x} y={gStack.y} dx={140} dy={-120} title={`${N_GPU} 層 → VRAM`} sub="交給 GPU 計算" t={win(f, a.gpulayers - 24, a.gpulayers + 16, a.why + 10, a.why + 36)} color={P.ice} />
      <Callout x={cStack.x} y={cStack.y} dx={-130} dy={-120} title={`${N_CPU} 層 → RAM`} sub="由 CPU 計算" t={win(f, a.cpulayers - 24, a.cpulayers + 16, a.why + 10, a.why + 36)} color={P.amber} />

      {panelT > 0 ? <NglPanel t={panelT} n={ngl} f={f} /> : null}
      <Schematic o={panelT} text={`示意圖：以 ${N_LAYERS} 層的模型為例`} />
    </div>
  );
};

const NglPanel: React.FC<{t: number; n: number; f: number}> = ({t, n}) => {
  const k = ease.out(t);
  return (
    <div style={{position: 'absolute', left: 128, top: 92, opacity: t, transform: `translateY(${(1 - k) * 16}px)`}}>
      <div style={{fontFamily: MONO, fontSize: 22, color: P.mist}}>--n-gpu-layers</div>
      <div style={{fontFamily: MONO, fontSize: 58, fontWeight: 600, color: P.paper, marginTop: 2, lineHeight: 1.1}}>
        -ngl <span style={{color: P.ice, display: 'inline-block', minWidth: 74}}>{n}</span>
      </div>
      <svg width={32 * 15} height={40} style={{marginTop: 10, display: 'block'}}>
        {Array.from({length: N_LAYERS}).map((_, i) => {
          const lit = i >= N_LAYERS - n;
          return <rect key={i} x={i * 15} y={4} width={10} height={32} rx={2} fill={lit ? P.ice : P.amber} opacity={lit ? 0.95 : 0.35} />;
        })}
      </svg>
      <div style={{...type.label, fontSize: 21, color: P.mist, marginTop: 8, display: 'flex', justifyContent: 'space-between', width: 32 * 15 - 5}}>
        <span>第 1 層</span>
        <span>第 {N_LAYERS} 層</span>
      </div>
    </div>
  );
};
