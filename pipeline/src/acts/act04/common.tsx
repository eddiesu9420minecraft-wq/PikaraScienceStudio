import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, ease, progress} from '../../lib/anim';

export {P, fontStack, type};

export type A = Record<string, number>;

/** 錨點取值（缺少時給後備值，避免整幕崩潰；後備值只在估算時間軸缺詞時使用）。 */
export const an = (anchors: A, name: string, fallback: number) => {
  const v = anchors[name];
  return v === undefined ? fallback : v;
};

/** 出現 → 消失 的包絡（0..1）。 */
export const env = (f: number, inA: number, inB: number, outA: number, outB: number) =>
  ease.out(progress(f, inA, inB)) * (1 - ease.inOut(progress(f, outA, outB)));

export const MONO = '"Cascadia Mono", "Consolas", monospace';

/** 世界座標中的一個站點（1920×1080 的區塊）。 */
export const Station: React.FC<{x: number; y: number; children: React.ReactNode; show?: boolean}> = ({x, y, children, show = true}) =>
  show ? <div style={{position: 'absolute', left: x, top: y, width: 1920, height: 1080}}>{children}</div> : null;

/** 文字揭示：由下往上滑入 + 淡入。 */
export const Rise: React.FC<{t: number; children: React.ReactNode; style?: React.CSSProperties; dist?: number}> = ({
  t,
  children,
  style,
  dist = 18,
}) => {
  const k = clamp(t);
  if (k <= 0.001) return null;
  return <div style={{opacity: k, transform: `translateY(${(1 - ease.out(k)) * dist}px)`, ...style}}>{children}</div>;
};

/** 絕對定位文字（中心或左對齊）。 */
export const Txt: React.FC<{
  x: number;
  y: number;
  t?: number;
  size?: number;
  color?: string;
  weight?: number;
  align?: 'left' | 'center' | 'right';
  mono?: boolean;
  children: React.ReactNode;
  w?: number;
  ls?: string;
  style?: React.CSSProperties;
}> = ({x, y, t = 1, size = 26, color = P.paper, weight = 500, align = 'left', mono, children, w = 900, ls, style}) => {
  if (t <= 0.001) return null;
  const left = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w;
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: y - size * 0.7,
        width: w,
        textAlign: align,
        fontFamily: mono ? MONO : fontStack,
        fontSize: size,
        fontWeight: weight,
        color,
        letterSpacing: ls ?? (mono ? '0.02em' : '0.05em'),
        whiteSpace: 'nowrap',
        lineHeight: 1.4,
        opacity: clamp(t),
        transform: `translateY(${(1 - ease.out(clamp(t))) * 14}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** 角落的「示意圖」標記（螢幕座標，不跟鏡頭）。 */
export const SchematicTag: React.FC<{t: number; text?: string}> = ({t, text = '示意圖'}) =>
  t > 0.001 ? (
    <div
      style={{
        position: 'absolute',
        right: 128,
        top: 84,
        fontFamily: fontStack,
        fontSize: 20,
        fontWeight: 500,
        letterSpacing: '0.12em',
        color: P.mist,
        opacity: t * 0.9,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{width: 18, height: 1.5, background: P.mist, display: 'inline-block'}} />
      {text}
    </div>
  ) : null;

/** SVG 斜線填色定義。 */
export const HatchDefs: React.FC<{id: string; color: string; gap?: number; width?: number; opacity?: number}> = ({
  id,
  color,
  gap = 10,
  width = 2,
  opacity = 1,
}) => (
  <pattern id={id} patternUnits="userSpaceOnUse" width={gap} height={gap} patternTransform="rotate(45)">
    <line x1={0} y1={0} x2={0} y2={gap} stroke={color} strokeWidth={width} opacity={opacity} />
  </pattern>
);

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/** 帶小三角的數值變化（用於計數器）。 */
export const smooth = (t: number) => ease.inOut(clamp(t));
