import React from 'react';
import {palette as P} from '../theme/palette';
import {fontStack, type} from '../theme/fonts';
import {clamp, ease, progress, rng, wobble} from '../lib/anim';
import type {ActProps} from '../acts/types';

/**
 * 通用旁白樣板（沒有手工動畫的集數使用）：
 *  - 開場：畫面中央的大標題（第一幕顯示集數與集名），第一個關鍵詞出現時收到左上角成為常駐標題。
 *  - 關鍵詞卡片：narration.json 的 anchors 每一個都是一張卡片，在旁白念到該詞的那一幀彈出；
 *    最新的卡片以琥珀色強調，舊卡片淡出到次要層級。
 *  - 右上角句子進度點；背景為緩慢漂移的點陣與資料粒子。底部 300px 保留給字幕，不放任何內容。
 * 全部由旁白時間軸驅動（frame、anchors、lines），沒有寫死的秒數。
 */

type Card = {name: string; word: string; at: number};

const W = 1920;
const SAFE_BOTTOM = 780; // 卡片區下緣（字幕在 1080-64 以上約 160px）

const Backdrop: React.FC<{frame: number; seed: number}> = ({frame, seed}) => {
  const r = rng(seed);
  const dots = Array.from({length: 26}, () => ({x: r() * W, y: r() * 1080, s: 2 + r() * 3, sp: 0.15 + r() * 0.35, ph: r(), c: r() < 0.7 ? P.ice : P.amber}));
  const drift = (frame * 0.25) % 48;
  return (
    <>
      <div style={{position: 'absolute', inset: 0, background: `radial-gradient(ellipse 70% 60% at 50% 44%, ${P.wall} 0%, ${P.night} 55%, ${P.ink} 100%)`}} />
      <svg width={W} height={1080} style={{position: 'absolute', inset: 0, opacity: 0.32}}>
        <defs>
          <pattern id={`g${seed}`} width={48} height={48} patternUnits="userSpaceOnUse" patternTransform={`translate(${drift} ${drift * 0.5})`}>
            <circle cx={2} cy={2} r={1.4} fill={P.line} />
          </pattern>
          <radialGradient id={`m${seed}`} cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="#fff" stopOpacity={1} />
            <stop offset="100%" stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <mask id={`k${seed}`}>
            <rect width={W} height={1080} fill={`url(#m${seed})`} />
          </mask>
        </defs>
        <rect width={W} height={1080} fill={`url(#g${seed})`} mask={`url(#k${seed})`} />
      </svg>
      <svg width={W} height={1080} style={{position: 'absolute', inset: 0}}>
        {dots.map((d, i) => {
          const y = (d.y - frame * d.sp + 1080) % 1080;
          const o = 0.18 + 0.22 * (0.5 + 0.5 * wobble(frame, 240, d.ph));
          return <rect key={i} x={d.x + wobble(frame, 400, d.ph) * 14} y={y} width={d.s} height={d.s} fill={d.c} opacity={o} transform={`rotate(45 ${d.x} ${y})`} />;
        })}
      </svg>
    </>
  );
};

/** 中央大標題 → 左上角常駐標題 */
const TitleBlock: React.FC<{frame: number; dock: number; first: boolean; epLabel: string; epTitle: string; title: string; index: number; total: number}> = ({
  frame,
  dock,
  first,
  epLabel,
  epTitle,
  title,
  index,
  total,
}) => {
  const inK = ease.out(progress(frame, 8, 48));
  const k = ease.camera(clamp(dock)); // 0 = 置中大標題，1 = 左上角
  const heroO = inK * (1 - k);
  const tagO = k;
  const line = ease.inOut(progress(frame, 24, 70));
  return (
    <>
      {heroO > 0.002 ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 330 - k * 120,
            textAlign: 'center',
            opacity: heroO,
            transform: `translateY(${(1 - inK) * 26}px) scale(${1 - k * 0.2})`,
            fontFamily: fontStack,
          }}
        >
          <div style={{...type.mono, fontSize: 30, color: P.amber, letterSpacing: '0.24em'}}>
            {epLabel}
            <span style={{color: P.mist}}>{`  ·  ${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`}</span>
          </div>
          <div style={{...type.display, fontSize: first ? 92 : 84, color: P.paper, marginTop: 26, lineHeight: 1.2}}>{first ? epTitle : title}</div>
          {first && title ? <div style={{...type.title, fontSize: 40, color: P.mist, marginTop: 22}}>{title}</div> : null}
          <div style={{height: 3, width: 420 * line, background: P.amber, margin: '34px auto 0', opacity: 0.8}} />
        </div>
      ) : null}
      {tagO > 0.002 ? (
        <div style={{position: 'absolute', left: 120, top: 78, fontFamily: fontStack, opacity: tagO, transform: `translateX(${(1 - tagO) * -18}px)`}}>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 16}}>
            <span style={{...type.mono, fontSize: 30, color: P.amber, letterSpacing: '0.08em'}}>{String(index + 1).padStart(2, '0')}</span>
            <span style={{...type.label, fontSize: 18, color: P.mist, letterSpacing: '0.2em'}}>/ {String(total).padStart(2, '0')}</span>
            <span style={{...type.title, fontSize: 30, color: P.paper, marginLeft: 8}}>{title || epTitle}</span>
          </div>
          <div style={{height: 2, width: 360, background: P.amber, opacity: 0.7, marginTop: 12}} />
          <div style={{...type.label, fontSize: 18, color: P.mist, marginTop: 12}}>{`${epLabel}　${epTitle}`}</div>
        </div>
      ) : null}
    </>
  );
};

const CardView: React.FC<{c: Card; i: number; frame: number; x: number; y: number; w: number; newest: boolean}> = ({c, i, frame, x, y, w, newest}) => {
  const local = frame - c.at;
  const k = ease.out(progress(local, -6, 22));
  if (k <= 0) return null;
  const focus = newest ? 1 : 0.62;
  const ring = progress(local, -4, 40);
  const under = ease.inOut(progress(local, 6, 36));
  const fs = c.word.length > 8 ? 52 : c.word.length > 5 ? 60 : 68;
  return (
    <div style={{position: 'absolute', left: x, top: y, width: w, height: 200, opacity: k * focus, transform: `translateY(${(1 - k) * 28}px) scale(${0.94 + 0.06 * k})`}}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 18,
          background: `linear-gradient(160deg, ${P.wallLight}EE 0%, ${P.night}F2 100%)`,
          border: `2px solid ${newest ? P.amber : P.line}`,
          boxShadow: newest ? `0 0 0 1px ${P.amber}33, 0 18px 50px rgba(0,0,0,0.45)` : '0 12px 32px rgba(0,0,0,0.35)',
        }}
      />
      <div style={{position: 'absolute', left: 28, top: 22, ...type.mono, fontSize: 24, color: newest ? P.amber : P.mist, letterSpacing: '0.1em'}}>{String(i + 1).padStart(2, '0')}</div>
      <svg width={40} height={40} style={{position: 'absolute', right: 22, top: 18}}>
        <rect x={13} y={13} width={14} height={14} fill={i % 2 ? P.ice : P.amber} transform="rotate(45 20 20)" opacity={0.9} />
      </svg>
      <div style={{position: 'absolute', left: 28, right: 28, top: 70, ...type.display, fontSize: fs, color: P.paper, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{c.word}</div>
      <div style={{position: 'absolute', left: 28, bottom: 30, height: 3, width: (w - 56) * under, background: i % 2 ? P.ice : P.amber, opacity: 0.75, borderRadius: 2}} />
      {ring < 1 ? (
        <svg width={w} height={200} style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
          <rect x={-ring * 24} y={-ring * 24} width={w + ring * 48} height={200 + ring * 48} rx={18 + ring * 10} fill="none" stroke={P.amber} strokeWidth={2} opacity={(1 - ring) * 0.6} />
        </svg>
      ) : null}
    </div>
  );
};

const LineDots: React.FC<{frame: number; lines: ActProps['lines']}> = ({frame, lines}) => {
  if (lines.length < 2) return null;
  return (
    <div style={{position: 'absolute', right: 120, top: 92, display: 'flex', gap: 12, opacity: ease.out(progress(frame, 20, 60))}}>
      {lines.map((l) => {
        const on = frame >= l.from && frame < l.to;
        const done = frame >= l.to;
        return <div key={l.id} style={{width: on ? 34 : 12, height: 12, borderRadius: 6, background: on ? P.amber : done ? P.mist : P.line, opacity: on ? 1 : 0.8}} />;
      })}
    </div>
  );
};

export const GenericAct: React.FC<ActProps> = ({frame, durationInFrames, anchors, anchorWords = {}, lines, title = '', index = 0, total = 1, episodeId = '', episodeTitle = ''}) => {
  const cards: Card[] = Object.entries(anchors)
    .map(([name, at]) => ({name, at, word: anchorWords[name] ?? name}))
    .sort((a, b) => a.at - b.at);
  const firstAt = cards.length ? cards[0].at : Math.min(durationInFrames * 0.5, 240);
  // 第一張卡片出現前 40 幀開始收合標題；沒有錨點時，標題在約 4 秒後收合，中央改為本幕標題的呼吸動畫
  const dock = progress(frame, firstAt - 40, firstAt);
  const n = cards.length;
  const perRow = n <= 3 ? Math.max(1, n) : Math.ceil(n / 2);
  const rows = Math.ceil(n / perRow);
  const w = perRow <= 2 ? 520 : perRow === 3 ? 460 : 360;
  const gap = 36;
  const top = rows === 1 ? 420 : 300;
  const shown = cards.filter((c) => frame >= c.at - 6);
  const newest = shown.length ? shown[shown.length - 1].name : null;
  const epLabel = episodeId.toUpperCase();
  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
      <Backdrop frame={frame} seed={hash(episodeId + title)} />
      <TitleBlock frame={frame} dock={dock} first={index === 0} epLabel={epLabel} epTitle={episodeTitle} title={title} index={index} total={total} />
      <LineDots frame={frame} lines={lines} />
      {n === 0 ? (
        <div style={{position: 'absolute', left: 0, right: 0, top: 430, textAlign: 'center', opacity: ease.out(progress(frame, firstAt, firstAt + 40)), fontFamily: fontStack}}>
          <div style={{...type.display, fontSize: 76, color: P.paper, transform: `scale(${1 + 0.01 * wobble(frame, 300)})`}}>{title || episodeTitle}</div>
          <div style={{height: 3, width: 300, background: P.amber, margin: '30px auto 0', opacity: 0.7}} />
        </div>
      ) : null}
      {cards.map((c, i) => {
        const row = Math.floor(i / perRow);
        const inRow = row === rows - 1 ? n - row * perRow : perRow;
        const col = i - row * perRow;
        const rowW = inRow * w + (inRow - 1) * gap;
        const x = (W - rowW) / 2 + col * (w + gap);
        const y = Math.min(SAFE_BOTTOM - 200, top + row * (200 + gap));
        return <CardView key={c.name} c={c} i={i} frame={frame} x={x} y={y} w={w} newest={c.name === newest} />;
      })}
    </div>
  );
};

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
