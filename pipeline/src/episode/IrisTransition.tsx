import React from 'react';
import {palette as P} from '../theme/palette';
import {ease, progress} from '../lib/anim';

/**
 * 「資料點」轉場：上一幕收合成畫面中央的琥珀色資料點，下一幕從同一個點展開。
 * 對應整集的視覺母題：文字 → 數字（資料點）→ 下一個概念。
 */
export const IRIS = 30;
const MAX_R = Math.hypot(960, 540) + 20;

export const irisRadius = (frame: number, duration: number, inOn: boolean, outOn: boolean) => {
  let r = MAX_R;
  if (inOn) r = Math.min(r, ease.inOut(progress(frame, 0, IRIS)) * MAX_R);
  if (outOn) r = Math.min(r, ease.inOut(1 - progress(frame, duration - IRIS, duration)) * MAX_R);
  return r;
};

export const IrisFrame: React.FC<{radius: number; children: React.ReactNode}> = ({radius, children}) => {
  if (radius >= MAX_R - 0.5) return <>{children}</>;
  const dot = Math.max(0, 1 - radius / 120);
  return (
    <div style={{position: 'absolute', inset: 0, background: P.ink}}>
      <div style={{position: 'absolute', inset: 0, clipPath: `circle(${Math.max(0, radius)}px at 960px 540px)`}}>{children}</div>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {radius > 2 ? <circle cx={960} cy={540} r={radius} fill="none" stroke={P.amber} strokeWidth={2} opacity={0.55 * (1 - radius / MAX_R)} /> : null}
        <rect x={953} y={533} width={14} height={14} fill={P.amber} opacity={dot} transform="rotate(45 960 540)" />
      </svg>
    </div>
  );
};
