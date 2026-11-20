import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {ease, lerp, progress} from '../../lib/anim';
import {arrowHead, Chip} from './common';

/** 「token 不一定等於一個字」的範例：英文單字、中文字（示意）。 */
export const Examples: React.FC<{oA: number; oB: number; oC: number; split: number}> = ({oA, oB, oC, split}) => {
  const rowY = [450, 600, 750];
  const head = (y: number, text: string, o: number) =>
    o > 0 ? (
      <div style={{position: 'absolute', left: 180, width: 300, top: y - 18, textAlign: 'right', ...type.label, fontSize: 26, color: P.mist, opacity: o}}>{text}</div>
    ) : null;
  const src = (y: number, text: string, o: number, latin = false) =>
    o > 0 ? (
      <div
        style={{
          position: 'absolute',
          left: 540,
          width: 260,
          top: y - 34,
          textAlign: 'center',
          ...type.title,
          fontSize: latin ? 50 : 58,
          color: P.paper,
          opacity: o,
          lineHeight: '68px',
          transform: `translateX(${(1 - o) * -20}px)`,
        }}
      >
        {text}
      </div>
    ) : null;
  const arrow = (y: number, o: number) =>
    o > 0 ? (
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: o}}>
        <line x1={830} y1={y} x2={830 + 90 * ease.out(o)} y2={y} stroke={P.mist} strokeWidth={2} />
        <path d={arrowHead(830 + 90 * ease.out(o), y, 0, 12)} fill="none" stroke={P.mist} strokeWidth={2} />
      </svg>
    ) : null;
  const count = (y: number, text: string, o: number) =>
    o > 0 ? (
      <div style={{position: 'absolute', left: 1360, width: 420, top: y - 20, ...type.title, fontSize: 32, color: P.amber, opacity: o, transform: `translateX(${(1 - o) * 16}px)`}}>
        {text}
      </div>
    ) : null;
  const cA = ease.out(progress(oA, 0.3, 1));
  const cB = ease.out(progress(oB, 0.3, 1));
  const cC = ease.out(progress(oC, 0.3, 1));
  const pieces = ['E9', '91', 'AB'];
  return (
    <>
      {head(rowY[0], '英文單字', oA)}
      {src(rowY[0], 'computer', oA, true)}
      {arrow(rowY[0], cA)}
      <Chip x={1120} y={rowY[0]} w={240} h={70} fs={40} text="computer" o={cA} scale={0.9 + 0.1 * cA} />
      {count(rowY[0], '1 個 token', progress(oA, 0.6, 1))}

      {head(rowY[1], '中文字', oB)}
      {src(rowY[1], '貓', oB)}
      {arrow(rowY[1], cB)}
      <Chip x={1120} y={rowY[1]} w={90} h={76} fs={46} text="貓" o={cB} scale={0.9 + 0.1 * cB} />
      {count(rowY[1], '1 個 token', progress(oB, 0.6, 1))}

      {src(rowY[2], '鑫', oC)}
      {arrow(rowY[2], cC)}
      {split < 0.5 ? <Chip x={1120} y={rowY[2]} w={90} h={76} fs={46} text="鑫" o={cC * (1 - progress(split, 0.3, 0.5))} scale={0.9 + 0.1 * cC} /> : null}
      {pieces.map((p, i) => {
        const o = cC * progress(split, 0.3, 0.6);
        const x = 1120 + (i - 1) * lerp(30, 96, split);
        return <Chip key={p} x={x} y={rowY[2]} w={lerp(30, 82, split)} h={76} fs={30} text={p} mono o={o} border={P.amber} />;
      })}
      {count(rowY[2], '3 個 token', progress(split, 0.5, 1) * oC)}
      {oC > 0 ? (
        <div style={{position: 'absolute', left: 1360, width: 460, top: rowY[2] + 26, ...type.label, fontSize: 20, color: P.mist, opacity: progress(split, 0.6, 1) * oC}}>
          較少見的字可能被拆成好幾塊
        </div>
      ) : null}
    </>
  );
};
