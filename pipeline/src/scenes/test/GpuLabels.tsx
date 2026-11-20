import React from 'react';
import * as THREE from 'three';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {ease, progress, tween} from '../../lib/anim';
import {project} from '../../lib/camera3d';
import {cameraAt, cardMatrix, DIE_POS, DIE_TOP, GRID_N, GRID_PITCH, VRAM_OFFSETS} from './gpuRig';
import {SHOT} from './shots';

/**
 * 2D 標註層：以與 3D 相同的攝影機函式投影，因此標籤與物件逐幀貼合。
 * 風格：細引線 + 小字，無卡片背景。
 */
const Callout: React.FC<{x: number; y: number; dx: number; dy: number; title: string; sub?: string; t: number; color?: string}> = ({
  x,
  y,
  dx,
  dy,
  title,
  sub,
  t,
  color = P.paper,
}) => {
  if (t <= 0) return null;
  const ex = x + dx * ease.out(Math.min(1, t * 1.6));
  const ey = y + dy * ease.out(Math.min(1, t * 1.6));
  const textT = progress(t, 0.35, 1);
  const alignRight = dx < 0;
  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <circle cx={x} cy={y} r={4} fill="none" stroke={color} strokeWidth={1.5} opacity={t} />
        <circle cx={x} cy={y} r={1.6} fill={color} opacity={t} />
        <line x1={x} y1={y} x2={ex} y2={ey} stroke={color} strokeWidth={1.2} opacity={0.8 * t} />
        <line x1={ex} y1={ey} x2={ex + (alignRight ? -180 : 180) * textT} y2={ey} stroke={color} strokeWidth={1.2} opacity={0.5 * t} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: alignRight ? ex - 400 : ex,
          top: ey - 44,
          width: 400,
          textAlign: alignRight ? 'right' : 'left',
          opacity: textT,
          transform: `translateY(${(1 - textT) * 8}px)`,
          fontFamily: fontStack,
          textShadow: '0 2px 10px rgba(9,13,24,0.95), 0 0 3px rgba(9,13,24,0.9)',
        }}
      >
        <div style={{...type.title, fontSize: 28, color}}>{title}</div>
        {sub ? <div style={{...type.label, fontSize: 17, color: P.mist, marginTop: 16}}>{sub}</div> : null}
      </div>
    </>
  );
};

const local = (f: number, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(cardMatrix(f));

export const GpuLabels: React.FC<{frame: number}> = ({frame}) => {
  const cam = cameraAt(frame);
  const p = (v: THREE.Vector3) => project(cam, v);

  // 晶片 / VRAM 標註
  const tChip = progress(frame, SHOT.xrayStart + 44, SHOT.xrayStart + 74) * (1 - progress(frame, SHOT.diveStart - 4, SHOT.diveStart + 14));
  const die = p(local(frame, DIE_POS.x, DIE_TOP, DIE_POS.z));
  const [vx, vz] = VRAM_OFFSETS[1];
  const vram = p(local(frame, DIE_POS.x + vx, 0.032, DIE_POS.z + vz));

  // 矩陣標註
  const half = (GRID_N - 1) / 2;
  const tMat = progress(frame, SHOT.matrixStart + 30, SHOT.matrixStart + 60) * (1 - progress(frame, SHOT.pullStart, SHOT.pullStart + 16));
  const wCorner = p(local(frame, DIE_POS.x - half * GRID_PITCH, DIE_TOP + 0.001, DIE_POS.z + half * GRID_PITCH));
  const xRow = p(local(frame, DIE_POS.x - half * GRID_PITCH, DIE_TOP + 0.006, DIE_POS.z - (half + 2.2) * GRID_PITCH));
  const yCol = p(local(frame, DIE_POS.x + (half + 2.2) * GRID_PITCH, DIE_TOP + 0.002, DIE_POS.z + half * GRID_PITCH));
  const tY = progress(frame, SHOT.waveStart, SHOT.waveStart + 24) * (1 - progress(frame, SHOT.pullStart, SHOT.pullStart + 16));

  const formulaT = tween(frame, SHOT.matrixStart + 40, SHOT.matrixStart + 70, 0, 1, ease.out) * (1 - progress(frame, SHOT.pullStart, SHOT.pullStart + 16));

  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      <Callout x={die.x} y={die.y} dx={-150} dy={-150} title="GPU 晶片" sub="大量運算單元平行做乘加" t={tChip} color={P.amber} />
      <Callout x={vram.x} y={vram.y} dx={110} dy={110} title="VRAM 顯示記憶體" sub="模型權重存放在這裡" t={tChip * progress(frame, SHOT.xrayStart + 60, SHOT.xrayStart + 90)} color={P.ice} />
      <Callout x={wCorner.x} y={wCorner.y} dx={-130} dy={90} title="權重矩陣 W" sub="琥珀＝正值　冰藍＝負值" t={tMat} color={P.amber} />
      <Callout x={xRow.x} y={xRow.y} dx={-120} dy={-90} title="輸入向量 x" t={tMat} color={P.paper} />
      <Callout x={yCol.x} y={yCol.y} dx={110} dy={90} title="輸出 y" sub="每一列同時累加" t={tY} color={P.paper} />

      {formulaT > 0 ? (
        <div
          style={{
            position: 'absolute',
            right: 120,
            top: 96,
            textAlign: 'right',
            opacity: formulaT,
            transform: `translateY(${(1 - formulaT) * 10}px)`,
            textShadow: '0 2px 14px rgba(9,13,24,0.95), 0 0 4px rgba(9,13,24,0.9)',
          }}
        >
          <div style={{fontFamily: '"Cambria Math", "Times New Roman", serif', fontStyle: 'italic', fontSize: 64, color: P.paper, letterSpacing: '0.04em'}}>
            y<span style={{fontStyle: 'normal', margin: '0 18px', color: P.mist}}>=</span>W<span style={{fontStyle: 'normal', margin: '0 14px', color: P.mist}}>·</span>x
          </div>
          <div style={{...type.label, fontFamily: fontStack, fontSize: 22, color: P.paper, marginTop: 8}}>
            y<sub>i</sub> = Σ<sub>j</sub> W<sub>ij</sub> · x<sub>j</sub>
          </div>
          {/* schematic tag (STYLE.md: abstract principle shots must be marked) */}
          <div style={{display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 18, fontFamily: fontStack}}>
            <div style={{width: 26, height: 2, background: P.amber}} />
            <div style={{...type.label, fontSize: 26, fontWeight: 700, color: P.paper, letterSpacing: '0.12em'}}>示意圖</div>
            <div style={{...type.label, fontSize: 20, color: P.mist}}>非實際晶片佈局</div>
          </div>
        </div>
      ) : null}

    </div>
  );
};
