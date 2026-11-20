import React from 'react';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {A, an, env, MONO, P, Txt, fontStack} from './common';

/**
 * 站點 3：量化機制（對稱量化，示意）。
 *   一組 8 個權重 → s = max|w| ÷ qmax → q = round(w ÷ s) → 還原 w' = q × s
 * 然後比較 INT8（qmax 127）與 4 位元（qmax 7）。所有數字皆由下列資料實際計算。
 */
export const W = [0.42, -0.81, 0.17, 0.66, -0.29, 0.93, -0.55, 0.06];
const AMAX = Math.max(...W.map(Math.abs));
export const quantize = (qmax: number) => {
  const s = AMAX / qmax;
  const q = W.map((v) => Math.round(v / s));
  const r = q.map((v) => v * s);
  const err = Math.max(...W.map((v, i) => Math.abs(v - r[i])));
  return {s, q, r, err};
};
const Q4 = quantize(7);
const Q8 = quantize(127);
const sgn = (v: number) => (v < 0 ? '−' : '') + Math.abs(v);
const fmt = (v: number, d = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

type PlotProps = {
  x: number;
  w: number;
  y0: number;
  hs: number;
  qmax: number;
  tDots: number;
  tGroup?: number;
  tScale?: number;
  tSnap?: number;
  tInts?: number;
  tRestore?: number;
  tErr?: number;
  tLabels?: number;
  o?: number;
};

const QuantPlot: React.FC<PlotProps> = ({x, w, y0, hs, qmax, tDots, tGroup = 0, tScale = 0, tSnap = 0, tInts = 0, tRestore = 0, tErr = 0, tLabels = 1, o = 1}) => {
  if (o <= 0.001) return null;
  const Q = qmax === 7 ? Q4 : quantize(qmax);
  const n = W.length;
  const pitch = w / n;
  const xs = W.map((_, i) => x + (i + 0.5) * pitch);
  const yOrig = W.map((v) => y0 - v * hs);
  const yQ = Q.r.map((v) => y0 - v * hs);
  const dense = qmax > 20;
  const imax = W.findIndex((v) => Math.abs(v) === AMAX);
  const top = y0 - AMAX * hs;
  const bot = y0 + AMAX * hs;

  const grid: React.ReactNode[] = [];
  if (tScale > 0) {
    for (let k = -qmax; k <= qmax; k++) {
      const gk = dense ? clamp(tScale * 1.2 - (Math.abs(k) / qmax) * 0.2) : clamp(tScale * (qmax + 2) - Math.abs(k));
      if (gk <= 0) continue;
      const yy = y0 - k * Q.s * hs;
      grid.push(
        <line
          key={k}
          x1={x - 10}
          x2={lerp(x - 10, x + w, ease.out(gk))}
          y1={yy}
          y2={yy}
          stroke={k === 0 ? P.mist : P.ice}
          strokeOpacity={k === 0 ? 0.6 : dense ? 0.22 : 0.32}
          strokeWidth={dense ? 0.6 : 1.2}
        />,
      );
      if (!dense) {
        grid.push(
          <text key={`t${k}`} x={x - 24} y={yy + 7} textAnchor="end" fontFamily={MONO} fontSize={19} fill={P.ice} opacity={gk * 0.85}>
            {sgn(k)}
          </text>,
        );
      }
    }
    if (dense) {
      for (const k of [-127, 0, 127]) {
        const yy = y0 - k * Q.s * hs;
        grid.push(
          <text key={`d${k}`} x={x - 22} y={yy + 7} textAnchor="end" fontFamily={MONO} fontSize={19} fill={P.ice} opacity={clamp(tScale) * 0.85}>
            {sgn(k)}
          </text>,
        );
      }
    }
  }

  return (
    <g opacity={o}>
      <line x1={x - 10} x2={lerp(x - 10, x + w, ease.out(tDots))} y1={y0} y2={y0} stroke={P.mist} strokeOpacity={0.55} strokeWidth={1.2} />
      {grid}

      {tGroup > 0 ? (
        <g opacity={ease.out(tGroup)}>
          <path
            d={`M ${x} ${top - 58} l 0 -12 L ${x + w} ${top - 70} l 0 12`}
            fill="none"
            stroke={P.amber}
            strokeWidth={1.6}
            strokeDasharray={`${w * ease.out(tGroup) + 30} 4000`}
          />
          <text x={x + w / 2} y={top - 86} textAnchor="middle" fontFamily={fontStack} fontSize={26} fontWeight={700} fill={P.amber} letterSpacing="0.06em">
            一組
            <tspan fill={P.mist} fontSize={21} fontWeight={500}>
              {'  '}示意：8 個；實際 Q8_0 每組 32 個
            </tspan>
          </text>
        </g>
      ) : null}

      {tScale > 0 && !dense ? (
        <g opacity={ease.out(clamp(tScale * 3)) * (1 - clamp(tSnap * 2))}>
          <line x1={xs[imax] + 34} x2={xs[imax] + 34} y1={y0} y2={lerp(y0, top, ease.out(clamp(tScale * 3)))} stroke={P.amber} strokeWidth={1.6} />
          <line x1={xs[imax] + 26} x2={xs[imax] + 42} y1={top} y2={top} stroke={P.amber} strokeWidth={1.6} />
          <line x1={xs[imax] + 26} x2={xs[imax] + 42} y1={y0} y2={y0} stroke={P.amber} strokeWidth={1.6} />
          <text x={xs[imax] + 48} y={(y0 + top) / 2 + 8} fontFamily={MONO} fontSize={21} fill={P.amber}>
            max|w|
          </text>
        </g>
      ) : null}

      {W.map((v, i) => {
        const k = ease.out(clamp(tDots * 1.6 - i * 0.08));
        if (k <= 0) return null;
        const snap = ease.out(clamp(tSnap * 1.4 - i * 0.05));
        const yy = lerp(yOrig[i], yQ[i], snap);
        const col = v >= 0 ? P.amber : P.ice;
        const up = v >= 0;
        const ly = up ? Math.min(yy, yOrig[i]) - 24 : Math.max(yy, yOrig[i]) + 40;
        const errLen = Math.abs(yOrig[i] - yQ[i]);
        const labO = tLabels * k;
        const lInt = clamp(tInts * 2 - 0.5);
        const lRes = clamp(tRestore * 2);
        const showErr = tRestore > 0 && errLen > 0.4;
        return (
          <g key={i}>
            <line x1={xs[i]} x2={xs[i]} y1={y0} y2={lerp(y0, yy, k)} stroke={col} strokeOpacity={0.45} strokeWidth={2} />
            {snap > 0.01 ? <circle cx={xs[i]} cy={yOrig[i]} r={10} fill="none" stroke={P.paper} strokeOpacity={0.55 * snap} strokeWidth={1.6} strokeDasharray="3 3" /> : null}
            {showErr ? (
              <g opacity={ease.out(tRestore)}>
                <line x1={xs[i] + 18} x2={xs[i] + 18} y1={yOrig[i]} y2={yQ[i]} stroke={P.paper} strokeOpacity={0.85} strokeWidth={1.5 + tErr * 1.5} />
                <line x1={xs[i] + 12} x2={xs[i] + 24} y1={yOrig[i]} y2={yOrig[i]} stroke={P.paper} strokeOpacity={0.85} strokeWidth={1.4} />
                <line x1={xs[i] + 12} x2={xs[i] + 24} y1={yQ[i]} y2={yQ[i]} stroke={P.paper} strokeOpacity={0.85} strokeWidth={1.4} />
              </g>
            ) : null}
            {tErr > 0 && errLen > 4 ? (
              <circle cx={xs[i] + 4} cy={(yOrig[i] + yQ[i]) / 2} r={(errLen / 2 + 20) * (0.85 + 0.15 * tErr)} fill="none" stroke={P.amber} strokeOpacity={0.55 * tErr} strokeWidth={1.4} />
            ) : null}
            <circle cx={xs[i]} cy={yy} r={11 * k} fill={col} />
            <circle cx={xs[i]} cy={yy} r={18 * k} fill={col} opacity={0.14} />
            {labO > 0.01 ? (
              <g opacity={labO}>
                <text x={xs[i]} y={ly} textAnchor="middle" fontFamily={MONO} fontSize={23} fill={P.paper} opacity={(1 - lInt) * (1 - lRes)}>
                  {fmt(v)}
                </text>
                <text x={xs[i]} y={ly} textAnchor="middle" fontFamily={MONO} fontSize={28} fontWeight={700} fill={col} opacity={lInt * (1 - lRes)}>
                  {sgn(Q.q[i])}
                </text>
                <text x={xs[i]} y={ly} textAnchor="middle" fontFamily={MONO} fontSize={23} fill={P.paper} opacity={lRes}>
                  {fmt(Q.r[i], 3)}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
      <line x1={x - 10} x2={x - 10} y1={top - 10} y2={bot + 10} stroke={P.line} strokeWidth={1} opacity={ease.out(tDots)} />
    </g>
  );
};

const BitBar: React.FC<{x: number; y: number; bits: number; t: number; label: string; sub: string}> = ({x, y, bits, t, label, sub}) => {
  if (t <= 0.001) return null;
  const cw = 30;
  const gap = 5;
  return (
    <g opacity={ease.out(t)}>
      {Array.from({length: 16}).map((_, i) => (
        <rect key={`g${i}`} x={x + i * (cw + gap)} y={y} width={cw} height={34} rx={3} fill="none" stroke={P.mist} strokeOpacity={0.35} strokeDasharray="3 4" />
      ))}
      {Array.from({length: bits}).map((_, i) => {
        const k = ease.out(clamp(t * 2 - i * 0.08));
        return <rect key={i} x={x + i * (cw + gap)} y={y + (1 - k) * 10} width={cw} height={34} rx={3} fill={P.amber} opacity={k} />;
      })}
      <text x={x} y={y - 18} fontFamily={fontStack} fontSize={24} fontWeight={700} fill={P.paper}>
        {label}
        <tspan fill={P.mist} fontSize={20} fontWeight={500}>
          {'   '}
          {sub}
        </tspan>
      </text>
      <text x={x + 16 * (cw + gap) + 6} y={y + 25} fontFamily={fontStack} fontSize={19} fill={P.mist}>
        FP16
      </text>
    </g>
  );
};

export const Quant: React.FC<{f: number; anchors: A}> = ({f, anchors}) => {
  const approx = an(anchors, 'approx', 1974);
  const group = an(anchors, 'group', 2195);
  const scale = an(anchors, 'scale', 2345);
  const ints = an(anchors, 'ints', 2588);
  const restore = an(anchors, 'restore', 2831);
  const int8 = an(anchors, 'int8', 3121);
  const q4 = an(anchors, 'q4', 3213);
  const error = an(anchors, 'error', 3455);
  const notdelete = an(anchors, 'notdelete', 3651);

  const tDots = progress(f, approx - 70, approx + 10);
  const tGroup = progress(f, group - 14, group + 26);
  const tScale = progress(f, scale - 6, scale + 70);
  const tSnap = progress(f, ints - 24, ints + 20);
  const tInts = progress(f, ints - 10, ints + 20);
  const tRestore = progress(f, restore - 10, restore + 34);

  // 版面切換：機制 → 並排比較
  const lay = ease.camera(progress(f, int8 - 50, int8 + 6));
  const plot4 = {x: lerp(250, 1040, lay), w: lerp(960, 720, lay), y0: lerp(500, 440, lay), hs: lerp(275, 190, lay)};
  const plot8 = {x: 200, w: 720, y0: 440, hs: 190};
  const t8 = progress(f, int8 - 20, int8 + 30);
  const tErr = ease.out(progress(f, error - 10, error + 26));
  const panelO = 1 - lay;
  const tHead4 = progress(f, q4 - 12, q4 + 18);
  const out = 1 - progress(f, notdelete - 70, notdelete - 30);

  const RX = 1330;
  const rl = (a: number) => progress(f, a, a + 26) * panelO;

  return (
    <div style={{position: 'absolute', inset: 0, opacity: out}}>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <QuantPlot {...plot8} qmax={127} tDots={t8} tScale={t8} tSnap={t8} tRestore={t8} tInts={0} tLabels={0} tErr={tErr} o={ease.out(t8)} />
        <QuantPlot
          {...plot4}
          qmax={7}
          tDots={tDots}
          tGroup={tGroup * (1 - lay)}
          tScale={tScale}
          tSnap={tSnap}
          tInts={tInts}
          tRestore={tRestore}
          tErr={tErr}
          tLabels={1 - lay}
        />
        <BitBar x={plot8.x} y={725} bits={8} t={progress(f, int8 + 10, int8 + 50)} label="INT8" sub="每個數字 8 位元" />
        <BitBar x={1040} y={725} bits={4} t={progress(f, q4 + 10, q4 + 50)} label="4 位元" sub="約 FP16 的 ¼" />
      </svg>

      <Txt x={plot8.x - 10} y={176} size={40} weight={800} t={t8} color={P.paper}>
        INT8 <span style={{fontSize: 22, color: P.mist, fontWeight: 500, marginLeft: 12}}>整數 −127 … 127，刻度很細</span>
      </Txt>
      <Txt x={1030} y={176} size={40} weight={800} t={tHead4 * lay} color={P.paper}>
        4 位元 <span style={{fontSize: 22, color: P.mist, fontWeight: 500, marginLeft: 12}}>整數 −7 … 7，刻度很粗</span>
      </Txt>
      <Txt x={plot8.x - 10} y={830} size={24} weight={600} t={tErr} color={P.paper}>
        最大誤差 ≈ <span style={{fontFamily: MONO, color: P.amber}}>{Q8.err.toFixed(3)}</span>
      </Txt>
      <Txt x={1030} y={830} size={24} weight={600} t={tErr} color={P.paper}>
        最大誤差 ≈ <span style={{fontFamily: MONO, color: P.amber}}>{Q4.err.toFixed(2)}</span>
        <span style={{color: P.mist, fontSize: 20, fontWeight: 500, marginLeft: 14}}>（同一組示意數據）</span>
      </Txt>

      <Txt x={RX} y={380} size={30} weight={700} color={P.amber} t={rl(scale)}>
        縮放係數 s ＝ max|w| ÷ 7
      </Txt>
      <Txt x={RX} y={424} size={24} mono color={P.paper} t={rl(scale + 30)}>
        ＝ {AMAX.toFixed(2)} ÷ 7 ≈ {Q4.s.toFixed(3)}
      </Txt>
      <Txt x={RX} y={512} size={30} weight={700} color={P.amber} t={rl(ints - 6)}>
        整數 q ＝ round(w ÷ s)
      </Txt>
      {rl(ints + 20) > 0 ? (
        <div style={{position: 'absolute', left: RX, top: 546, opacity: rl(ints + 20), display: 'flex', gap: 6, alignItems: 'center'}}>
          {Q4.q.map((v, i) => (
            <div
              key={i}
              style={{
                width: 44,
                height: 44,
                border: `1.5px solid ${W[i] >= 0 ? P.amber : P.ice}`,
                borderRadius: 4,
                color: W[i] >= 0 ? P.amber : P.ice,
                fontFamily: MONO,
                fontSize: 21,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: clamp((f - ints - 20 - i * 3) / 10),
              }}
            >
              {sgn(v)}
            </div>
          ))}
          <div
            style={{
              marginLeft: 10,
              fontFamily: MONO,
              fontSize: 21,
              color: P.paper,
              border: `1.5px solid ${P.paper}`,
              borderRadius: 4,
              padding: '7px 8px',
              opacity: clamp((f - ints - 50) / 12),
            }}
          >
            s
          </div>
        </div>
      ) : null}
      <Txt x={RX} y={630} size={20} color={P.mist} t={rl(ints + 50)}>
        每組只存：小整數 ＋ 一個 s
      </Txt>
      <Txt x={RX} y={714} size={30} weight={700} color={P.paper} t={rl(restore - 6)}>
        還原 w ≈ q × s
      </Txt>
      <Txt x={RX} y={758} size={23} mono color={P.paper} t={rl(restore + 30)}>
        3 × {Q4.s.toFixed(3)} ≈ {Q4.r[0].toFixed(3)} <span style={{color: P.mist}}>（原 0.42）</span>
      </Txt>
    </div>
  );
};

export const quantSchematic = (f: number, anchors: A) => {
  const approx = an(anchors, 'approx', 1974);
  const notdelete = an(anchors, 'notdelete', 3651);
  return env(f, approx - 60, approx - 20, notdelete - 70, notdelete - 30);
};
