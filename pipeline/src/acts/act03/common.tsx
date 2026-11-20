import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, rng} from '../../lib/anim';
import type {ActLine} from '../types';

// 估算版時間軸的預設錨點（只作為缺錨點時的後備；實際一律讀 anchors）
export const DEF = {
  hook: 233,
  db: 513,
  notdb: 676,
  numbers: 907,
  weights: 1092,
  matrix: 1300,
  multiply: 1416,
  nextlayer: 1647,
  transformer: 1912,
  stack: 2223,
  sizes: 2292,
  billion: 2526,
  b4: 2680,
  b70: 2819,
  bigger: 2953,
  memory: 3139,
  train: 3424,
  guess: 3654,
  adjust: 3757,
  freeze: 4056,
  inference: 4229,
  patterns: 4855,
} as const;
export type AName = keyof typeof DEF;
export type A3 = Record<AName, number> & {end: number; l1: number; l4: number; l7: number; l7e: number; l8: number; l9: number};

export const resolveAnchors = (anchors: Record<string, number>, dur: number, lines: ActLine[]): A3 => {
  const k = dur / 4923;
  const out: Record<string, number> = {end: dur};
  for (const n of Object.keys(DEF) as AName[]) out[n] = anchors[n] ?? DEF[n] * k;
  const from = (id: string, fb: number) => lines.find((l) => l.id === id)?.from ?? fb * k;
  out.l1 = from('a3-01', 333);
  out.l4 = from('a3-04', 1710);
  out.l7 = from('a3-07', 3315);
  out.l8 = from('a3-08', 3970);
  out.l9 = from('a3-09', 4534);
  out.l7e = lines.find((l) => l.id === 'a3-07')?.to ?? 3947 * k;
  return out as A3;
};

export const MONO = type.mono.fontFamily;
export const SANS = fontStack;

// ---- 數字與顏色 ----
export const fmt = (v: number, d: number) => {
  const s = Math.abs(v).toFixed(d);
  return (v < 0 && Number(s) !== 0 ? '−' : '') + s;
};

const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const mixRgb = (a: string, b: string, t: number) => {
  const A = hexRgb(a);
  const B = hexRgb(b);
  const u = clamp(t);
  return A.map((x, i) => Math.round(x + (B[i] - x) * u));
};
export const mix = (a: string, b: string, t: number, alpha = 1) => {
  const [r, g, bl] = mixRgb(a, b, t);
  return alpha >= 1 ? `rgb(${r},${g},${bl})` : `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
};
/** 正值琥珀、負值冰藍；|v| 越大越飽和。 */
export const tint = (v: number, range = 1.5, alpha = 1, base: string = P.mist) =>
  mix(base, v >= 0 ? P.amber : P.ice, 0.3 + 0.7 * clamp(Math.abs(v) / range), alpha);

export const hash01 = (a: number, b = 0) => rng((a * 73856093) ^ (b * 19349663) ^ 0x5bd1e995)();

export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export const gelu = (x: number) => 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));

// ---- 線性代數示意資料（數學正確：y = W·x，h = GELU(y)） ----
export const W1 = [
  [0.8, -0.5, 1.2, 0.3, -0.9],
  [-1.1, 0.4, 0.7, -0.2, 0.6],
  [0.2, 1.3, -0.8, 0.5, 0.1],
  [-0.6, -0.3, 0.9, 1.0, -0.4],
];
export const X1 = [1.0, -0.5, 0.5, 2.0, -1.0];
export const Y1 = W1.map((row) => row.reduce((s, w, j) => s + w * X1[j], 0));
export const H1 = Y1.map((y) => Number(gelu(y).toFixed(2)));
export const W2 = [
  [0.5, -0.7, 0.2, 0.9],
  [-0.3, 0.8, -1.0, 0.4],
  [1.1, 0.2, 0.6, -0.5],
  [-0.8, -0.4, 0.3, 0.7],
];
export const Y2 = W2.map((row) => row.reduce((s, w, j) => s + w * H1[j], 0));

// ---- 小元件 ----
export const Bracket: React.FC<{x: number; y1: number; y2: number; side: 'l' | 'r'; color: string; t?: number; w?: number; sw?: number; opacity?: number}> = ({
  x,
  y1,
  y2,
  side,
  color,
  t = 1,
  w = 16,
  sw = 3,
  opacity = 1,
}) => {
  if (t <= 0) return null;
  const dx = side === 'l' ? w : -w;
  const d = `M ${x + dx} ${y1} L ${x} ${y1} L ${x} ${y2} L ${x + dx} ${y2}`;
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      strokeDasharray="1 1"
      strokeDashoffset={1 - clamp(t)}
      opacity={opacity}
    />
  );
};

/** 角落「示意圖」標籤。 */
export const SchematicTag: React.FC<{opacity: number; text?: string}> = ({opacity, text = '示意圖'}) =>
  opacity <= 0.001 ? null : (
    <div
      style={{
        position: 'absolute',
        right: 120,
        top: 84,
        ...type.label,
        fontFamily: SANS,
        fontSize: 20,
        color: P.mist,
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{width: 18, height: 1.5, background: P.mist, display: 'inline-block', opacity: 0.7}} />
      {text}
    </div>
  );
