import React from 'react';

/**
 * 平塗＋硬邊明暗：形狀本體 + 背光側暗帶 + 受光側輪廓光（螢幕冰藍）。
 * 暗帶／輪廓光＝「形狀 減去 自身位移後的形狀」（mask），所以永遠貼著輪廓、粗細穩定。
 * shadow/rim 的 dx,dy 是「把遮罩形狀往哪裡推」：例 rim {dx:-3} → 右緣留下 3px 亮邊。
 */
export type Band = {c: string; dx: number; dy: number; op?: number};

export const Lit: React.FC<{
  id: string;
  d: string;
  fill: string;
  shadow?: Band;
  shadow2?: Band;
  rim?: Band;
  children?: React.ReactNode; // 本體之上、輪廓光之下的細節（自動裁切在形狀內）
}> = ({id, d, fill, shadow, shadow2, rim, children}) => {
  const band = (b: Band, key: string) => (
    <g key={key}>
      <mask id={`${id}-${key}`} maskUnits="userSpaceOnUse" x={-3000} y={-3000} width={8000} height={8000}>
        <path d={d} fill="#fff" />
        <path d={d} fill="#000" transform={`translate(${b.dx} ${b.dy})`} />
      </mask>
      <path d={d} fill={b.c} opacity={b.op ?? 1} mask={`url(#${id}-${key})`} />
    </g>
  );
  return (
    <g>
      <path d={d} fill={fill} />
      {children ? (
        <>
          <clipPath id={`${id}-clip`}>
            <path d={d} />
          </clipPath>
          <g clipPath={`url(#${id}-clip)`}>{children}</g>
        </>
      ) : null}
      {shadow ? band(shadow, 's') : null}
      {shadow2 ? band(shadow2, 's2') : null}
      {rim ? band(rim, 'r') : null}
    </g>
  );
};
