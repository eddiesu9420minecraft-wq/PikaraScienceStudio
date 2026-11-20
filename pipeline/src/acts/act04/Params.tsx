import React from 'react';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {A, an, MONO, P, Txt, fontStack} from './common';

/**
 * 站點 4：量化不是刪參數。參數數量固定 8,000,000,000；只有每個數字的位元數（精細程度）從 16 → 4。
 * 每根柱子代表「一個數字」，柱內細線代表位元。
 */
const COLS = 28;
const ROWS = 3;
const PITCH = 46;
const BW = 34;
const UNIT = 6; // 每位元高度
const X0 = 960 - (COLS * PITCH - (PITCH - BW)) / 2;
const ROW_Y = [470, 610, 750]; // 每列底線

export const Params: React.FC<{f: number; anchors: A}> = ({f, anchors}) => {
  const notdelete = an(anchors, 'notdelete', 3651);
  const same = an(anchors, 'same', 3790);
  const q4km = an(anchors, 'q4km', 4144);

  const tIn = progress(f, notdelete - 40, notdelete + 30);
  const shrink = ease.inOut(progress(f, same - 50, same + 10));
  const lock = ease.out(progress(f, same - 6, same + 30));
  const out = 1 - progress(f, q4km - 80, q4km - 40);
  const bits = lerp(16, 4, shrink);
  const ctrO = progress(f, notdelete - 30, notdelete + 10);

  const bars: React.ReactNode[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const k = ease.out(clamp(tIn * 2.2 - (c + r * 3) / COLS));
      if (k <= 0) continue;
      const x = X0 + c * PITCH;
      const base = ROW_Y[r];
      // 各根柱子收縮時間略錯開，像一陣波
      const sh = ease.inOut(clamp(progress(f, same - 60 + c * 1.2 + r * 4, same + c * 1.2 + r * 4)));
      const b = lerp(16, 4, sh);
      const h = b * UNIT * k;
      const stripes: React.ReactNode[] = [];
      const nb = Math.ceil(b);
      for (let s = 1; s < nb; s++) {
        stripes.push(<line key={s} x1={x + 3} x2={x + BW - 3} y1={base - s * UNIT} y2={base - s * UNIT} stroke={P.ink} strokeOpacity={0.45} strokeWidth={1} />);
      }
      bars.push(
        <g key={i} opacity={k}>
          <rect x={x} y={base - h} width={BW} height={h} rx={2} fill={P.amber} fillOpacity={0.88} />
          {k > 0.95 ? stripes : null}
          {/* 原本 16 位元高度的殘影框 */}
          {sh > 0.02 ? <rect x={x} y={base - 16 * UNIT} width={BW} height={16 * UNIT} rx={2} fill="none" stroke={P.amber} strokeOpacity={0.25 * sh} strokeDasharray="3 4" /> : null}
        </g>,
      );
    }
  }

  return (
    <div style={{position: 'absolute', inset: 0, opacity: out}}>
      {/* 計數器 */}
      <div style={{position: 'absolute', left: 0, width: 1920, top: 96, textAlign: 'center', opacity: ctrO, fontFamily: fontStack}}>
        <span style={{fontFamily: MONO, fontSize: 88, fontWeight: 700, color: P.amber, letterSpacing: '0.02em'}}>8,000,000,000</span>
        <span style={{fontSize: 34, color: P.paper, fontWeight: 600, marginLeft: 20}}>個參數</span>
      </div>
      <div style={{position: 'absolute', left: 0, width: 1920, top: 210, textAlign: 'center', fontFamily: fontStack, opacity: ctrO}}>
        <span style={{fontSize: 24, color: P.mist, letterSpacing: '0.08em'}}>
          量化前
          <span style={{fontFamily: MONO, color: P.paper, margin: '0 14px'}}>8,000,000,000</span>
          {'　'}量化後
          <span style={{fontFamily: MONO, color: P.paper, margin: '0 14px', opacity: lerp(0.35, 1, lock)}}>8,000,000,000</span>
        </span>
        <span
          style={{
            display: 'inline-block',
            marginLeft: 18,
            fontSize: 24,
            fontWeight: 700,
            color: P.mint,
            opacity: lock,
            transform: `scale(${lerp(0.6, 1, lock)})`,
            letterSpacing: '0.08em',
          }}
        >
          ＝ 數量完全一樣
        </span>
      </div>

      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        {ROW_Y.map((y, r) => (
          <line key={r} x1={X0 - 10} x2={X0 + COLS * PITCH} y1={y + 1} y2={y + 1} stroke={P.line} strokeWidth={1.2} opacity={tIn} />
        ))}
      </svg>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        {bars}
      </svg>
      <Txt x={X0 + COLS * PITCH - 10} y={300} align="right" size={26} weight={700} t={tIn} color={P.paper}>
        每個數字 <span style={{fontFamily: MONO, color: P.amber, display: 'inline-block', minWidth: 44, textAlign: 'right'}}>{Math.round(bits)}</span> 位元
        <span style={{color: P.mist, fontWeight: 500, fontSize: 21, marginLeft: 14}}>{shrink > 0.5 ? '變少的是精細程度' : '示意：一根柱子＝一個數字'}</span>
      </Txt>
    </div>
  );
};
