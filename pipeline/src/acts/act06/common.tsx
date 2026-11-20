import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {ease, progress} from '../../lib/anim';

export type Anchors = Record<string, number>;

/** 兩段淡入淡出的可見度：[a,b] 淡入、[c,d] 淡出。 */
export const vis = (f: number, a: number, b: number, c = Infinity, d = Infinity) => progress(f, a, b) * (1 - progress(f, c, d));

/** 顏色混合（#RRGGBB）。 */
export const mix = (a: string, b: string, t: number) => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/** 向量數值 → 顏色（琥珀＝正、冰藍＝負）。 */
export const valColor = (v: number, base: string = P.wall) => mix(base, v >= 0 ? P.amber : P.ice, Math.min(1, Math.abs(v)) * 0.75);

/** 角落「示意圖」標記。 */
export const SchematicTag: React.FC<{o: number; text?: string; right?: boolean}> = ({o, text = '示意圖', right = true}) =>
  o <= 0.001 ? null : (
    <div
      style={{
        position: 'absolute',
        top: 84,
        ...(right ? {right: 120} : {left: 120}),
        opacity: o,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        ...type.label,
        fontSize: 20,
        color: P.mist,
      }}
    >
      <span style={{width: 18, height: 1.5, background: P.mist, opacity: 0.7}} />
      {text}
    </div>
  );

/** 細引線＋小字標註（不加底框）。 */
export const Callout: React.FC<{x: number; y: number; dx: number; dy: number; title: string; sub?: string; t: number; color?: string; w?: number}> = ({
  x,
  y,
  dx,
  dy,
  title,
  sub,
  t,
  color = P.paper,
  w = 460,
}) => {
  if (t <= 0.001) return null;
  const k = ease.out(Math.min(1, t * 1.6));
  const ex = x + dx * k;
  const ey = y + dy * k;
  const textT = progress(t, 0.35, 1);
  const alignRight = dx < 0;
  const len = 150 * textT;
  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <circle cx={x} cy={y} r={4.5} fill="none" stroke={color} strokeWidth={1.5} opacity={t} />
        <circle cx={x} cy={y} r={1.8} fill={color} opacity={t} />
        <line x1={x} y1={y} x2={ex} y2={ey} stroke={color} strokeWidth={1.3} opacity={0.8 * t} />
        <line x1={ex} y1={ey} x2={ex + (alignRight ? -len : len)} y2={ey} stroke={color} strokeWidth={1.3} opacity={0.5 * t} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: alignRight ? ex - w : ex,
          top: ey - 44,
          width: w,
          textAlign: alignRight ? 'right' : 'left',
          opacity: textT,
          transform: `translateY(${(1 - textT) * 8}px)`,
          fontFamily: fontStack,
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{...type.title, fontSize: 28, color}}>{title}</div>
        {sub ? <div style={{...type.label, fontSize: 20, color: P.mist, marginTop: 14}}>{sub}</div> : null}
      </div>
    </>
  );
};

/** token 小方塊（文字置中）。x, y 為中心點。 */
export const Chip: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  fs: number;
  text: string;
  color?: string;
  border?: string;
  fill?: string;
  o?: number;
  scale?: number;
  mono?: boolean;
  glow?: number;
  borderO?: number;
}> = ({x, y, w, h, fs, text, color = P.paper, border = P.ice, fill = P.wall, o = 1, scale = 1, mono, glow = 0, borderO = 1}) =>
  o <= 0.001 ? null : (
    <div
      style={{
        position: 'absolute',
        left: x - w / 2,
        top: y - h / 2,
        width: w,
        height: h,
        opacity: o,
        transform: `scale(${scale})`,
        borderRadius: Math.min(10, h * 0.18),
        background: fill,
        boxShadow: `inset 0 0 0 ${1.5 * borderO}px ${border}${glow > 0 ? `, 0 0 ${Math.round(22 * glow)}px ${border.startsWith('#') ? border + '66' : border}` : ''}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        fontSize: fs,
        ...(mono ? type.mono : type.title),
        letterSpacing: mono ? '0.02em' : '0.02em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );

/** 淡淡的點陣背景（隨 2D 攝影機視差移動）。 */
export const DotField: React.FC<{ox?: number; oy?: number; o?: number}> = ({ox = 0, oy = 0, o = 1}) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      opacity: o,
      backgroundImage: `radial-gradient(circle, ${P.line} 1.3px, transparent 1.6px)`,
      backgroundSize: '48px 48px',
      backgroundPosition: `${ox}px ${oy}px`,
    }}
  />
);

/** 箭頭頭部（SVG path 字串），指向 (x,y)，方向角 a。 */
export const arrowHead = (x: number, y: number, a: number, s = 12) => {
  const l = [x - s * Math.cos(a - 0.45), y - s * Math.sin(a - 0.45)];
  const r = [x - s * Math.cos(a + 0.45), y - s * Math.sin(a + 0.45)];
  return `M ${l[0]} ${l[1]} L ${x} ${y} L ${r[0]} ${r[1]}`;
};
