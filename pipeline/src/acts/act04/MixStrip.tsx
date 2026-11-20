import React from 'react';
import {clamp, ease, lerp, progress, wobble} from '../../lib/anim';
import {A, an, MONO, P, Txt, fontStack} from './common';

/**
 * 站點 5：Q4_K_M 混合精度（示意）。每一格是一個張量；高度 ∝ 每權重位元數
 *   Q4_K ≈ 4.5 位元/權重、Q6_K ≈ 6.56 位元/權重（Hugging Face GGUF 文件）。
 * 哪些張量保留較高精度只是示意排列，不代表實際比例。
 */
const ROWS = ['attn_q', 'attn_k', 'attn_v', 'attn_output', 'ffn_gate', 'ffn_up', 'ffn_down'];
const NL = 14; // 畫出的層數（中間以 … 表示省略）
const PITCH_X = 72;
const BW = 58;
const PITCH_Y = 70;
const Y0 = 250; // 第一列頂端
const X0 = 420;
const H4 = 4.5 * 7.2;
const H6 = 6.5625 * 7.2;

export const MIX_GEOM = {X0, PITCH_X, NL, Y0, PITCH_Y, rows: ROWS.length};

// 示意：attn_v、ffn_down 的部分層保留較高精度
export const isSensitive = (row: string, layer: number) => (row === 'attn_v' || row === 'ffn_down') && layer % 2 === 0;

export const MixStrip: React.FC<{f: number; anchors: A}> = ({f, anchors}) => {
  const q4km = an(anchors, 'q4km', 4144);
  const sensitive = an(anchors, 'sensitive', 4316);
  const formula = an(anchors, 'formula', 4730);

  const tIn = progress(f, q4km - 70, q4km + 20);
  const tSens = ease.out(progress(f, sensitive - 16, sensitive + 30));
  const tLegend = progress(f, sensitive + 30, sensitive + 70);
  const out = 1 - progress(f, formula - 80, formula - 40);
  const colX = (l: number) => X0 + 110 + l * PITCH_X + (l >= NL - 2 ? 60 : 0);

  const cells: React.ReactNode[] = [];
  ROWS.forEach((row, r) => {
    for (let l = 0; l < NL; l++) {
      const k = ease.out(clamp(tIn * 2.4 - (l / NL) * 1.2 - r * 0.04));
      if (k <= 0) continue;
      const sens = isSensitive(row, l);
      const s = sens ? tSens : 0;
      const h = lerp(H4, H6, s) * k;
      const x = colX(l);
      const base = Y0 + r * PITCH_Y + H6;
      const glow = s * (0.75 + 0.25 * wobble(f, 70, l * 0.13));
      cells.push(
        <g key={`${r}-${l}`} opacity={k}>
          <rect x={x} y={base - h} width={BW} height={h} rx={3} fill={sens ? lerp01Color(s) : P.amberDeep} fillOpacity={sens ? 0.9 : 0.62} />
          {sens && s > 0.01 ? <rect x={x - 3} y={base - h - 3} width={BW + 6} height={h + 6} rx={5} fill="none" stroke={P.mint} strokeWidth={2} opacity={glow} /> : null}
        </g>,
      );
    }
  });
  // token_embd 與 output
  const extra = (label: string, x: number, sens: boolean) => {
    const k = ease.out(clamp(tIn * 2 - 0.2));
    const s = sens ? tSens : 0;
    const h = (ROWS.length * PITCH_Y - (PITCH_Y - H6)) * k;
    return (
      <g opacity={k}>
        <rect x={x} y={Y0} width={60} height={h} rx={4} fill={sens ? lerp01Color(s) : P.amberDeep} fillOpacity={sens ? 0.85 : 0.6} />
        {s > 0 ? <rect x={x - 3} y={Y0 - 3} width={66} height={h + 6} rx={6} fill="none" stroke={P.mint} strokeWidth={2} opacity={s} /> : null}
        <text x={x + 30} y={Y0 + h + 34} textAnchor="middle" fontFamily={MONO} fontSize={19} fill={P.mist}>
          {label}
        </text>
      </g>
    );
  };

  const lastX = colX(NL - 1) + BW;
  return (
    <div style={{position: 'absolute', inset: 0, opacity: out}}>
      <Txt x={X0 - 230} y={150} size={44} weight={800} t={tIn} color={P.paper}>
        Q4_K_M <span style={{fontSize: 26, color: P.mist, fontWeight: 500, marginLeft: 14}}>混合精度（示意）</span>
      </Txt>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        {ROWS.map((row, r) => (
          <text key={row} x={X0 + 90} y={Y0 + r * PITCH_Y + H6 - 10} textAnchor="end" fontFamily={MONO} fontSize={20} fill={P.mist} opacity={tIn}>
            {row}
          </text>
        ))}
        {Array.from({length: NL}).map((_, l) => (
          <text key={l} x={colX(l) + BW / 2} y={Y0 - 16} textAnchor="middle" fontFamily={MONO} fontSize={18} fill={P.mist} opacity={tIn * 0.8}>
            {l < NL - 2 ? `blk.${l}` : l === NL - 2 ? 'blk.30' : 'blk.31'}
          </text>
        ))}
        <text x={colX(NL - 2) - 40} y={Y0 + (ROWS.length * PITCH_Y) / 2} textAnchor="middle" fontFamily={MONO} fontSize={30} fill={P.mist} opacity={tIn}>
          …
        </text>
        {extra('token_embd', X0 - 230 + 60, false)}
        {extra('output', lastX + 40, true)}
        {cells}
      </svg>
      {/* 圖例 */}
      <div style={{position: 'absolute', left: X0 - 170, top: 790, display: 'flex', gap: 60, alignItems: 'center', fontFamily: fontStack, opacity: tLegend}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
          <div style={{width: 40, height: 22, borderRadius: 3, background: P.amberDeep, opacity: 0.75}} />
          <span style={{fontSize: 24, color: P.paper, fontWeight: 600}}>大部分：約 4 位元</span>
          <span style={{fontSize: 20, color: P.mist}}>Q4_K ≈ 4.5 位元/權重</span>
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
          <div style={{width: 40, height: 30, borderRadius: 3, background: P.amber, outline: `2px solid ${P.mint}`, outlineOffset: 2}} />
          <span style={{fontSize: 24, color: P.paper, fontWeight: 600}}>較敏感：保留更多位元</span>
          <span style={{fontSize: 20, color: P.mist}}>例如 Q6_K ≈ 6.56 位元/權重</span>
        </div>
      </div>
    </div>
  );
};

const lerp01Color = (s: number) => (s > 0.5 ? P.amber : P.amberDeep);
