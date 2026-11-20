import React from 'react';
import {AbsoluteFill} from 'remotion';
import {PikaraMark} from '../components/PikaraBrand';
import {palette as P} from '../theme/palette';
import {ensureFonts, fontStack} from '../theme/fonts';
import {rng} from '../lib/anim';
import narration from '../data/narration.json';
import {compPrefix} from './registry';

ensureFonts();

/**
 * 通用封面（每一集自動註冊為 <EP>-Thumbnail）：內容來自 narration.json 的 sequences.<ep>.thumbnail
 *   {lines: ["主標第一行", "第二行"], highlight: "黃色強調條", tags: ["關鍵詞", …]}
 * 沒有 thumbnail 時以集名代替。設計沿用 EP01 封面：2 行超大粗字（深色描邊，縮到 320px 寬仍可讀）、
 * 一個高對比強調條、少量標籤、集數與品牌。背景是決定性的資料點陣與光暈（無外部圖片）。
 */
type Thumb = {lines?: string[]; highlight?: string; tags?: string[]};
type Seq = {title?: string; thumbnail?: Thumb};
const sequences = (narration as unknown as {sequences: Record<string, Seq>}).sequences;

const stroke = (w: number, c = '#05070D') => ({
  WebkitTextStroke: `${w}px ${c}`,
  paintOrder: 'stroke fill' as const,
  textShadow: `0 ${w * 0.6}px ${w * 2.2}px rgba(0,0,0,0.65)`,
});

/** 依字數縮小字級，讓一行塞得下 1150px（中文約 1em／字，英數約 0.6em）。 */
const fit = (text: string, base: number, width = 1150) => {
  const units = [...text].reduce((n, ch) => n + (/[\u0000-ÿ]/.test(ch) ? 0.6 : 1), 0);
  return Math.min(base, Math.floor(width / Math.max(units, 1)));
};

const Field: React.FC<{seed: number}> = ({seed}) => {
  const r = rng(seed);
  const nodes = Array.from({length: 46}, () => ({x: 980 + r() * 940, y: 60 + r() * 960, s: 4 + r() * 10, c: r() < 0.65 ? P.ice : P.amber, o: 0.25 + r() * 0.6}));
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
      <defs>
        <radialGradient id="tg" cx="70%" cy="50%" r="55%">
          <stop offset="0%" stopColor={P.amber} stopOpacity={0.28} />
          <stop offset="100%" stopColor={P.amber} stopOpacity={0} />
        </radialGradient>
        <pattern id="td" width={40} height={40} patternUnits="userSpaceOnUse">
          <circle cx={2} cy={2} r={1.6} fill={P.line} />
        </pattern>
      </defs>
      <rect width={1920} height={1080} fill="url(#td)" opacity={0.6} />
      <rect width={1920} height={1080} fill="url(#tg)" />
      {/* 主體：發光的同心環＋鄰近資料點連線 */}
      {[300, 220, 140].map((r0, i) => (
        <circle key={`c${i}`} cx={1440} cy={540} r={r0} fill="none" stroke={i === 1 ? P.amber : P.ice} strokeOpacity={0.22 + i * 0.12} strokeWidth={i === 1 ? 6 : 3} strokeDasharray={i === 0 ? '4 14' : undefined} />
      ))}
      <circle cx={1440} cy={540} r={70} fill={P.amber} opacity={0.85} />
      <circle cx={1440} cy={540} r={110} fill={P.amber} opacity={0.12} />
      {nodes.map((n, i) => {
        let best = -1;
        let bd = 1e9;
        nodes.forEach((m, j) => {
          const d = (m.x - n.x) ** 2 + (m.y - n.y) ** 2;
          if (j !== i && d < bd) {
            bd = d;
            best = j;
          }
        });
        return best > i || bd > 160 ** 2 ? null : <line key={`l${i}`} x1={n.x} y1={n.y} x2={nodes[best].x} y2={nodes[best].y} stroke={P.ice} strokeOpacity={0.3} strokeWidth={2} />;
      })}
      {nodes.map((n, i) => (
        <rect key={i} x={n.x} y={n.y} width={n.s} height={n.s} fill={n.c} opacity={n.o} transform={`rotate(45 ${n.x + n.s / 2} ${n.y + n.s / 2})`} />
      ))}
    </svg>
  );
};

export const GenericThumbnail: React.FC<{epId: string}> = ({epId}) => {
  const seq = sequences[epId] ?? {};
  const t = seq.thumbnail ?? {};
  const lines = (t.lines?.filter(Boolean).length ? t.lines.filter(Boolean) : [seq.title ?? compPrefix(epId)]).slice(0, 3);
  const tags = (t.tags ?? []).slice(0, 5);
  const seed = [...epId].reduce((n, c) => n * 31 + c.charCodeAt(0), 7);
  return (
    <AbsoluteFill style={{background: `radial-gradient(ellipse 80% 90% at 70% 50%, ${P.wall} 0%, ${P.night} 55%, ${P.ink} 100%)`, fontFamily: fontStack, overflow: 'hidden'}}>
      <Field seed={seed} />
      <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(6,9,18,0.94) 0%, rgba(6,9,18,0.75) 45%, rgba(6,9,18,0) 75%)'}} />
      <div style={{position: 'absolute', inset: 0, boxShadow: 'inset 0 0 220px 40px rgba(0,0,0,0.7)'}} />
      <div style={{position: 'absolute', left: 92, top: 150, width: 1200}}>
        {lines.map((l, i) => (
          <div
            key={i}
            style={{fontSize: fit(l, 176), fontWeight: 900, color: i === lines.length - 1 && lines.length > 1 ? P.amber : '#FFFFFF', lineHeight: 1.08, whiteSpace: 'nowrap', ...stroke(11)}}
          >
            {l}
          </div>
        ))}
        {t.highlight ? (
          <div style={{display: 'inline-flex', marginTop: 34, background: '#FFD43B', padding: '14px 30px 16px', transform: 'rotate(-1.5deg)', boxShadow: '0 10px 30px rgba(0,0,0,0.55)'}}>
            <span style={{fontSize: fit(t.highlight, 70, 1000), fontWeight: 900, color: '#0B0E16', whiteSpace: 'nowrap'}}>{t.highlight}</span>
          </div>
        ) : null}
        {tags.length ? (
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 40, maxWidth: 1150}}>
            {tags.map((g) => (
              <div key={g} style={{fontSize: 40, fontWeight: 800, color: P.paper, padding: '6px 20px 8px', border: `3px solid ${P.ice}`, background: 'rgba(9,13,24,0.7)', whiteSpace: 'nowrap'}}>
                {g}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div style={{position: 'absolute', right: 64, bottom: 54, display: 'flex', alignItems: 'center', gap: 6}}>
        <div style={{width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <div style={{transform: 'scale(0.4)'}}>
            <PikaraMark t={1} />
          </div>
        </div>
        <div style={{fontSize: 32, color: P.paper, letterSpacing: '0.24em', fontWeight: 800, ...stroke(4)}}>PIKARA SCIENCE</div>
      </div>
      <div style={{position: 'absolute', right: 64, top: 52, fontSize: 64, fontWeight: 900, color: '#0B0E16', background: P.amber, padding: '4px 22px 8px', letterSpacing: '0.06em'}}>{compPrefix(epId)}</div>
    </AbsoluteFill>
  );
};
