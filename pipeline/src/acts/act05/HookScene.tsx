import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {ease, lerp, progress} from '../../lib/anim';
import type {A5} from './timing';
import {MONO, Rect, rectLerp} from './ui';
import {TERM, TERM_BAR, TERM_BAR_BG, TERM_BG} from './term';

/**
 * 開場提問：同一個模型分給 CPU 與 GPU，兩邊同時逐 token 生成同一句話，GPU 明顯較快（示意，不顯示數字）。
 * 「差在哪裡？」之後兩個面板收攏成終端機視窗。
 */
const TOKENS = ['天空', '之所以', '是', '藍色', '的', '，', '是', '因為', '陽光', '裡', '的', '藍光', '更容易', '被', '空氣', '散射', '。'];
const L: Rect = {x: 190, y: 300, w: 750, h: 360};
const R: Rect = {x: 980, y: 300, w: 750, h: 360};
const termL: Rect = {x: TERM.x, y: TERM.y, w: TERM.w / 2, h: TERM.h};
const termR: Rect = {x: TERM.x + TERM.w / 2, y: TERM.y, w: TERM.w / 2, h: TERM.h};

export const HookScene: React.FC<{f: number; a: A5}> = ({f, a}) => {
  if (a.hook < 0 || f > a.hook + 70) return null;
  const h = a.hook;
  const genStart = 100;
  // GPU 在 hook 前約 90 幀完成；CPU 約完成一半（純示意）
  const gpuStep = Math.max(4, (h - 90 - genStart) / TOKENS.length);
  const cpuStep = gpuStep * 2.9;
  const nG = Math.max(0, Math.min(TOKENS.length, Math.floor((f - genStart) / gpuStep)));
  const nC = Math.max(0, Math.min(TOKENS.length, Math.floor((f - genStart) / cpuStep)));
  const frozen = f > h - 4;

  const chipT = progress(f, 0, 30);
  const split = ease.camera(progress(f, 40, 92));
  const panelT = ease.out(progress(f, 46, 96));
  const merge = ease.camera(progress(f, h + 26, h + 80));
  const mergeO = 1 - progress(f, h + 30, h + 58);
  const qT = progress(f, h - 10, h + 16) * (1 - progress(f, h + 30, h + 52));
  const barT = progress(f, genStart + 40, genStart + 90);

  const rL = rectLerp(rectLerp({...L, x: L.x + 60, w: L.w - 120}, L, panelT), termL, merge);
  const rR = rectLerp(rectLerp({...R, x: R.x + 60, w: R.w - 120}, R, panelT), termR, merge);

  return (
    <div style={{position: 'absolute', inset: 0, opacity: mergeO}}>
      <Panel r={rL} o={panelT} label="CPU" color={P.amber} n={frozen ? Math.min(nC, Math.floor((h - 4 - genStart) / cpuStep)) : nC} f={f} bar={barT} speed={1 / 2.9} />
      <Panel r={rR} o={panelT} label="GPU" color={P.ice} n={nG} f={f} bar={barT} speed={1} />
      {/* 同一個模型：GGUF 小檔案從中央分成兩份 */}
      {[-1, 1].map((s) => {
        const tx = s < 0 ? L.x + L.w - 150 : R.x + R.w - 150;
        const x = lerp(960 - 70, tx, split);
        const y = lerp(470, L.y + 7, split);
        return (
          <div
            key={s}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: 140,
              height: lerp(150, 32, split),
              border: `2px solid ${P.amber}`,
              borderRadius: 6,
              background: 'rgba(255,181,71,0.08)',
              opacity: chipT * (split < 0.02 && s > 0 ? 0 : 1),
              fontFamily: MONO,
              fontSize: lerp(26, 18, split),
              color: P.amber,
              textAlign: 'center',
              lineHeight: split > 0.5 ? '28px' : '146px',
              fontWeight: 700,
            }}
          >
            GGUF
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: 1920,
          top: 640,
          textAlign: 'center',
          ...type.label,
          fontSize: 26,
          color: P.paper,
          opacity: chipT * (1 - progress(f, 40, 60)),
        }}
      >
        同一個模型
      </div>
      {qT > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: 1920,
            top: 140,
            textAlign: 'center',
            fontFamily: fontStack,
            fontWeight: 800,
            fontSize: 110,
            color: P.amber,
            opacity: qT,
            transform: `scale(${0.8 + 0.2 * ease.out(qT)})`,
          }}
        >
          ?
        </div>
      ) : null}
    </div>
  );
};

const Panel: React.FC<{r: Rect; o: number; label: string; color: string; n: number; f: number; bar: number; speed: number}> = ({r, o, label, color, n, f, bar, speed}) => {
  const text = TOKENS.slice(0, n);
  const done = n >= TOKENS.length;
  const cursorOn = Math.floor(f / 20) % 2 === 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        opacity: o,
        background: TERM_BG,
        border: `2px solid ${P.line}`,
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      <div style={{height: TERM_BAR, background: TERM_BAR_BG, display: 'flex', alignItems: 'center', paddingLeft: 24, gap: 14}}>
        <svg width={26} height={26}>
          <rect x={3} y={3} width={20} height={20} rx={3} fill="none" stroke={color} strokeWidth={2} />
          <rect x={8} y={8} width={10} height={10} rx={1} fill={color} />
        </svg>
        <span style={{fontFamily: MONO, fontSize: 24, fontWeight: 700, color}}>{label}</span>
      </div>
      <div style={{padding: '26px 36px', fontFamily: fontStack, fontSize: 36, lineHeight: 1.6, color: P.paper, letterSpacing: '0.04em'}}>
        {text.map((t, i) => (
          <span key={i} style={{color: i === n - 1 && !done ? color : P.paper}}>
            {t}
          </span>
        ))}
        {!done ? <span style={{display: 'inline-block', width: 16, height: 36, background: cursorOn ? color : 'transparent', verticalAlign: '-6px', marginLeft: 4}} /> : null}
      </div>
      {/* 生成速度（相對示意，無數字） */}
      <div style={{position: 'absolute', left: 36, right: 36, bottom: 30, height: 8, borderRadius: 4, background: 'rgba(138,151,180,0.18)', opacity: bar}}>
        <div style={{width: `${100 * speed * ease.out(bar)}%`, height: 8, borderRadius: 4, background: color}} />
      </div>
      <div style={{position: 'absolute', left: 36, bottom: 46, ...type.label, fontSize: 19, color: P.mist, opacity: bar}}>生成速度</div>
    </div>
  );
};
