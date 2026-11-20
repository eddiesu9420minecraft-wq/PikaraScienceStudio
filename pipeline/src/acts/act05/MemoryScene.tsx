import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import type {A5} from './timing';
import {MONO, Rect, rectLerp, Schematic, win} from './ui';
import {Caption, LAYOUT, vramBar} from './FlowScene';
import {N_CPU, N_GPU} from './board';

/**
 * 段落 D：VRAM 放大成記憶體面板 → KV Cache 逐 token 累積 → 壓成「6 GB VRAM」橫條，
 * Context 變長時 KV 變大、把權重層擠到 RAM → 三方取捨（模型大小／量化等級／上下文長度），結尾置中。
 * 比例皆為示意（KV 寬度與 -c 成正比），不代表實際容量。
 */
const GPU_K: Rect = {x: 150, y: 400, w: 220, h: 220};
const PANEL: Rect = {x: 470, y: 230, w: 1300, h: 560};
const KV_X0 = 1150;
const COL_W = 72;
const COL_GAP = 12;
const KV_TOKENS = ['天空', '之所以', '是', '藍色', '的', '，', '是因為'];
const wBarK = (k: number): Rect => ({x: 506 + k * 28, y: 300, w: 21, h: 460});

const BAR: Rect = {x: 260, y: 430, w: 1400, h: 90};
const SLOT = 60;
const BUF_W = 70;
const wBarC = (k: number): Rect => ({x: BAR.x + k * SLOT + 3, y: BAR.y + 6, w: SLOT - 6, h: BAR.h - 12});
const RAM_ROW: Rect = {x: 260, y: 660, w: 1400, h: 70};
const ramSlot = (i: number): Rect => ({x: RAM_ROW.x + i * SLOT + 3, y: RAM_ROW.y + 6, w: SLOT - 6, h: RAM_ROW.h - 12});

// 結尾置中的小橫條
const BAR_END: Rect = {x: 700, y: 505, w: 520, h: 62};

export const MemoryScene: React.FC<{f: number; a: A5}> = ({f, a}) => {
  const start = a.kv - 60;
  if (f < start) return null;

  // ---- 時間 ----
  const zoom = ease.camera(progress(f, start, a.kv + 24));
  const step = (a.store + 50 - (a.kv + 34)) / (KV_TOKENS.length - 1);
  const tokT = (i: number) => a.kv + 34 + i * step;
  const cm = ease.camera(progress(f, a.context - 70, a.context + 30)); // 面板 → 橫條
  const endT = ease.camera(progress(f, a.l12 + 10, a.l12 + 90)); // 橫條 → 置中
  const nodeT = (frac: number) => ease.out(progress(f, a.l12 + (a.tradeoff - a.l12) * frac - 20, a.l12 + (a.tradeoff - a.l12) * frac + 20));

  // -c 數值（4096 → 8192 → 16384 → 32768），寬度與 -c 成正比
  const cSteps = [
    {f: a.context + 50, v: 8192},
    {f: a.grow - 10, v: 16384},
    {f: a.compete + 20, v: 32768},
  ];
  const ctxAt = (t: number) => {
    let c = 4096;
    for (const s of cSteps) c = lerp(c, s.v, ease.inOut(progress(t, s.f, s.f + 34)));
    return c;
  };
  const ctx = ctxAt(f);
  const ctxShown = cSteps.reduce((v, s) => (f >= s.f + 17 ? s.v : v), 4096);
  const kvW = (c: number) => 60 * (c / 4096);
  const kvLeft = (t: number) => BAR.x + BAR.w - BUF_W - kvW(ctxAt(t));
  // 被擠出的層：找出第一次重疊的影格（確定性掃描）
  const evictAt = (k: number) => {
    const right = BAR.x + k * SLOT + SLOT;
    for (let t = a.context; t <= a.end; t += 2) if (kvLeft(t) < right - 2) return t;
    return Infinity;
  };
  const evictTimes = Array.from({length: N_GPU}, (_, k) => evictAt(k));
  const gpuLayersNow = evictTimes.filter((t) => f < t + 20).length;


  const panel = rectLerp(rectLerp(VRAM_UNION, PANEL, zoom), BAR, cm);
  const gpu = rectLerp(rectLerp(LAYOUT.gpu, GPU_K, zoom), {x: 60, y: BAR.y - 10, w: 110, h: 110}, cm);
  const gpuO = 1 - progress(f, a.context - 40, a.context + 10);
  const sceneShift = endT; // 0..1

  const kvO = 1 - cm;
  const tokRowO = progress(f, a.kv - 10, a.kv + 20) * (1 - progress(f, a.context - 60, a.context - 20));
  const labelsK = progress(f, a.kv - 6, a.kv + 26) * (1 - progress(f, a.context - 60, a.context - 30));
  const barLabels = progress(f, a.context + 10, a.context + 40) * (1 - endT);
  const ramRowO = progress(f, a.grow - 20, a.grow + 20) * (1 - endT);
  const readNote = win(f, a.store + 70, a.store + 100, a.context - 70, a.context - 40);

  // 結尾把整個橫條縮到中央
  const barRect = rectLerp(panel, BAR_END, sceneShift);
  const sx = barRect.w / BAR.w;
  const mapX = (x: number) => barRect.x + (x - BAR.x) * sx;
  const mapRect = (r: Rect): Rect => (sceneShift > 0 ? {x: mapX(r.x), y: barRect.y + (r.y - BAR.y) * (barRect.h / BAR.h), w: r.w * sx, h: r.h * (barRect.h / BAR.h)} : r);

  // 權重條
  const weights = Array.from({length: N_GPU}, (_, k) => {
    const r0 = vramBar(k);
    const r1 = wBarK(k);
    const r2 = wBarC(k);
    let r = rectLerp(rectLerp(r0, r1, ease.camera(progress(f, start + k * 1.5, a.kv + 24 + k * 1.5))), r2, cm);
    const te = evictTimes[k];
    const ev = ease.camera(progress(f, te, te + 40));
    if (ev > 0) {
      const slot = ramSlot(N_CPU + (N_GPU - 1 - k));
      r = rectLerp(r, slot, ev);
      r = {...r, y: r.y - Math.sin(ev * Math.PI) * 40};
    }
    return {r: mapRect(r), ev};
  });

  // KV 區塊
  const kvRegion = (t: number) => {
    const w = kvW(ctxAt(t));
    return {x: BAR.x + BAR.w - BUF_W - w, w};
  };
  const kr = kvRegion(f);
  const kvBlocks = KV_TOKENS.map((_, i) => {
    const g = ease.out(progress(f, tokT(i) + 6, tokT(i) + 34));
    const colX = KV_X0 + i * (COL_W + COL_GAP);
    const Kp: Rect = {x: colX, y: 300, w: COL_W, h: 216 * g};
    const Vp: Rect = {x: colX, y: 544, w: COL_W, h: 216 * g};
    const segW = kr.w / KV_TOKENS.length;
    const Kc: Rect = {x: kr.x + i * segW + 1, y: BAR.y + 6, w: segW - 2, h: (BAR.h - 12) / 2 - 2};
    const Vc: Rect = {x: kr.x + i * segW + 1, y: BAR.y + BAR.h / 2 + 1, w: segW - 2, h: (BAR.h - 12) / 2 - 2};
    return {K: mapRect(rectLerp(Kp, Kc, cm)), V: mapRect(rectLerp(Vp, Vc, cm)), g};
  });
  const buf = mapRect({x: BAR.x + BAR.w - BUF_W + 3, y: BAR.y + 6, w: BUF_W - 6, h: BAR.h - 12});
  const bufO = progress(f, a.context, a.context + 30);

  // 目前正在處理的 token（讀取先前的 K）
  const cur = KV_TOKENS.findIndex((_, i) => f < tokT(i) + step);
  const curIdx = cur < 0 ? KV_TOKENS.length - 1 : cur;
  const readT = cur < 0 ? readNote : progress(f, tokT(curIdx) + 4, tokT(curIdx) + 18) * (1 - progress(f, tokT(curIdx) + step - 10, tokT(curIdx) + step));

  // 三方取捨
  const nodes = [
    {x: 960, y: 196, title: '模型大小', t: nodeT(19 / 35), glyph: 'size'},
    {x: 470, y: 770, title: '量化等級', t: nodeT(24 / 35), glyph: 'quant'},
    {x: 1450, y: 770, title: '上下文長度', t: nodeT(29.5 / 35), glyph: 'ctx'},
  ] as const;
  const triT = nodeT(33 / 35);
  const pulse = progress(f, a.tradeoff - 6, a.tradeoff + 30);

  return (
    <div style={{position: 'absolute', inset: 0}}>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <radialGradient id="a5mem-bg" cx="0.5" cy="0.5" r="0.6">
            <stop offset="0" stopColor="#1C2740" stopOpacity={0.5} />
            <stop offset="1" stopColor="#090D18" stopOpacity={0} />
          </radialGradient>
        </defs>
        <rect width={1920} height={1080} fill={P.ink} opacity={progress(f, start, start + 6)} />
        <rect width={1920} height={1080} fill="url(#a5mem-bg)" />

        {/* 三角取捨（底層） */}
        {triT > 0 || nodes.some((n) => n.t > 0) ? (
          <g>
            {[0, 1, 2].map((i) => {
              const A = nodes[i];
              const B = nodes[(i + 1) % 3];
              const t = Math.min(A.t, B.t);
              if (t <= 0) return null;
              const x2 = lerp(A.x, B.x, t);
              const y2 = lerp(A.y, B.y, t);
              return <line key={i} x1={A.x} y1={A.y} x2={x2} y2={y2} stroke={P.amber} strokeWidth={2} opacity={0.35 + 0.4 * Math.sin(pulse * Math.PI)} strokeDasharray="2 10" strokeLinecap="round" />;
            })}
            {nodes.map((n, i) => (
              <line key={'s' + i} x1={n.x} y1={n.y} x2={lerp(n.x, 960, 0.62 * n.t)} y2={lerp(n.y, 536, 0.62 * n.t)} stroke={P.mist} strokeWidth={1.2} opacity={0.4 * n.t} />
            ))}
          </g>
        ) : null}

        {/* GPU（KV 段落時在左側，像在讀寫 VRAM） */}
        {gpuO > 0 ? (
          <g opacity={gpuO}>
            <rect x={gpu.x + gpu.w} y={gpu.y + gpu.h * 0.1} width={Math.max(0, panel.x - gpu.x - gpu.w)} height={gpu.h * 0.8} fill="#1A2236" />
            <rect x={gpu.x} y={gpu.y} width={gpu.w} height={gpu.h} rx={8} fill="#24463A" stroke={P.ice} strokeOpacity={0.5} strokeWidth={2} />
            <rect x={gpu.x + gpu.w * 0.14} y={gpu.y + gpu.h * 0.14} width={gpu.w * 0.72} height={gpu.h * 0.72} rx={4} fill="#28324A" />
            {Array.from({length: 64}).map((_, i) => {
              const r = Math.floor(i / 8);
              const c = i % 8;
              const cw = (gpu.w * 0.72 - 9 * 3) / 8;
              const lit = 0.3 + 0.6 * Math.max(0, Math.sin(f * 0.12 - (r + c) * 0.3));
              return <rect key={i} x={gpu.x + gpu.w * 0.14 + 3 + c * (cw + 3)} y={gpu.y + gpu.h * 0.14 + 3 + r * (cw + 3)} width={cw} height={cw} rx={1} fill={P.ice} opacity={lit} />;
            })}
          </g>
        ) : null}

        {/* VRAM 面板 → 橫條 */}
        <rect x={barRect.x} y={barRect.y} width={barRect.w} height={barRect.h} rx={lerp(14, 10, cm)} fill="#121826" stroke={P.ice} strokeOpacity={0.6} strokeWidth={2} />
        {/* 原本的三顆 VRAM 顆粒輪廓淡出 */}
        {zoom < 1
          ? LAYOUT.vram.map((r, k) => {
              const rr = rectLerp(r, {x: PANEL.x + 10 + k * 430, y: PANEL.y + 10, w: 420, h: PANEL.h - 20}, zoom);
              return <rect key={k} x={rr.x} y={rr.y} width={rr.w} height={rr.h} rx={6} fill="none" stroke={P.ice} strokeOpacity={0.45 * (1 - zoom)} strokeWidth={2} />;
            })
          : null}
        {/* RAM 列 */}
        {ramRowO > 0 ? (
          <g opacity={ramRowO}>
            <rect x={RAM_ROW.x} y={RAM_ROW.y} width={RAM_ROW.w} height={RAM_ROW.h} rx={10} fill="#121826" stroke={P.amber} strokeOpacity={0.45} strokeWidth={2} />
            {Array.from({length: N_CPU}).map((_, i) => {
              const r = ramSlot(i);
              return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={3} fill={P.amberDeep} opacity={0.55} />;
            })}
          </g>
        ) : null}
        {/* 權重 */}
        {weights.map(({r, ev}, k) => (
          <rect key={k} x={r.x} y={r.y} width={Math.max(0, r.w)} height={Math.max(0, r.h)} rx={3} fill={P.amberDeep} opacity={ev > 0.5 ? 0.75 * (1 - endT) : 0.95} />
        ))}
        {/* KV */}
        {kvBlocks.map((b, i) =>
          b.g > 0 ? (
            <g key={i}>
              <rect x={b.K.x} y={b.K.y} width={Math.max(0, b.K.w)} height={Math.max(0, b.K.h)} rx={3} fill={P.ice} opacity={i === curIdx && cur >= 0 ? 0.95 : 0.75} />
              <rect x={b.V.x} y={b.V.y} width={Math.max(0, b.V.w)} height={Math.max(0, b.V.h)} rx={3} fill={P.mint} opacity={i === curIdx && cur >= 0 ? 0.95 : 0.7} />
            </g>
          ) : null,
        )}
        {/* KV 區在 -c 變大時的空間（尚未填滿，以虛線框表示預留） */}
        {cm > 0.5 ? (
          <rect
            x={mapX(kr.x) + 1}
            y={barRect.y + 4}
            width={Math.max(0, kr.w * sx - 2)}
            height={Math.max(0, barRect.h - 8)}
            rx={4}
            fill="rgba(92,200,255,0.16)"
            stroke={P.ice}
            strokeWidth={1.5}
            strokeDasharray="6 6"
            opacity={progress(cm, 0.5, 1)}
          />
        ) : null}
        {bufO > 0 ? <rect x={buf.x} y={buf.y} width={Math.max(0, buf.w)} height={Math.max(0, buf.h)} rx={3} fill={P.mist} opacity={0.45 * bufO} /> : null}

        {/* 讀取先前的 K/V：從目前 token 拉線 */}
        {kvO > 0.05 && readT > 0
          ? KV_TOKENS.slice(0, curIdx).map((_, j) => {
              const tx = KV_X0 + curIdx * (COL_W + COL_GAP) + COL_W / 2;
              const jx = KV_X0 + j * (COL_W + COL_GAP) + COL_W / 2;
              return (
                <path
                  key={j}
                  d={`M ${tx} 182 C ${tx} 250, ${jx} 220, ${jx} 300`}
                  fill="none"
                  stroke={P.ice}
                  strokeWidth={2}
                  opacity={0.75 * readT * kvO}
                />
              );
            })
          : null}
      </svg>

      {/* token 列 */}
      {tokRowO > 0
        ? KV_TOKENS.map((tk, i) => {
            const t = progress(f, tokT(i) - 10, tokT(i) + 8);
            if (t <= 0) return null;
            const x = KV_X0 + i * (COL_W + COL_GAP);
            const active = i === curIdx && cur >= 0;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: x - 10,
                  width: COL_W + 20,
                  top: 128 - (1 - t) * 30,
                  textAlign: 'center',
                  ...type.title,
                  fontSize: 26,
                  color: active ? P.ice : P.paper,
                  opacity: t * tokRowO,
                  borderBottom: `2px solid ${active ? P.ice : P.line}`,
                  paddingBottom: 6,
                }}
              >
                {tk}
              </div>
            );
          })
        : null}

      {/* 段落標籤 */}
      <Caption x={506 + 276} y={806} text="模型權重" o={labelsK} size={26} color={P.amber} />
      <Caption x={KV_X0 + 290} y={806} text="KV Cache" o={labelsK} size={28} color={P.ice} />
      <div style={{position: 'absolute', left: PANEL.x, top: PANEL.y - 52, ...type.title, fontSize: 30, color: P.ice, opacity: labelsK}}>VRAM</div>
      <div style={{position: 'absolute', left: KV_X0 - 40, top: 392, ...type.label, fontFamily: MONO, fontSize: 26, color: P.ice, opacity: labelsK}}>K</div>
      <div style={{position: 'absolute', left: KV_X0 - 40, top: 636, ...type.label, fontFamily: MONO, fontSize: 26, color: P.mint, opacity: labelsK}}>V</div>
      <div style={{position: 'absolute', left: 560, width: 560, top: 160, textAlign: 'right', ...type.label, fontSize: 28, color: P.paper, opacity: readNote}}>直接讀取，不必重算 →</div>

      {/* 橫條段落：VRAM 6 GB、-c 滑桿、分區標籤 */}
      {barLabels > 0 ? (
        <>
          <div style={{position: 'absolute', left: BAR.x, top: BAR.y - 64, ...type.title, fontSize: 34, color: P.ice, opacity: barLabels}}>VRAM 6 GB</div>
          <div style={{position: 'absolute', left: BAR.x + BAR.w - 420, width: 420, top: BAR.y - 76, textAlign: 'right', fontFamily: MONO, opacity: barLabels}}>
            <span style={{fontSize: 22, color: P.mist}}>--ctx-size　</span>
            <span style={{fontSize: 44, fontWeight: 600, color: P.paper}}>-c </span>
            <span style={{fontSize: 44, fontWeight: 600, color: P.ice}}>{ctxShown}</span>
          </div>
          <Caption x={BAR.x + 600} y={BAR.y + BAR.h + 16} text="模型權重" o={barLabels} size={22} color={P.amber} />
          <Caption x={mapX(kr.x) + (kr.w * sx) / 2} y={BAR.y + BAR.h + 16} text="KV Cache" o={barLabels} size={22} color={P.ice} />
          <Caption x={BAR.x + BAR.w - BUF_W / 2} y={BAR.y + BAR.h + 52} text="其他" o={barLabels * 0.8} size={19} color={P.mist} />
          <div style={{position: 'absolute', left: BAR.x, top: RAM_ROW.y + RAM_ROW.h + 14, ...type.label, fontSize: 22, color: P.amber, opacity: ramRowO}}>
            系統記憶體 RAM（由 CPU 計算）
          </div>
          <div style={{position: 'absolute', left: BAR.x + 280, top: BAR.y - 58, fontFamily: MONO, fontSize: 24, color: P.mist, opacity: barLabels * progress(f, a.grow, a.grow + 30)}}>
            GPU 層數 <span style={{color: P.paper, fontWeight: 700}}>{gpuLayersNow}</span>
          </div>
        </>
      ) : null}

      {/* 取捨節點 */}
      {nodes.map((n, i) =>
        n.t > 0 ? (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: n.x - 200,
              width: 400,
              top: n.y - 44,
              textAlign: 'center',
              opacity: n.t,
              transform: `translateY(${(1 - n.t) * 14}px) scale(${1 + 0.06 * Math.sin(pulse * Math.PI)})`,
            }}
          >
            <Glyph kind={n.glyph} f={f} />
            <div style={{...type.title, fontSize: 38, color: P.paper, marginTop: 8}}>{n.title}</div>
          </div>
        ) : null,
      )}
      {endT > 0 ? (
        <div style={{position: 'absolute', left: 0, width: 1920, top: BAR_END.y - 52, textAlign: 'center', ...type.title, fontSize: 28, color: P.ice, opacity: endT}}>VRAM 6 GB</div>
      ) : null}

      <Schematic o={progress(f, start + 20, start + 50)} text={f > a.context ? '示意圖：比例不代表實際容量' : '示意圖'} />
    </div>
  );
};

const VRAM_UNION: Rect = {x: LAYOUT.vram[0].x, y: LAYOUT.vram[0].y, w: LAYOUT.vram[0].w, h: LAYOUT.vram[2].y + LAYOUT.vram[2].h - LAYOUT.vram[0].y};

const Glyph: React.FC<{kind: 'size' | 'quant' | 'ctx'; f: number}> = ({kind, f}) => {
  if (kind === 'size')
    return (
      <svg width={120} height={44}>
        {Array.from({length: 5}).map((_, i) => (
          <rect key={i} x={14} y={36 - i * 8} width={92} height={6} rx={2} fill={P.amberDeep} opacity={0.6 + 0.08 * i} />
        ))}
      </svg>
    );
  if (kind === 'quant')
    return (
      <div style={{display: 'flex', gap: 10, justifyContent: 'center', fontFamily: MONO, fontSize: 20, color: P.amber, height: 44, alignItems: 'center'}}>
        {['Q8', 'Q6', 'Q4'].map((q, i) => (
          <span key={q} style={{border: `1.5px solid rgba(255,181,71,${0.8 - i * 0.2})`, padding: '2px 8px', borderRadius: 4, opacity: 1 - i * 0.15}}>
            {q}
          </span>
        ))}
      </div>
    );
  return (
    <svg width={180} height={44}>
      {Array.from({length: 8}).map((_, i) => (
        <rect key={i} x={6 + i * 21} y={14} width={16} height={16} rx={3} fill={P.ice} opacity={0.35 + 0.5 * clamp(Math.sin(f * 0.06 - i * 0.5))} />
      ))}
    </svg>
  );
};
