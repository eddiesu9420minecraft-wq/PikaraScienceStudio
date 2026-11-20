import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {ease, keyframes, lerp, progress} from '../../lib/anim';
import {Anchors, mix, vis} from './common';
import {CANDS, pick, softmax} from './data';
import {genTimes} from './genTimes';

export const CH = {x: 960, label: 935, y0: 352, dy: 62, maxW: 540, stripY: 778};

export const tempAt = (A: Anchors, f: number) => {
  const T = genTimes(A);
  return keyframes(f, [
    {f: T.sample, v: 1.0},
    {f: T.lowT - 24, v: 1.0},
    {f: T.lowT + 30, v: 0.3, ease: ease.inOut},
    {f: T.highT - 24, v: 0.3},
    {f: T.highT + 36, v: 2.0, ease: ease.inOut},
    {f: T.append - 130, v: 2.0},
    {f: T.append - 90, v: 1.0, ease: ease.inOut},
  ]);
};

/** 取樣事件（u 為 0..1 的固定亂數；落點 = 累積機率中 u 所在的候選）。 */
export const drawsOf = (A: Anchors) => {
  const T = genTimes(A);
  return [
    {t: T.sample + 76, u: 0.3},
    {t: T.lowT + 66, u: 0.3},
    {t: T.highT + 76, u: 0.62},
    {t: T.highT + 146, u: 0.8},
    {t: T.highT + 216, u: 0.93},
    {t: T.append - 84, u: 0.3},
    {t: T.iter(1) + 32, u: 0.2},
    {t: T.iter(2) + 32, u: 0.2},
    {t: T.iter(3) + 32, u: 0.2},
  ];
};

/** 目前顯示哪一組候選，以及切換進度。 */
export const candAt = (A: Anchors, f: number) => {
  const T = genTimes(A);
  let set = 0;
  let sw = 1;
  for (let k = 1; k <= 3; k++) {
    if (f >= T.iter(k) + 6) {
      set = k;
      sw = progress(f, T.iter(k) + 6, T.iter(k) + 26);
    }
  }
  return {set, sw};
};

export const GenChart: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = genTimes(A);
  const chartO = vis(f, T.logits - 50, T.logits - 10, T.moveA - 40, T.moveA + 10);
  if (chartO <= 0) return null;
  const temp = tempAt(A, f);
  const {set, sw} = candAt(A, f);
  const cands = CANDS[set];
  const ls = cands.map((c) => c.l);
  const ps = softmax(ls, temp);
  const m = ease.inOut(progress(f, T.sample + 4, T.sample + 44));
  const scoreHl = progress(f, T.score - 12, T.score + 16) * (1 - m);

  // 目前的取樣
  const draws = drawsOf(A);
  let cur: {t: number; u: number} | null = null;
  for (const d of draws) if (f >= d.t) cur = d;
  if (cur && f > cur.t + 120 && cur !== draws[5] && cur !== draws[8]) cur = null;
  const curAge = cur ? f - cur.t : 0;
  const landed = cur ? progress(curAge, 10, 16) : 0;
  const chosen = cur && landed > 0 ? pick(ps, cur.u) : -1;
  // 已被取走（飛到序列）的那個
  const flying = (k: number) => (k === 0 ? progress(f, T.append - 30, T.append - 26) : progress(f, T.iter(k) + 42, T.iter(k) + 46));
  const takenNow = set === 0 ? flying(0) : flying(set);

  const stripO = vis(f, T.sample + 30, T.sample + 60, T.moveA - 40, T.moveA + 10);
  const sliderO = vis(f, T.sample + 20, T.sample + 50, T.loop - 80, T.loop - 40);

  return (
    <div style={{position: 'absolute', inset: 0, opacity: chartO}}>
      {/* 標題 */}
      <div style={{position: 'absolute', left: CH.x, top: CH.y0 - 82, whiteSpace: 'nowrap'}}>
        <span style={{...type.title, fontSize: 32, color: P.paper, opacity: 1 - m}}>logits</span>
        <span style={{...type.label, fontSize: 22, color: P.mist, marginLeft: 14, opacity: 1 - m}}>每個 token 的分數</span>
      </div>
      <div style={{position: 'absolute', left: CH.x, top: CH.y0 - 82, whiteSpace: 'nowrap', opacity: m}}>
        <span style={{...type.title, fontSize: 32, color: P.paper}}>機率</span>
        <span style={{...type.mono, fontSize: 22, color: P.mist, marginLeft: 14}}>softmax(logits ÷ T)</span>
      </div>

      {cands.map((c, i) => {
        const g = ease.out(progress(f, T.logits + i * 6, T.logits + 40 + i * 6));
        const wL = (c.l / 5) * CH.maxW;
        const wP = ps[i] * CH.maxW;
        const w = lerp(wL, wP, m) * g;
        const y = CH.y0 + i * CH.dy;
        const isChosen = i === chosen;
        const top = i === 0;
        const barCol = scoreHl > 0 ? mix(P.ice, P.amber, top ? scoreHl : 0) : m > 0 ? (isChosen ? P.amber : mix(P.iceDeep, P.ice, 0.4)) : P.ice;
        const labelO = sw * (isChosen && takenNow > 0 ? 0.25 : 1);
        return (
          <React.Fragment key={`${set}-${i}`}>
            <div
              style={{
                position: 'absolute',
                left: CH.label - 200,
                width: 200,
                top: y - 22,
                textAlign: 'right',
                ...type.title,
                fontSize: 34,
                lineHeight: '44px',
                color: isChosen ? P.amber : P.paper,
                opacity: labelO,
              }}
            >
              {c.t}
            </div>
            <div style={{position: 'absolute', left: CH.x, top: y - 15, width: Math.max(0, w), height: 30, borderRadius: 4, background: barCol, opacity: sw * (0.55 + 0.45 * (isChosen || (top && scoreHl > 0) ? 1 : 0.6))}} />
            <div style={{position: 'absolute', left: CH.x + w + 14, top: y - 16, ...type.mono, fontSize: 24, color: P.mist, opacity: sw * g, whiteSpace: 'nowrap'}}>
              {m < 0.5 ? c.l.toFixed(1) : ps[i] < 0.001 ? '<0.1%' : `${(ps[i] * 100).toFixed(ps[i] < 0.1 ? 1 : 0)}%`}
            </div>
          </React.Fragment>
        );
      })}
      <div style={{position: 'absolute', left: CH.x, top: CH.y0 + 6 * CH.dy - 22, ...type.label, fontSize: 20, color: P.mist, opacity: progress(f, T.logits + 40, T.logits + 70)}}>
        ⋯ 詞彙表裡其他 token（分數很低，省略）
      </div>

      {/* 取樣條：長度 = 機率，落點決定選中誰 */}
      {stripO > 0 ? (
        <div style={{position: 'absolute', left: CH.x, top: CH.stripY - 16, width: CH.maxW, height: 32, opacity: stripO * sw}}>
          {(() => {
            let acc = 0;
            return ps.map((p, i) => {
              const x0 = acc * CH.maxW;
              acc += p;
              const w = p * CH.maxW;
              const col = i === 0 ? P.amber : i % 2 ? P.iceDeep : P.ice;
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: x0,
                    top: 0,
                    width: Math.max(0, w - 2),
                    height: 32,
                    background: col,
                    opacity: i === chosen ? 1 : 0.8,
                    borderRadius: 3,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    ...type.title,
                    fontSize: 18,
                    color: P.ink,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {w > 44 ? cands[i].t : ''}
                </div>
              );
            });
          })()}
        </div>
      ) : null}
      {stripO > 0 ? (
        <div style={{position: 'absolute', left: CH.x - 150, width: 136, top: CH.stripY - 15, textAlign: 'right', ...type.label, fontSize: 22, color: P.mist, opacity: stripO}}>
          取樣
        </div>
      ) : null}
      {cur && stripO > 0
        ? (() => {
            const x = CH.x + cur.u * CH.maxW;
            const drop = ease.in(progress(curAge, 0, 12));
            const y = lerp(CH.stripY - 70, CH.stripY - 22, drop);
            const o = progress(curAge, 0, 4) * stripO;
            return (
              <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: o}}>
                <path d={`M ${x - 11} ${y - 18} L ${x + 11} ${y - 18} L ${x} ${y} Z`} fill={P.paper} />
                {landed > 0 ? <line x1={x} y1={CH.stripY - 18} x2={x} y2={CH.stripY + 18} stroke={P.paper} strokeWidth={3} opacity={landed} /> : null}
              </svg>
            );
          })()
        : null}
      {cur && chosen >= 0 && stripO > 0 ? (
        <div style={{position: 'absolute', left: CH.x + CH.maxW + 26, top: CH.stripY - 22, ...type.title, fontSize: 32, color: P.amber, opacity: landed * stripO, whiteSpace: 'nowrap'}}>
          → {cands[chosen].t}
        </div>
      ) : null}

      {/* Temperature 滑桿 */}
      {sliderO > 0 ? (
        <div style={{position: 'absolute', inset: 0, opacity: sliderO}}>
          <div style={{position: 'absolute', left: 1180, width: 190, top: 222, textAlign: 'right', ...type.label, fontSize: 22, color: P.mist}}>Temperature</div>
          <div style={{position: 'absolute', left: 1390, top: 236, width: 250, height: 3, borderRadius: 2, background: P.line}} />
          <div style={{position: 'absolute', left: 1390, top: 236, width: ((temp - 0.2) / 2.0) * 250, height: 3, borderRadius: 2, background: P.amber}} />
          <div
            style={{
              position: 'absolute',
              left: 1390 + ((temp - 0.2) / 2.0) * 250 - 11,
              top: 226,
              width: 22,
              height: 22,
              borderRadius: 11,
              background: P.paper,
              boxShadow: `0 0 0 4px ${P.ink}, 0 0 0 5.5px ${P.amber}`,
            }}
          />
          <div style={{position: 'absolute', left: 1660, top: 220, ...type.mono, fontSize: 26, color: P.paper, whiteSpace: 'nowrap'}}>T={temp.toFixed(1)}</div>
        </div>
      ) : null}
    </div>
  );
};
