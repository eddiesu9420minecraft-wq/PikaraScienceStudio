import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {ease, lerp, progress} from '../../lib/anim';
import {anchor} from '../actData';
import {Anchors, mix, vis} from './common';

/** 開場鉤子：「它每一步只在做一件事：猜下一個字」——今天天氣很 [？] */
export const hookTimes = (A: Anchors) => {
  const hook = anchor(A, 'hook');
  const ready = anchor(A, 'ready');
  return {hook, ready, outA: ready - 175, outB: ready - 135};
};

const CANDS = [
  {t: '好', p: 0.62},
  {t: '熱', p: 0.24},
  {t: '冷', p: 0.09},
];

export const HookIntro: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = hookTimes(A);
  if (f > T.outB + 2) return null;
  const out = ease.in(progress(f, T.outA, T.outB));
  const FS = 84;
  const words = [...'今天天氣很'];
  const slotW = 110;
  const total = words.length * FS + 22 + slotW;
  const x0 = 960 - total / 2;
  const Y = 470;
  const slotX = x0 + words.length * FS + 22 + slotW / 2;
  const candO = vis(f, T.hook - 190, T.hook - 150, T.hook + 10, T.hook + 40);
  // 掃描：在候選之間來回比較
  const scanT = progress(f, T.hook - 130, T.hook - 24);
  const scanIdx = scanT <= 0 ? -1 : [0, 1, 2, 1, 0][Math.min(4, Math.floor(scanT * 5))];
  const fly = ease.inOut(progress(f, T.hook - 18, T.hook + 12));
  const landed = progress(f, T.hook + 8, T.hook + 14);
  const flash = vis(f, T.hook + 8, T.hook + 12, T.hook + 20, T.hook + 70);
  const blink = Math.floor(f / 26) % 2 === 0 ? 1 : 0.25;
  const candY = (i: number) => Y + 150 + i * 82;

  return (
    <div style={{position: 'absolute', inset: 0, opacity: 1 - out, transform: `translateY(${-30 * out}px)`}}>
      {words.map((w, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: x0 + i * FS,
            top: Y - FS * 0.62,
            width: FS,
            textAlign: 'center',
            ...type.title,
            fontSize: FS,
            lineHeight: 1.24,
            color: P.paper,
            letterSpacing: 0,
            opacity: 1,
          }}
        >
          {w}
        </div>
      ))}
      {/* 下一個字的空位 */}
      <div
        style={{
          position: 'absolute',
          left: slotX - slotW / 2,
          top: Y - 58,
          width: slotW,
          height: 116,
          borderRadius: 12,
          border: `2.5px dashed ${mix(P.amber, P.paper, flash)}`,
          background: landed > 0 ? `rgba(255,181,71,${0.16 * landed})` : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {landed <= 0 ? <div style={{width: 5, height: 70, borderRadius: 2, background: P.amber, opacity: blink}} /> : null}
      </div>
      {/* 候選：每一個可能的下一個字都有一個機率 */}
      {CANDS.map((c, i) => {
        const o = candO * progress(f, T.hook - 190 + i * 8, T.hook - 160 + i * 8);
        const hl = scanIdx === i ? 1 : 0;
        const y = candY(i);
        const isWinner = i === 0;
        if (isWinner && fly > 0) {
          const x = lerp(slotX, slotX, fly);
          const yy = lerp(y, Y, fly);
          const fs = lerp(52, FS, fly);
          return (
            <div key={i} style={{position: 'absolute', left: x - 100, width: 200, top: yy - fs * 0.62, textAlign: 'center', ...type.title, fontSize: fs, lineHeight: 1.24, color: mix(P.amber, P.paper, landed * (1 - flash))}}>
              {c.t}
            </div>
          );
        }
        return (
          <React.Fragment key={i}>
            <div
              style={{
                position: 'absolute',
                left: slotX - 100,
                width: 200,
                top: y - 32,
                textAlign: 'center',
                ...type.title,
                fontSize: 52,
                lineHeight: 1.24,
                color: hl ? P.amber : P.paper,
                opacity: o * (hl ? 1 : 0.7),
              }}
            >
              {c.t}
            </div>
            <div
              style={{
                position: 'absolute',
                left: slotX + 52,
                top: y - 9,
                height: 18,
                borderRadius: 4,
                width: 260 * c.p * ease.out(o),
                background: i === 0 ? P.amber : P.ice,
                opacity: o * (0.5 + 0.5 * hl),
              }}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
};
