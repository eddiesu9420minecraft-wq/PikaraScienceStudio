import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {anchor} from '../actData';
import {Anchors, DotField, mix, SchematicTag, valColor, vis} from './common';
import {ATT_IT, ATT_W, ATT_WORDS, textW, vecOf} from './data';

export const attTimes = (A: Anchors) => {
  const example = anchor(A, 'example');
  const it = anchor(A, 'it');
  const apple = anchor(A, 'apple');
  const logits = anchor(A, 'logits');
  return {example, it, apple, logits, start: example - 50, panA: logits - 120, panB: logits - 10};
};

/** 2D 世界向上捲動（Attention → 生成）的位移量。 */
export const panT = (A: Anchors, f: number) => {
  const T = attTimes(A);
  return ease.camera(progress(f, T.panA, T.panB));
};

const FS = 58;
const TILE_H = 92;
const Y = 610;
const CELLS = 5;
const VECS = ATT_WORDS.map((_, i) => vecOf(100 + i).slice(0, CELLS));

export const AttentionScene: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = attTimes(A);
  const pan = panT(A, f);
  if (pan >= 1) return null;
  const enter = ease.out(progress(f, T.example - 46, T.example + 20));
  const sceneO = progress(f, T.example - 46, T.example - 6);
  const scale = lerp(1.18, 1, enter) * (1 + 0.035 * ease.inOut(progress(f, T.apple, T.panA)));

  // 版面
  const ws = ATT_WORDS.map((w) => textW(w, FS) + 40);
  const gap = 18;
  const total = ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
  let acc = 960 - total / 2;
  const xs = ws.map((w) => {
    const c = acc + w / 2;
    acc += w + gap;
    return c;
  });

  const itX = xs[ATT_IT];
  const yTop = Y - TILE_H / 2 - 6;
  const itOn = progress(f, T.it - 20, T.it + 10);
  const arcGrow = (j: number) => ease.out(progress(f, T.it + 36 + (ATT_IT - 1 - j) * 7, T.it + 96 + (ATT_IT - 1 - j) * 7));
  const resolve = ease.inOut(progress(f, T.it + 150, T.apple - 30));
  const appleOn = progress(f, T.apple - 16, T.apple + 14);
  const absorb = ease.inOut(progress(f, T.apple + 10, T.apple + 90));
  const futureDim = progress(f, T.it - 10, T.it + 30);

  const arcs = ATT_W.map((w, j) => {
    const x2 = xs[j];
    const h = 60 + 0.28 * Math.abs(itX - x2);
    const cx = (itX + x2) / 2;
    const cy = yTop - h * 2; // 二次曲線頂點高度 = h
    const weight = lerp(0.16, w, resolve);
    return {j, x2, cx, cy, h, weight};
  });

  return (
    <div style={{position: 'absolute', inset: 0, opacity: sceneO, transform: `translateY(${-1200 * pan}px)`}}>
      <DotField ox={0} oy={-1200 * pan * 0.15} o={0.45} />
      <div style={{position: 'absolute', inset: 0, transform: `scale(${scale})`, transformOrigin: '960px 600px'}}>
        {/* 弧線 */}
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
          {arcs.map((a) => {
            const g = arcGrow(a.j);
            if (g <= 0) return null;
            const isApple = a.j === 2;
            const col = isApple ? mix(P.amber, '#FFE0A8', appleOn * 0.5) : P.amber;
            return (
              <path
                key={a.j}
                d={`M ${itX} ${yTop} Q ${a.cx} ${a.cy} ${a.x2} ${yTop}`}
                fill="none"
                stroke={col}
                strokeWidth={1.5 + 16 * a.weight}
                strokeLinecap="round"
                opacity={0.22 + 0.78 * Math.min(1, a.weight * 1.6)}
                pathLength={1}
                strokeDasharray={`${g} 1`}
              />
            );
          })}
          {/* 從蘋果流向「它」的資訊 */}
          {appleOn > 0
            ? Array.from({length: 5}, (_, k) => {
                const a = arcs[2];
                const t = (((f - T.apple) / 46 + k / 5) % 1 + 1) % 1;
                // 由 x2（蘋果）→ itX（它）
                const u = t;
                const x = (1 - u) * (1 - u) * a.x2 + 2 * (1 - u) * u * a.cx + u * u * itX;
                const y = (1 - u) * (1 - u) * yTop + 2 * (1 - u) * u * a.cy + u * u * yTop;
                const o = appleOn * Math.sin(Math.PI * t) * (1 - progress(f, T.apple + 200, T.apple + 240));
                return <circle key={k} cx={x} cy={y} r={7} fill="#FFE3B0" opacity={o} />;
              })
            : null}
        </svg>

        {/* 權重百分比（只標最重要的兩個） */}
        {[2, 4].map((j) => {
          const o = progress(f, T.it + 190, T.apple - 20);
          if (o <= 0) return null;
          return (
            <div
              key={j}
              style={{
                position: 'absolute',
                left: xs[j] - 80,
                width: 160,
                top: Y + TILE_H / 2 + 50,
                textAlign: 'center',
                ...type.mono,
                fontSize: j === 2 ? 34 : 28,
                color: j === 2 ? P.amber : mix(P.amber, P.mist, 0.4),
                opacity: o,
                transform: `translateY(${(1 - o) * 8}px)`,
              }}
            >
              {Math.round(ATT_W[j] * 100)}%
            </div>
          );
        })}

        {/* 詞塊 */}
        {ATT_WORDS.map((w, i) => {
          const pop = ease.out(progress(f, T.example - 24 + i * 8, T.example + i * 8));
          const isIt = i === ATT_IT;
          const isApple = i === 2;
          const future = i > ATT_IT;
          const dim = future ? 1 - 0.6 * futureDim : 1;
          const border = isIt ? mix(P.ice, P.amber, Math.max(itOn * 0.4, absorb)) : isApple ? mix(P.ice, P.amber, appleOn) : P.ice;
          const lift = isIt ? -10 * itOn : 0;
          return (
            <React.Fragment key={i}>
              <div
                style={{
                  position: 'absolute',
                  left: xs[i] - ws[i] / 2,
                  top: Y - TILE_H / 2 + lift + (1 - pop) * 24,
                  width: ws[i],
                  height: TILE_H,
                  borderRadius: 10,
                  background: isApple ? mix(P.wall, '#4A3A22', appleOn) : P.wall,
                  boxShadow: `inset 0 0 0 ${isIt || isApple ? 2.5 : 1.5}px ${border}${isApple && appleOn > 0 ? `, 0 0 ${26 * appleOn}px rgba(255,181,71,0.45)` : ''}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  ...type.title,
                  fontSize: FS,
                  color: P.paper,
                  opacity: pop * dim,
                  lineHeight: 1,
                }}
              >
                {w}
              </div>
              {/* 每個詞的向量（小色條） */}
              <div
                style={{
                  position: 'absolute',
                  left: xs[i] - (CELLS * 14 + (CELLS - 1) * 3) / 2,
                  top: Y + TILE_H / 2 + 16 + lift,
                  display: 'flex',
                  gap: 3,
                  opacity: pop * dim * progress(f, T.example + 60, T.example + 110),
                }}
              >
                {VECS[i].map((v, k) => {
                  const target = isIt ? lerp(v, VECS[2][k], absorb * 0.85) : v;
                  return <div key={k} style={{width: 14, height: 22, borderRadius: 3, background: valColor(target, '#1C2740')}} />;
                })}
              </div>
            </React.Fragment>
          );
        })}

        {/* 「它」上方的問號 */}
        {(() => {
          const o = vis(f, T.it - 16, T.it + 10, T.it + 40, T.it + 70);
          return o > 0 ? (
            <div style={{position: 'absolute', left: itX - 40, width: 80, top: yTop - 96, textAlign: 'center', ...type.display, fontSize: 64, color: P.amber, opacity: o, transform: `scale(${0.8 + 0.2 * o})`}}>
              ?
            </div>
          ) : null;
        })()}

        {/* 因果遮罩：後面的詞還看不到 */}
        {futureDim > 0 ? (
          <>
            <div
              style={{
                position: 'absolute',
                left: (xs[ATT_IT] + ws[ATT_IT] / 2 + xs[ATT_IT + 1] - ws[ATT_IT + 1] / 2) / 2 - 1,
                top: Y - 80,
                width: 2,
                height: 200,
                background: `repeating-linear-gradient(to bottom, ${P.mist} 0 6px, transparent 6px 12px)`,
                opacity: 0.6 * futureDim,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: xs[ATT_IT + 1] - ws[ATT_IT + 1] / 2,
                top: Y - 116,
                ...type.label,
                fontSize: 20,
                color: P.mist,
                opacity: futureDim * progress(f, T.it + 60, T.it + 100),
                whiteSpace: 'nowrap',
              }}
            >
              只參考前面的詞
            </div>
          </>
        ) : null}

        {/* 吸收結果 */}
        {(() => {
          const o = progress(f, T.apple + 50, T.apple + 90);
          return o > 0 ? (
            <div style={{position: 'absolute', left: itX - 200, width: 400, top: Y + TILE_H / 2 + 56, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 8}px)`}}>
              <span style={{...type.title, fontSize: 30, color: P.amber}}>它 ＝ 蘋果</span>
            </div>
          ) : null;
        })()}
      </div>
      <SchematicTag o={1 - pan * 2} text="Attention 示意圖" />
    </div>
  );
};

export {clamp};
