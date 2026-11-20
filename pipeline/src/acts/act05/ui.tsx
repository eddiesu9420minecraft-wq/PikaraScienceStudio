import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {ease, lerp, progress} from '../../lib/anim';

export type Rect = {x: number; y: number; w: number; h: number};
export const rectLerp = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});
export const cx = (r: Rect) => r.x + r.w / 2;
export const cy = (r: Rect) => r.y + r.h / 2;

/** 0→1→0 的窗口函式：在 [a,b] 淡入、[c,d] 淡出 */
export const win = (f: number, a: number, b: number, c: number, d: number) => progress(f, a, b) * (1 - progress(f, c, d));

export const MONO = '"Cascadia Mono", "Consolas", monospace';

/**
 * 細引線＋小字標註（複製自 GpuLabels 的 Callout，加上可調文字寬度）。
 * (x,y) 是被標註物的位置；(dx,dy) 是引線轉折點的偏移。
 */
export const Callout: React.FC<{
  x: number;
  y: number;
  dx: number;
  dy: number;
  title: string;
  sub?: string;
  t: number;
  color?: string;
  size?: number;
  tail?: number;
}> = ({x, y, dx, dy, title, sub, t, color = P.paper, size = 30, tail = 200}) => {
  if (t <= 0.001) return null;
  const k = ease.out(Math.min(1, t * 1.6));
  const ex = x + dx * k;
  const ey = y + dy * k;
  const textT = progress(t, 0.35, 1);
  const alignRight = dx < 0;
  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <circle cx={x} cy={y} r={5} fill="none" stroke={color} strokeWidth={1.6} opacity={t} />
        <circle cx={x} cy={y} r={2} fill={color} opacity={t} />
        <line x1={x} y1={y} x2={ex} y2={ey} stroke={color} strokeWidth={1.3} opacity={0.85 * t} />
        <line x1={ex} y1={ey} x2={ex + (alignRight ? -tail : tail) * textT} y2={ey} stroke={color} strokeWidth={1.3} opacity={0.55 * t} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: alignRight ? ex - 520 : ex + 4,
          top: ey - size - 14,
          width: 516,
          textAlign: alignRight ? 'right' : 'left',
          opacity: textT,
          transform: `translateY(${(1 - textT) * 8}px)`,
          fontFamily: fontStack,
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{...type.title, fontSize: size, color, lineHeight: 1.1, textShadow: '0 1px 8px rgba(5,8,16,0.9)'}}>{title}</div>
        {sub ? <div style={{...type.label, fontSize: 21, color: '#B7C2D9', marginTop: 22, textShadow: '0 1px 6px rgba(5,8,16,0.95), 0 0 2px rgba(5,8,16,0.9)'}}>{sub}</div> : null}
      </div>
    </>
  );
};

/** 畫面角落的「示意圖」標記 */
export const Schematic: React.FC<{o: number; text?: string}> = ({o, text = '示意圖'}) =>
  o > 0.001 ? (
    <div
      style={{
        position: 'absolute',
        right: 124,
        top: 84,
        opacity: o * 0.9,
        ...type.label,
        fontSize: 19,
        color: P.mist,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{width: 18, height: 1.5, background: P.mist, display: 'inline-block'}} />
      {text}
    </div>
  ) : null;
