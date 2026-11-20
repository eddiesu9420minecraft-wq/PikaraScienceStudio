import React from 'react';
import {palette as P} from '../../theme/palette';
import {ease, keyframes, lerp, progress} from '../../lib/anim';
import {A3, hash01, MONO, SANS, tint, W2, fmt} from './common';

/**
 * 段落 4：第二層的權重矩陣傾倒成一片「層」，更多層落下疊成 Transformer（示意圖），
 * 向量由下往上穿過每一層；之後整疊壓平成俯視的一塊（= 70B 方塊）。
 * 以 CSS 3D（preserve-3d）製作，另以同一套投影公式計算 2D 疊加物的位置。
 */
export const SLAB_W = 520;
export const SLAB_H = 344;
const N = 12;
const PERSP = 2600;
// 70B 方塊的位置（與 Scale.tsx 共用）
export const TILE70 = {x: 1200, y: 256, w: SLAB_W, h: SLAB_H};

type Pose = {cx: number; cy: number; s: number; rx: number; rz: number; gap: number};

export const stackPose = (f: number, A: A3): Pose =>
  keyframes(f, [
    {f: A.transformer - 170, v: {cx: 700, cy: 470, s: 1, rx: 0, rz: 0, gap: 0}},
    {f: A.transformer + 10, v: {cx: 960, cy: 500, s: 0.78, rx: 58, rz: -34, gap: 44}, ease: ease.camera},
    {f: A.stack, v: {cx: 960, cy: 500, s: 0.74, rx: 60, rz: -40, gap: 44}, ease: ease.inOutSoft},
    {f: A.sizes - 40, v: {cx: 960, cy: 500, s: 0.74, rx: 60, rz: -42, gap: 44}, ease: ease.inOutSoft},
    {f: A.sizes + 34, v: {cx: TILE70.x + SLAB_W / 2, cy: TILE70.y + SLAB_H / 2, s: 1, rx: 0, rz: 0, gap: 0}, ease: ease.camera},
  ]);

const rad = (d: number) => (d * Math.PI) / 180;
/** 與 CSS `scale(s) rotateX(rx) rotateZ(rz)` + perspective 相同的投影。 */
export const projectStack = (p: Pose, x: number, y: number, z: number) => {
  const cz = Math.cos(rad(p.rz));
  const sz = Math.sin(rad(p.rz));
  const x1 = x * cz - y * sz;
  const y1 = x * sz + y * cz;
  const cx = Math.cos(rad(p.rx));
  const sx = Math.sin(rad(p.rx));
  const y2 = y1 * cx - z * sx;
  const z2 = y1 * sx + z * cx;
  const X = x1 * p.s;
  const Y = y2 * p.s;
  const Z = z2 * p.s;
  const k = PERSP / (PERSP - Z);
  return {x: p.cx + X * k, y: p.cy + Y * k};
};

const slabCells = (layer: number) =>
  Array.from({length: 16}, (_, q) => {
    const i = Math.floor(q / 4);
    const j = q % 4;
    const v = layer === 0 ? W2[i][j] : (hash01(layer * 31 + q, 41) + hash01(layer * 17 + q, 42) - 1) * 2.2;
    return {i, j, v};
  });

export const Stack: React.FC<{frame: number; A: A3}> = ({frame: f, A}) => {
  const start = A.transformer - 170;
  if (f < start || f > A.sizes + 60) return null;
  const p = stackPose(f, A);
  const zOf = (i: number) => (i - (N - 1) / 2) * p.gap;
  const slabIn = (i: number) => (i === 0 ? 1 : ease.out(progress(f, A.transformer - 60 + (i - 1) * ((A.stack - A.transformer + 40) / (N - 1)), A.transformer - 30 + (i - 1) * ((A.stack - A.transformer + 40) / (N - 1)))));
  const numFade = 1 - progress(f, start + 30, start + 100);
  const appear = progress(f, start + 30, start + 42);
  const out = 1 - progress(f, A.sizes + 30, A.sizes + 56);
  const flat = progress(f, A.sizes - 40, A.sizes + 34);

  // 向量往上流：週期性
  const flowOn = progress(f, A.transformer + 10, A.transformer + 30) * (1 - progress(f, A.sizes - 50, A.sizes - 30));
  const period = 96;
  const ft = ((f - A.transformer) % period + period) % period / period;
  const zTop = zOf(N - 1) + 70;
  const zBot = zOf(0) - 70;
  const flowZ = lerp(zBot, zTop, ease.inOutSoft(ft));
  // 只在最上一層已出現時才流到頂
  let visTop = 0;
  for (let i = 0; i < N; i++) if (slabIn(i) > 0.9) visTop = i;
  const maxZ = zOf(visTop) + 70;
  const vz = Math.min(flowZ, maxZ);
  const vOp = flowOn * (flowZ > maxZ ? Math.max(0, 1 - (flowZ - maxZ) / 40) : 1) * Math.min(1, ft * 8);

  const vp = projectStack(p, 0, 0, vz);
  const bot = projectStack(p, 0, 0, zOf(0) - 90);
  const labelT = ease.out(progress(f, A.transformer - 20, A.transformer + 20)) * (1 - flat);

  return (
    <div style={{position: 'absolute', inset: 0, opacity: out * appear}}>
      <div style={{position: 'absolute', inset: 0, perspective: PERSP, perspectiveOrigin: `${p.cx}px ${p.cy}px`}}>
        <div
          style={{
            position: 'absolute',
            left: p.cx - SLAB_W / 2,
            top: p.cy - SLAB_H / 2,
            width: SLAB_W,
            height: SLAB_H,
            transformStyle: 'preserve-3d',
            transform: `scale(${p.s}) rotateX(${p.rx}deg) rotateZ(${p.rz}deg)`,
          }}
        >
          {Array.from({length: N}, (_, i) => {
            const t = slabIn(i);
            if (t <= 0) return null;
            const glow = Math.max(0, 1 - Math.abs(vz - zOf(i)) / 46) * vOp;
            const z = zOf(i) + (1 - t) * 260;
            const isTop = i === visTop;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  inset: 0,
                  transform: `translateZ(${z}px)`,
                  opacity: t,
                  background: `rgba(21,30,51,${0.42 + 0.3 * flat})`,
                  border: `2px solid rgba(255,181,71,${0.35 + 0.55 * glow + (isTop ? 0.15 : 0)})`,
                  borderRadius: 10,
                  boxShadow: glow > 0.05 ? `0 0 ${24 * glow}px rgba(255,181,71,${0.35 * glow})` : undefined,
                }}
              >
                {slabCells(i).map(({i: r, j, v}) => (
                  <div
                    key={`${r}-${j}`}
                    style={{
                      position: 'absolute',
                      left: j * 130 + 4,
                      top: r * 86 + 4,
                      width: 122,
                      height: 78,
                      borderRadius: 6,
                      background: tint(v, 1.2, (i === 0 ? 0.3 : 0.24) + 0.25 * glow),
                      border: `1.5px solid ${tint(v, 1.2, 0.5)}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: MONO,
                      fontWeight: 600,
                      fontSize: 38,
                      color: tint(v, 1.2),
                    }}
                  >
                    {i === 0 && numFade > 0 ? <span style={{opacity: numFade}}>{fmt(v, 1)}</span> : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* 向量（2D 疊加，依同一投影定位） */}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        {flowOn > 0 ? (
          <g opacity={flowOn}>
            <text x={bot.x} y={bot.y + 110} fontFamily={SANS} fontSize={24} fontWeight={600} letterSpacing="0.1em" fill={P.ice} textAnchor="middle">
              資料
            </text>
          </g>
        ) : null}
        {vOp > 0.01 ? (
          <g opacity={vOp} transform={`translate(${vp.x} ${vp.y})`}>
            <circle r={30} fill={P.ice} opacity={0.12} />
            {[0, 1, 2, 3].map((q) => (
              <rect key={q} x={-9} y={-34 + q * 17} width={18} height={14} rx={3} fill={P.ice} opacity={0.6 + 0.4 * hash01(q, 3)} />
            ))}
          </g>
        ) : null}
      </svg>

      {labelT > 0 ? (
        <div style={{position: 'absolute', left: 150, top: 200, opacity: labelT, transform: `translateY(${(1 - labelT) * 14}px)`}}>
          <div style={{fontFamily: SANS, fontWeight: 800, fontSize: 62, letterSpacing: '0.02em', color: P.paper}}>Transformer</div>
          <div style={{fontFamily: SANS, fontWeight: 500, fontSize: 24, letterSpacing: '0.1em', color: P.mist, marginTop: 6}}>（示意圖）</div>
        </div>
      ) : null}
    </div>
  );
};
