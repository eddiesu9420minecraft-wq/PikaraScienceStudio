import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {Anchors, arrowHead, Chip, DotField, mix, SchematicTag, vis} from './common';
import {A_TOKENS, CANDS, pick, Q_TOKENS, softmax, textW} from './data';
import {genTimes, ROW_FS, ROW_H, rowAt} from './genTimes';
import {CH, drawsOf, GenChart, tempAt} from './GenChart';
import {panT} from './AttentionScene';

const STACK = {x: 400, y: 520};
const LAYERS = 4;
const gridY = (r: number) => 520 - r * 72;

export const GenScene: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = genTimes(A);
  const pan = panT(A, f);
  if (pan <= 0) return null;
  const off = 1200 * (1 - pan);
  const row = rowAt(A, f);
  const nQ = Q_TOKENS.length;

  // ---- 堆疊（模型）脈衝 ----
  const pulses = [T.logits - 56, T.iter(1), T.iter(2), T.iter(3)];
  const slabGlow = (k: number) => Math.max(...pulses.map((p) => vis(f, p + k * 6, p + k * 6 + 8, p + k * 6 + 14, p + k * 6 + 34)));
  const stackO = vis(f, T.logits - 90, T.logits - 60, T.moveA - 40, T.moveA + 10);
  const loopO = vis(f, T.loop - 30, T.loop + 20, T.moveA - 40, T.moveA + 10);
  const loopDraw = ease.inOut(progress(f, T.loop - 30, T.loop + 30));
  const autoregO = vis(f, T.autoreg - 16, T.autoreg + 16, T.moveA - 40, T.moveA + 10);

  // ---- 回放（Prefill / Decode）----
  const pdO = vis(f, T.moveA - 10, T.moveA + 50, T.tps - 30, T.tps + 6);
  const replayDim = vis(f, T.moveA, T.moveA + 40, T.prefill + 40, T.prefill + 60);
  const relit = (k: number) => (k === 0 ? progress(f, T.prefill + 44, T.prefill + 60) : progress(f, T.dstep(k) + 24, T.dstep(k) + 34));
  const preLit = (r: number) => vis(f, T.prefill - 14 + r * 12, T.prefill - 6 + r * 12, T.prefill + 10 + r * 12, T.prefill + 70 + r * 12);
  const decLit = (s: number, r: number) => vis(f, T.dstep(s) + r * 6, T.dstep(s) + r * 6 + 5, T.dstep(s) + r * 6 + 10, T.dstep(s) + r * 6 + 40);

  // ---- 結尾：token/s ----
  const finO = progress(f, T.tps - 20, T.tps + 20);
  const rowO = 1 - progress(f, T.tps - 22, T.tps - 2);

  // 飛行中的 token（從圖表到序列尾端）
  const fly = (k: number) => {
    const a = k === 0 ? T.append - 28 : T.iter(k) + 44;
    const b = T.arrive(k);
    return {a, b, t: progress(f, a, b)};
  };

  return (
    <div style={{position: 'absolute', inset: 0, transform: `translateY(${off}px)`}}>
      <DotField ox={0} oy={off * 0.15} o={0.45 * (1 - finO * 0.5)} />

      {/* 模型堆疊 */}
      {stackO > 0 ? (
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: stackO}}>
          {Array.from({length: 5}, (_, k) => {
            const y = STACK.y - 80 + k * 34;
            const g = slabGlow(k);
            return (
              <path
                key={k}
                d={`M ${STACK.x - 150} ${y + 20} L ${STACK.x + 60} ${y + 20} L ${STACK.x + 150} ${y - 20} L ${STACK.x - 60} ${y - 20} Z`}
                fill={mix('#22304F', '#5A4626', g)}
                fillOpacity={0.8}
                stroke={mix(P.ice, P.amber, g)}
                strokeWidth={1.5 + g}
              />
            );
          })}
          {/* 序列 → 模型 */}
          <path d={`M 960 ${row.y + 36} C 960 ${row.y + 120}, ${STACK.x} ${row.y + 110}, ${STACK.x} ${STACK.y - 116}`} fill="none" stroke={P.mist} strokeWidth={2} opacity={0.7} />
          <path d={arrowHead(STACK.x, STACK.y - 112, Math.PI / 2, 12)} fill="none" stroke={P.mist} strokeWidth={2} opacity={0.7} />
          {/* 模型 → 分數 */}
          <path d={`M ${STACK.x + 170} ${STACK.y} L ${CH.label - 150} ${STACK.y}`} fill="none" stroke={P.mist} strokeWidth={2} opacity={0.7} />
          <path d={arrowHead(CH.label - 146, STACK.y, 0, 12)} fill="none" stroke={P.mist} strokeWidth={2} opacity={0.7} />
        </svg>
      ) : null}
      {stackO > 0 ? (
        <>
          <div style={{position: 'absolute', left: STACK.x - 150, width: 300, top: STACK.y + 110, textAlign: 'center', ...type.label, fontSize: 22, color: P.mist, opacity: stackO}}>
            Transformer
          </div>
          {/* 序列與「下一個」空位的括號 */}
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: stackO * (1 - loopO)}}>
            <path
              d={`M ${row.items[0].x - row.items[0].w / 2} ${row.y + 30} L ${row.items[0].x - row.items[0].w / 2} ${row.y + 36} L ${row.slotX + 30} ${row.y + 36} L ${row.slotX + 30} ${row.y + 30}`}
              fill="none"
              stroke={P.mist}
              strokeWidth={1.4}
              opacity={0.6}
            />
          </svg>
        </>
      ) : null}

      <GenChart frame={f} anchors={A} />

      {/* 自回歸迴圈箭頭：選出的 token → 接回序列尾端 */}
      {loopO > 0 ? (
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: loopO}}>
          <path
            d={`M 1660 ${CH.stripY} C 1790 ${CH.stripY}, 1790 ${row.y}, ${row.slotX + 48} ${row.y}`}
            fill="none"
            stroke={P.amber}
            strokeWidth={2.5}
            pathLength={1}
            strokeDasharray={`${loopDraw} 1`}
          />
          {loopDraw > 0.97 ? <path d={arrowHead(row.slotX + 44, row.y, Math.PI, 13)} fill="none" stroke={P.amber} strokeWidth={2.5} /> : null}
          {/* 流動的點 */}
          {loopDraw >= 1
            ? Array.from({length: 3}, (_, k) => {
                const t = (((f - T.loop) / 70 + k / 3) % 1 + 1) % 1;
                const x0 = 1660;
                const y0 = CH.stripY;
                const x3 = row.slotX + 48;
                const y3 = row.y;
                const bx = (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * 1790 + 3 * (1 - t) * t * t * 1790 + t ** 3 * x3;
                const by = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y0 + 3 * (1 - t) * t * t * y3 + t ** 3 * y3;
                return <circle key={k} cx={bx} cy={by} r={5} fill={P.amber} opacity={Math.sin(Math.PI * t)} />;
              })
            : null}
        </svg>
      ) : null}
      {autoregO > 0 ? (
        <div style={{position: 'absolute', left: 1400, width: 330, top: 436, textAlign: 'right', opacity: autoregO, transform: `translateY(${(1 - autoregO) * 8}px)`}}>
          <span style={{...type.title, fontSize: 36, color: P.amber}}>自回歸生成</span>
        </div>
      ) : null}

      {/* Prefill / Decode：層 × token 格子 */}
      {pdO > 0 ? (
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: pdO}}>
          {row.items.map((it, c) => {
            if (it.a < 0.99) return null;
            const s = it.ans ? it.k + 1 : 0; // decode 步驟編號（這個 token 被送進模型的那一步）
            return Array.from({length: LAYERS}, (_, r) => {
              const lit = !it.ans ? preLit(r) : s <= 5 ? decLit(s, r) : 0;
              const done = !it.ans ? progress(f, T.prefill + 10 + r * 12, T.prefill + 30 + r * 12) : s <= 5 ? progress(f, T.dstep(s) + r * 6 + 10, T.dstep(s) + r * 6 + 30) : 0;
              const w = it.w - 6;
              return (
                <rect
                  key={`${c}-${r}`}
                  x={it.x - w / 2}
                  y={gridY(r) - 28}
                  width={w}
                  height={56}
                  rx={5}
                  fill={mix('#1A2440', '#6A5022', Math.max(lit, done * 0.28))}
                  stroke={mix(P.line, P.amber, Math.max(lit, done * 0.4))}
                  strokeWidth={1.4}
                  opacity={it.ans && s > 5 ? 0.3 : 1}
                />
              );
            });
          })}
          {/* 序列 → 層的細線 */}
          <line x1={row.items[0].x - 60} y1={gridY(0) + 48} x2={row.slotX} y2={gridY(0) + 48} stroke={P.line} strokeWidth={1} />
        </svg>
      ) : null}
      {pdO > 0 ? <PdTimeline f={f} A={A} o={pdO} rowItems={row.items} /> : null}

      {/* 序列（token chips） */}
      {rowO > 0
        ? row.items.map((it, i) => {
            if (it.a <= 0.01) return null;
            const showO = it.ans ? progress(f, T.arrive(it.k) - 2, T.arrive(it.k) + 4) : 1;
            const dim = it.ans ? lerp(1, it.k === 0 || it.k <= 3 ? 0.3 : 1, replayDim * (1 - relit(it.k))) : 1;
            const glow = it.ans ? vis(f, T.arrive(it.k) - 2, T.arrive(it.k) + 4, T.arrive(it.k) + 10, T.arrive(it.k) + 40) : 0;
            return (
              <Chip
                key={i}
                x={it.x}
                y={row.y}
                w={it.w * it.a}
                h={ROW_H}
                fs={ROW_FS}
                text={it.t}
                border={it.ans ? P.amber : P.ice}
                color={it.ans ? '#FFE3B0' : P.paper}
                o={showO * dim * rowO}
                glow={glow}
              />
            );
          })
        : null}
      {/* 下一個 token 的空位 */}
      {(() => {
        const o = vis(f, T.logits - 60, T.logits - 30, T.moveA - 40, T.moveA) * rowO;
        if (o <= 0) return null;
        const blink = 0.55 + 0.45 * Math.cos(f / 9);
        return (
          <div
            style={{
              position: 'absolute',
              left: row.slotX - 27,
              top: row.y - ROW_H / 2,
              width: 54,
              height: ROW_H,
              borderRadius: 8,
              border: `2px dashed ${P.amber}`,
              opacity: o * blink,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...type.title,
              fontSize: 26,
              color: P.amber,
            }}
          >
            ?
          </div>
        );
      })()}

      {/* 被選中的 token 飛到序列尾端 */}
      {[0, 1, 2, 3].map((k) => {
        const {t} = fly(k);
        if (t <= 0 || t >= 1) return null;
        const e = ease.inOut(t);
        const sx = CH.label - textW(A_TOKENS[k], 34) / 2;
        const sy = CH.y0; // 被選中的一定是第一名（示意）
        const fin = rowAt(A, T.arrive(k) + 12);
        const tgt = fin.items.find((it) => it.ans && it.k === k);
        const tx = tgt ? tgt.x : row.slotX;
        const ty = row.y;
        const x = lerp(sx, tx, e);
        const y = lerp(sy, ty, e) - Math.sin(Math.PI * e) * 60;
        return <Chip key={k} x={x} y={y} w={lerp(textW(A_TOKENS[k], 34) + 30, textW(A_TOKENS[k], ROW_FS) + 26, e)} h={lerp(58, ROW_H, e)} fs={lerp(34, ROW_FS, e)} text={A_TOKENS[k]} border={P.amber} color="#FFE3B0" glow={1} />;
      })}

      {f >= T.tps - 30 ? <Finale f={f} A={A} o={finO} rowY={row.y} rowItems={row.items} /> : null}

      <SchematicTag o={vis(f, T.logits - 40, T.logits, T.tps - 20, T.tps + 10)} />
    </div>
  );
};

// ---------------- Prefill / Decode 時間軸 ----------------
const PdTimeline: React.FC<{f: number; A: Anchors; o: number; rowItems: ReturnType<typeof rowAt>['items']}> = ({f, A, o}) => {
  const T = genTimes(A);
  const y = 706;
  const x0 = 380;
  const preO = progress(f, T.prefill - 14, T.prefill + 10);
  const block0W = 230;
  const stepW = 96;
  const steps = [1, 2, 3, 4, 5];
  const stepX = (s: number) => x0 + block0W + 24 + (s - 1) * (stepW + 14);
  const preLabelO = vis(f, T.prefill - 20, T.prefill + 10, T.tps - 30, T.tps);
  const decLabelO = vis(f, T.decode - 20, T.decode + 10, T.tps - 30, T.tps);
  return (
    <div style={{position: 'absolute', inset: 0, opacity: o}}>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <line x1={x0 - 30} y1={y + 46} x2={1560} y2={y + 46} stroke={P.mist} strokeWidth={1.5} opacity={0.7} />
        <path d={arrowHead(1564, y + 46, 0, 12)} fill="none" stroke={P.mist} strokeWidth={1.5} opacity={0.7} />
        {/* Prefill：一個步驟裡同時處理全部問題 token */}
        {preO > 0 ? (
          <g opacity={preO}>
            <rect x={x0} y={y - 26} width={block0W} height={58} rx={6} fill="rgba(255,181,71,0.12)" stroke={P.amber} strokeWidth={1.6} />
            {Array.from({length: 10}, (_, i) => (
              <rect key={i} x={x0 + 14 + i * 20.6} y={y - 12} width={15} height={30} rx={3} fill={P.ice} opacity={ease.out(preO)} />
            ))}
          </g>
        ) : null}
        {steps.map((s) => {
          const so = progress(f, T.dstep(s), T.dstep(s) + 14);
          if (so <= 0) return null;
          return (
            <g key={s} opacity={so} transform={`translate(0 ${(1 - so) * 8})`}>
              <rect x={stepX(s)} y={y - 26} width={stepW} height={58} rx={6} fill="rgba(255,181,71,0.12)" stroke={P.amber} strokeWidth={1.6} />
              <rect x={stepX(s) + stepW / 2 - 7.5} y={y - 12} width={15} height={30} rx={3} fill={P.amber} />
            </g>
          );
        })}
      </svg>
      <div style={{position: 'absolute', left: 1580, top: y + 30, ...type.label, fontSize: 20, color: P.mist}}>時間</div>
      {preLabelO > 0 ? (
        <div style={{position: 'absolute', left: x0, width: block0W, top: y + 60, textAlign: 'center', opacity: preLabelO}}>
          <span style={{...type.title, fontSize: 28, color: P.paper}}>Prefill</span>
          <span style={{...type.label, fontSize: 20, color: P.mist, marginLeft: 10}}>一起處理</span>
        </div>
      ) : null}
      {decLabelO > 0 ? (
        <div style={{position: 'absolute', left: stepX(1), width: 5 * stepW + 4 * 14, top: y + 60, textAlign: 'center', opacity: decLabelO}}>
          <span style={{...type.title, fontSize: 28, color: P.paper}}>Decode</span>
          <span style={{...type.label, fontSize: 20, color: P.mist, marginLeft: 10}}>一次一個</span>
        </div>
      ) : null}
    </div>
  );
};

// ---------------- 結尾：token 以穩定節奏冒出（token/s） ----------------
const Finale: React.FC<{f: number; A: Anchors; o: number; rowY: number; rowItems: ReturnType<typeof rowAt>['items']}> = ({f, A, o, rowY, rowItems}) => {
  const T = genTimes(A);
  const FS = 64;
  const Y = 520;
  const ws = A_TOKENS.map((t) => textW(t, FS));
  const total = ws.reduce((a, b) => a + b, 0);
  let acc = 960 - total / 2;
  const xs = ws.map((w) => {
    const c = acc + w / 2;
    acc += w;
    return c;
  });
  const n = A_TOKENS.filter((_, k) => f >= T.arrive(k)).length;
  const qO = progress(f, T.tps + 10, T.tps + 50);
  const tickerO = vis(f, T.tps + 20, T.tps + 50, T.speed + 40, T.speed + 60);
  const labelO = progress(f, T.tps + 10, T.tps + 40);
  return (
    <div style={{position: 'absolute', inset: 0}}>
      {/* 問題 */}
      <div style={{position: 'absolute', left: 0, width: 1920, top: 380, textAlign: 'center', ...type.title, fontSize: 30, color: P.mist, opacity: qO * 0.9}}>
        {Q_TOKENS.join('')}
      </div>
      {A_TOKENS.map((t, k) => {
        const arr = T.arrive(k);
        if (k <= 5) {
          // 已存在的 token：從序列飛下來
          const src = rowItems.find((it) => it.ans && it.k === k);
          const mv = ease.inOut(progress(f, T.tps - 22 + k * 3, T.tps + 26 + k * 3));
          const sx = src ? src.x : xs[k];
          const x = lerp(sx, xs[k], mv);
          const y = lerp(rowY, Y, mv);
          const fs = lerp(ROW_FS, FS, mv);
          return (
            <div key={k} style={{position: 'absolute', left: x - 200, width: 400, top: y - fs * 0.62, textAlign: 'center', ...type.title, fontSize: fs, lineHeight: 1.24, color: mix('#FFE3B0', P.paper, mv), opacity: clamp(mv * 3) * o}}>
              {t}
            </div>
          );
        }
        const p = progress(f, arr - 2, arr + 14);
        if (p <= 0) return null;
        const flash = vis(f, arr - 2, arr + 2, arr + 8, arr + 40);
        return (
          <div
            key={k}
            style={{
              position: 'absolute',
              left: xs[k] - 200,
              width: 400,
              top: Y - FS * 0.62,
              textAlign: 'center',
              ...type.title,
              fontSize: FS,
              lineHeight: 1.24,
              color: mix(P.paper, P.amber, flash),
              opacity: p,
              transform: `scale(${1 + 0.18 * (1 - ease.out(p))}) translateY(${(1 - ease.out(p)) * 10}px)`,
            }}
          >
            {t}
          </div>
        );
      })}
      {/* 下一個 token 的游標 */}
      {(() => {
        const done = f >= T.arrive(A_TOKENS.length - 1);
        const k = Math.min(n, A_TOKENS.length);
        const cx = k >= A_TOKENS.length ? xs[A_TOKENS.length - 1] + ws[A_TOKENS.length - 1] / 2 : xs[k] - ws[k] / 2;
        const co = o * (done ? 1 - progress(f, T.arrive(A_TOKENS.length - 1) + 20, T.arrive(A_TOKENS.length - 1) + 40) : 1) * progress(f, T.tps + 20, T.tps + 40);
        return co > 0 ? <div style={{position: 'absolute', left: cx + 4, top: Y - 36, width: 4, height: 72, borderRadius: 2, background: P.amber, opacity: co * (Math.floor(f / 20) % 2 === 0 ? 1 : 0.35)}} /> : null;
      })()}
      {/* 節拍尺：每產生一個 token 就打一個刻度，以固定速度往左移 */}
      {tickerO > 0 ? (
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: tickerO}}>
          <line x1={560} y1={640} x2={1360} y2={640} stroke={P.line} strokeWidth={2} />
          {A_TOKENS.map((_, k) => {
            const arr = T.arrive(k);
            if (k < 6 || f < arr) return null;
            const x = 1360 - (f - arr) * 2.2;
            if (x < 560) return null;
            const fade = progress(x, 560, 660);
            const pop = ease.out(progress(f, arr, arr + 10));
            return <line key={k} x1={x} y1={640 - 18 * pop} x2={x} y2={640 + 18 * pop} stroke={P.amber} strokeWidth={3} opacity={fade} />;
          })}
        </svg>
      ) : null}
      {labelO > 0 ? (
        <div style={{position: 'absolute', left: 0, width: 1920, top: 700, textAlign: 'center', opacity: labelO * (1 - progress(f, T.speed + 40, T.speed + 60)), transform: `translateY(${(1 - labelO) * 8}px)`}}>
          <span style={{...type.mono, fontSize: 34, color: P.amber}}>token/s</span>
          <span style={{...type.title, fontSize: 30, color: P.paper, marginLeft: 16}}>每秒產生的 token 數</span>
        </div>
      ) : null}
    </div>
  );
};

export {CANDS, pick, softmax, tempAt, drawsOf};
