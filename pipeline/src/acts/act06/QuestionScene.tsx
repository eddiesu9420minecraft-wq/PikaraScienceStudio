import React from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {buildCamera, project} from '../../lib/camera3d';
import {Cam2D, cam2dAt, CameraLayer} from '../../lib/camera2d';
import {anchor} from '../actData';
import {Anchors, DotField, mix, SchematicTag, valColor, vis} from './common';
import {monoW, Q_IDS, Q_TOKENS, Q_VECS, textW, VEC_N} from './data';
import {embedRig, embedTimes, qTokenPos} from './embedRig';
import {Examples} from './Examples';
import {HookIntro, hookTimes} from './HookIntro';

const CELL_H = 42;

/** 第 1 段：問題 → 切成 token → 編號 → 範例 → 向量 → 飛向嵌入空間。 */
export const timesQ = (A: Anchors) => {
  const ready = anchor(A, 'ready');
  const tokenize = anchor(A, 'tokenize');
  const ids = anchor(A, 'ids');
  const notchar = anchor(A, 'notchar');
  const english = anchor(A, 'english');
  const chinese = anchor(A, 'chinese');
  const embed = anchor(A, 'embed');
  const E = embedTimes(A);
  return {
    ready,
    tokenize,
    ids,
    notchar,
    english,
    chinese,
    embed,
    vector: E.vector,
    flyA: E.flyA,
    flyB: E.flyB,
    typeA: ready - 56,
    typeB: ready + 66,
    snip: (i: number) => tokenize + 26 + i * 25,
    shrinkA: english - 70,
    shrinkB: english - 14,
  };
};

type ChipL = {x: number; w: number; h: number; y: number; fs: number; sep: number; flip: number};

export const rowLayout = (A: Anchors, f: number): ChipL[] => {
  const T = timesQ(A);
  const sh = ease.camera(progress(f, T.shrinkA, T.shrinkB));
  const fs = lerp(72, 46, sh);
  const y = lerp(512, 196, sh);
  const k = fs / 72;
  const n = Q_TOKENS.length;
  const cut = (i: number) => (i < 0 || i >= n - 1 ? 0 : ease.out(progress(f, T.snip(i), T.snip(i) + 20)));
  const unfold = progress(f, T.embed - 20, T.embed + 30);
  const items = Q_TOKENS.map((t, j) => {
    const sep = Math.max(cut(j - 1), cut(j));
    const tw = textW(t, fs);
    const iw = monoW(Q_IDS[j], fs * 0.47);
    const pad = 16 * k * sep;
    let w = tw + Math.max(0, iw - tw) * sep + 2 * pad;
    w = Math.max(w, lerp(w, 82, unfold));
    const flip = ease.inOut(progress(f, T.ids - 34 + j * 5, T.ids - 34 + j * 5 + 24));
    return {w, sep, flip};
  });
  const gaps = Array.from({length: n - 1}, (_, i) => 18 * (0.55 + 0.45 * k) * cut(i) + 8 * unfold);
  const total = items.reduce((s, it) => s + it.w, 0) + gaps.reduce((s, g) => s + g, 0);
  let x = 960 - total / 2;
  return items.map((it, j) => {
    const cx = x + it.w / 2;
    x += it.w + (gaps[j] ?? 0);
    return {x: cx, w: it.w, h: fs * 1.5, y, fs, sep: it.sep, flip: it.flip};
  });
};

const camAt = (A: Anchors, f: number): Cam2D => {
  const T = timesQ(A);
  return cam2dAt(f, [
    {f: 0, v: {cx: 960, cy: 540, zoom: 1.0}},
    {f: T.tokenize, v: {cx: 960, cy: 530, zoom: 1.03}},
    {f: T.notchar + 40, v: {cx: 960, cy: 530, zoom: 1.06}, ease: ease.inOutSoft},
    {f: T.shrinkB, v: {cx: 960, cy: 540, zoom: 1.0}, ease: ease.camera},
    {f: T.embed, v: {cx: 960, cy: 520, zoom: 1.02}, ease: ease.inOutSoft},
    {f: T.flyA, v: {cx: 960, cy: 500, zoom: 1.05}, ease: ease.inOutSoft},
  ]);
};
const toScreen = (c: Cam2D, x: number, y: number) => ({x: 960 + (x - c.cx) * c.zoom, y: 540 + (y - c.cy) * c.zoom});

// ---------------- 剪刀 ----------------
const Scissors: React.FC<{x: number; y: number; open: number; o: number}> = ({x, y, open, o}) => {
  if (o <= 0.001) return null;
  const a = open * 22;
  const blade = (s: number) => (
    <g transform={`rotate(${s * a})`}>
      <path d="M 0 0 L -5 10 L -1.5 64 L 1 66 L 5 10 Z" fill="#C9D2E2" stroke="#EEF1F7" strokeWidth={0.8} />
      <path d={`M 0 0 L ${-6 * s} -20`} stroke="#9AA4B8" strokeWidth={4} strokeLinecap="round" />
      <ellipse cx={-14 * s} cy={-36} rx={13} ry={16} fill="none" stroke={P.amber} strokeWidth={5} transform={`rotate(${s * 18} ${-14 * s} -36)`} />
    </g>
  );
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: o}}>
      <g transform={`translate(${x} ${y})`}>
        {blade(1)}
        {blade(-1)}
        <circle r={4} fill={P.metal} stroke="#EEF1F7" strokeWidth={1.2} />
      </g>
    </svg>
  );
};

export const QuestionScene: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = timesQ(A);
  if (f > T.flyB + 30) return null;
  const cam = camAt(A, f);
  const L = rowLayout(A, f);
  const n = Q_TOKENS.length;

  // ---- 打字 ----
  const chars = Q_TOKENS.join('').length;
  const typed = clamp((f - T.typeA) / (T.typeB - T.typeA)) * chars;
  const left = L[0].x - L[0].w / 2;
  const right = L[n - 1].x + L[n - 1].w / 2;
  let caretX = left;
  {
    let acc = 0;
    for (let j = 0; j < n; j++) {
      const len = [...Q_TOKENS[j]].length;
      if (typed >= acc + len) caretX = L[j].x + L[j].w / 2;
      else if (typed > acc) {
        const tw = textW(Q_TOKENS[j], L[j].fs);
        const part = textW([...Q_TOKENS[j]].slice(0, Math.floor(typed - acc)).join(''), L[j].fs);
        caretX = L[j].x - tw / 2 + part;
      }
      acc += len;
    }
  }
  const caretMove = ease.inOut(progress(f, T.typeA - 46, T.typeA - 4));
  const cx = typed <= 0 ? lerp(960, left, caretMove) : caretX;
  const blink = f < T.typeA - 46 || f > T.typeB ? (Math.floor(f / 30) % 2 === 0 ? 1 : 0.2) : 1;
  const H = hookTimes(A);
  const caretO = (1 - progress(f, T.typeB + 40, T.typeB + 60)) * progress(f, H.outB - 12, H.outB + 2);
  const lineGrow = ease.out(progress(f, H.outB - 10, H.outB + 60));
  const lineO = 1 - progress(f, T.tokenize, T.tokenize + 40);
  const askO = vis(f, T.ready - 30, T.ready, T.tokenize - 20, T.tokenize + 10);

  // ---- 剪刀 ----
  const bx = (i: number) => (L[i].x + L[i].w / 2 + L[i + 1].x - L[i + 1].w / 2) / 2;
  let sx = left - 70;
  let open = 1;
  for (let i = 0; i < n - 1; i++) {
    const t0 = T.snip(i) - 22;
    const t1 = T.snip(i) - 2;
    const prevX = i === 0 ? left - 70 : bx(i - 1);
    if (f >= t0) sx = lerp(prevX, bx(i), ease.inOut(progress(f, t0, t1)));
    const d = Math.abs(f - T.snip(i));
    if (d < 9) open = Math.min(open, d / 9);
  }
  const scissorO = vis(f, T.tokenize - 20, T.tokenize + 6, T.snip(n - 2) + 12, T.snip(n - 2) + 34);
  const sy = L[0].y - L[0].h / 2 - 54;

  // ---- 編號說明 / 不一定等於字 ----
  const idNoteO = vis(f, T.ids + 10, T.ids + 40, T.notchar - 34, T.notchar - 12);
  const bracketO = vis(f, T.notchar - 10, T.notchar + 24, T.shrinkA - 10, T.shrinkA + 14);

  // ---- 範例 ----
  const exOut = 1 - progress(f, T.embed - 60, T.embed - 10);
  const exA = progress(f, T.english - 20, T.english + 20) * exOut;
  const exB = progress(f, T.chinese - 24, T.chinese + 14) * exOut;
  const exC = progress(f, T.chinese + 40, T.chinese + 76) * exOut;
  const split = ease.out(progress(f, T.chinese + 110, T.chinese + 150));

  // ---- 向量條 ----
  const fly = (j: number) => progress(f, T.flyA + j * 3, T.flyB + j * 3);
  const collapse = ease.in(progress(f, T.flyA - 26, T.flyA + 2));
  const chipFade = 1 - progress(f, T.flyA - 30, T.flyA);
  const vecNoteO = vis(f, T.vector - 30, T.vector, T.flyA - 30, T.flyA - 5);

  const stripTop = (j: number) => L[j].y + L[j].h / 2 + 16;
  let ci = 0;

  return (
    <div style={{position: 'absolute', inset: 0}}>
      <DotField ox={-cam.cx * 0.15} oy={-cam.cy * 0.15} o={0.5 * chipFade} />
      <HookIntro frame={f} anchors={A} />
      <CameraLayer cam={cam}>
        {lineO > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: 960 - ((right - left) / 2 + 60) * lineGrow,
              width: (right - left + 120) * lineGrow,
              top: L[0].y + 66,
              height: 2,
              background: P.line,
              opacity: lineO,
            }}
          />
        ) : null}
        {askO > 0 ? (
          <div style={{position: 'absolute', left: 0, width: 1920, top: L[0].y - 150, textAlign: 'center', ...type.label, fontSize: 26, color: P.mist, opacity: askO}}>
            你的問題
          </div>
        ) : null}
        {caretO > 0 ? (
          <div style={{position: 'absolute', left: cx + 4, top: L[0].y - 44, width: 5, height: 88, borderRadius: 2, background: P.amber, opacity: caretO * blink}} />
        ) : null}

        {L.map((c, j) => {
          const tok = Q_TOKENS[j];
          const chs = [...tok];
          const front = c.flip < 0.5;
          const rot = c.flip * 180;
          const fillO = c.sep;
          const lift = Math.sin(Math.PI * c.flip) * 10;
          const unfold = ease.out(progress(f, T.embed + 14 + j * 7, T.embed + 64 + j * 7));
          const hl = (j === 4 || j === 5) && bracketO > 0 ? bracketO : 0;
          const startIdx = ci;
          ci += chs.length;
          return (
            <React.Fragment key={j}>
              {c.flip > 0.5 ? (
                <div
                  style={{
                    position: 'absolute',
                    left: c.x - 100,
                    width: 200,
                    top: c.y - c.h / 2 - Math.max(22, c.fs * 0.44) - 14,
                    textAlign: 'center',
                    ...type.title,
                    fontSize: Math.max(22, c.fs * 0.44),
                    lineHeight: 1,
                    color: hl > 0 ? mix(P.mist, P.amber, hl) : P.mist,
                    opacity: progress(c.flip, 0.5, 1) * chipFade,
                  }}
                >
                  {tok}
                </div>
              ) : null}
              <div
                style={{
                  position: 'absolute',
                  left: c.x - c.w / 2,
                  top: c.y - c.h / 2 - lift,
                  width: c.w,
                  height: c.h,
                  transform: `perspective(900px) rotateY(${front ? rot : rot - 180}deg)`,
                  borderRadius: 10,
                  background: `rgba(21,30,51,${0.92 * fillO})`,
                  boxShadow: `inset 0 0 0 1.5px rgba(92,200,255,${0.75 * fillO})${hl > 0 ? `, 0 0 0 2px rgba(255,181,71,${hl})` : ''}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: chipFade,
                }}
              >
                {front ? (
                  chs.map((ch, k) => (
                    <span key={k} style={{...type.title, fontSize: c.fs, color: P.paper, opacity: clamp(typed - (startIdx + k)), lineHeight: 1, letterSpacing: 0}}>
                      {ch}
                    </span>
                  ))
                ) : (
                  <span style={{...type.mono, fontSize: c.fs * 0.47, color: P.amber, letterSpacing: '0.02em'}}>{Q_IDS[j]}</span>
                )}
              </div>
              {unfold > 0 && collapse < 1 ? (
                <div
                  style={{
                    position: 'absolute',
                    left: c.x - 38,
                    top: stripTop(j),
                    width: 76,
                    transformOrigin: '50% 50%',
                    transform: `scaleY(${1 - collapse})`,
                    opacity: 1 - collapse * 0.6,
                  }}
                >
                  {Array.from({length: VEC_N}, (_, k) => {
                    const ck = clamp(unfold * (VEC_N + 1) - k);
                    const v = Q_VECS[j][k];
                    return (
                      <div
                        key={k}
                        style={{
                          height: CELL_H - 4,
                          marginBottom: 4,
                          borderRadius: 4,
                          background: valColor(v * ck),
                          opacity: ck,
                          transform: `translateY(${(1 - ck) * -12}px)`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          ...type.mono,
                          fontSize: 19,
                          color: P.paper,
                        }}
                      >
                        {v.toFixed(2)}
                      </div>
                    );
                  })}
                  <div style={{textAlign: 'center', ...type.title, fontSize: 28, color: P.mist, opacity: clamp(unfold * 2 - 1), lineHeight: 1}}>⋮</div>
                </div>
              ) : null}
            </React.Fragment>
          );
        })}

        {idNoteO > 0 ? (
          <div style={{position: 'absolute', left: 0, width: 1920, top: L[0].y + L[0].h / 2 + 46, textAlign: 'center', ...type.label, fontSize: 24, color: P.mist, opacity: idNoteO}}>
            token 編號為示意，實際依分詞器而定
          </div>
        ) : null}

        {bracketO > 0 ? (
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: bracketO}}>
            {[4, 5].map((j) => {
              const c = L[j];
              const yb = c.y + c.h / 2 + 18;
              return (
                <path
                  key={j}
                  d={`M ${c.x - c.w / 2 + 6} ${yb} L ${c.x - c.w / 2 + 6} ${yb + 12} L ${c.x + c.w / 2 - 6} ${yb + 12} L ${c.x + c.w / 2 - 6} ${yb}`}
                  fill="none"
                  stroke={P.amber}
                  strokeWidth={2}
                />
              );
            })}
            {(() => {
              const mx = (L[4].x + L[5].x) / 2;
              const yb = L[4].y + L[4].h / 2 + 30;
              return (
                <>
                  <path d={`M ${L[4].x} ${yb} Q ${L[4].x} ${yb + 40} ${mx} ${yb + 50} Q ${L[5].x} ${yb + 40} ${L[5].x} ${yb}`} fill="none" stroke={P.amber} strokeWidth={1.4} opacity={0.7} />
                  <line x1={mx} y1={yb + 50} x2={mx} y2={yb + 74} stroke={P.amber} strokeWidth={1.4} opacity={0.7} />
                </>
              );
            })()}
          </svg>
        ) : null}
        {bracketO > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: (L[4].x + L[5].x) / 2 - 400,
              width: 800,
              top: L[4].y + L[4].h / 2 + 112,
              textAlign: 'center',
              opacity: bracketO,
              transform: `translateY(${(1 - bracketO) * 10}px)`,
            }}
          >
            <span style={{...type.title, fontSize: 34, color: P.amber}}>2 個字，只算 1 個 token</span>
          </div>
        ) : null}

        <Examples oA={exA} oB={exB} oC={exC} split={split} />

        {vecNoteO > 0 ? (
          <>
            <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: vecNoteO}}>
              {(() => {
                const yb = stripTop(0) + VEC_N * CELL_H + 44;
                const x0 = L[0].x - 38;
                const x1 = L[n - 1].x + 38;
                return <path d={`M ${x0} ${yb - 12} L ${x0} ${yb} L ${x1} ${yb} L ${x1} ${yb - 12} M 960 ${yb} L 960 ${yb + 16}`} fill="none" stroke={P.ice} strokeWidth={1.5} opacity={0.8} />;
              })()}
            </svg>
            <div
              style={{
                position: 'absolute',
                left: 0,
                width: 1920,
                top: stripTop(0) + VEC_N * CELL_H + 72,
                textAlign: 'center',
                opacity: vecNoteO,
                transform: `translateY(${(1 - vecNoteO) * 10}px)`,
              }}
            >
              <span style={{...type.title, fontSize: 34, color: P.paper}}>向量：</span>
              <span style={{...type.title, fontSize: 30, color: P.mist}}>實際長度有數千個數字</span>
            </div>
          </>
        ) : null}
      </CameraLayer>

      {scissorO > 0 ? (
        <>
          <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
            {Array.from({length: n - 1}, (_, i) => {
              const o = vis(f, T.snip(i) - 2, T.snip(i) + 2, T.snip(i) + 8, T.snip(i) + 34);
              if (o <= 0) return null;
              const p0 = toScreen(cam, bx(i), L[0].y - L[0].h / 2 - 18);
              const p1 = toScreen(cam, bx(i), L[0].y + L[0].h / 2 + 18);
              return <line key={i} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={P.ice} strokeWidth={2} strokeDasharray="6 6" opacity={o} />;
            })}
          </svg>
          {(() => {
            const p = toScreen(cam, sx, sy);
            return <Scissors x={p.x} y={p.y} open={open} o={scissorO} />;
          })()}
        </>
      ) : null}

      {f > T.flyA - 4 ? <FlyDots f={f} A={A} cam={cam} L={L} stripTop={stripTop} fly={fly} T={T} /> : null}

      <SchematicTag o={vis(f, T.ids, T.ids + 30, T.flyA - 30, T.flyA)} />
    </div>
  );
};

const FlyDots: React.FC<{
  f: number;
  A: Anchors;
  cam: Cam2D;
  L: ChipL[];
  stripTop: (j: number) => number;
  fly: (j: number) => number;
  T: ReturnType<typeof timesQ>;
}> = ({f, A, cam, L, stripTop, fly, T}) => {
  const cam3 = buildCamera(embedRig(A)(f));
  return (
    <>
      {L.map((c, j) => {
        const t = fly(j);
        if (t >= 1) return null;
        const s0 = toScreen(cam, c.x, stripTop(j) + (VEC_N * CELL_H) / 2);
        const tgt = project(cam3, qTokenPos(A, j, f));
        const e = ease.inOut(t);
        const arc = Math.sin(Math.PI * e) * -110;
        const x = lerp(s0.x, tgt.x, e);
        const y = lerp(s0.y, tgt.y, e) + arc;
        const r = lerp(11, 7, e);
        const o = progress(f, T.flyA - 4, T.flyA + 4) * (1 - progress(t, 0.85, 1));
        return (
          <div
            key={j}
            style={{position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: r, background: P.ice, boxShadow: `0 0 14px ${P.ice}`, opacity: o}}
          />
        );
      })}
    </>
  );
};
