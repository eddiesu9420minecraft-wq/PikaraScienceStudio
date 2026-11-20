import React from 'react';
import {palette as P} from '../theme/palette';
import {fontStack, type} from '../theme/fonts';
import {ease, progress} from '../lib/anim';

/** 章節標記：每幕開場時於左上角短暫出現「02 ｜ 本地 AI 與雲端 AI」，讓觀眾知道進度。 */
export const ChapterTag: React.FC<{frame: number; index: number; title: string; total: number}> = ({frame, index, title, total}) => {
  const inT = ease.out(progress(frame, 26, 52));
  const outT = progress(frame, 230, 270);
  const o = inT * (1 - outT);
  if (o <= 0) return null;
  const line = ease.inOut(progress(frame, 30, 70)) * (1 - outT);
  return (
    <div style={{position: 'absolute', left: 120, top: 78, fontFamily: fontStack, opacity: o, transform: `translateX(${(1 - inT) * -18}px)`}}>
      <div style={{display: 'flex', alignItems: 'baseline', gap: 16}}>
        <span style={{...type.mono, fontSize: 30, color: P.amber, letterSpacing: '0.08em'}}>{String(index).padStart(2, '0')}</span>
        <span style={{...type.label, fontSize: 18, color: P.mist, letterSpacing: '0.2em'}}>/ {String(total).padStart(2, '0')}</span>
        <span style={{...type.title, fontSize: 30, color: P.paper, marginLeft: 8}}>{title}</span>
      </div>
      <div style={{height: 2, width: 360 * line, background: P.amber, opacity: 0.7, marginTop: 12}} />
    </div>
  );
};
