import React from 'react';
import {clamp, ease, lerp, progress, rng, tween} from '../../lib/anim';
import {A, an, env, MONO, P, Txt, fontStack} from './common';

/**
 * 站點 1：一個權重數值 → FP32 位元（1/8/23）→ FP16（1/5/10），長條在「減半」時實際縮成一半。
 * 位元皆為真實 IEEE-754 編碼：
 *   0.7312 → FP32 0 01111110 01110110010111111101100（實存 0.731199979…）
 *            FP16 0 01110 0111011001（實存 0.730957…）
 */
const FP32 = '00111111001110110010111111101100';
const FP16 = '0011100111011001';
const PITCH = 46;
const CW = 40;
const CH = 66;
const X0 = 960 - (32 * PITCH - (PITCH - CW)) / 2;
const Y32 = 400;
const Y16 = 660;

const segColor = (i: number, fmt: 32 | 16) => {
  const e = fmt === 32 ? 8 : 5;
  if (i === 0) return P.mint;
  if (i <= e) return P.ice;
  return P.amber;
};

// FP16 列：從 32 格收合成 16 格。保留：符號 0、指數 1..5、尾數 9..18
const keep16 = (i: number) => i === 0 || (i >= 1 && i <= 5) || (i >= 9 && i <= 18);
const idx16 = (i: number) => (i === 0 ? 0 : i <= 5 ? i : i >= 9 && i <= 18 ? i - 3 : -1);

const Cell: React.FC<{x: number; y: number; w: number; bit: string; color: string; o: number; textO?: number; lift?: number}> = ({
  x,
  y,
  w,
  bit,
  color,
  o,
  textO = 1,
  lift = 0,
}) => {
  if (o <= 0.001 || w < 0.5) return null;
  const on = bit === '1';
  return (
    <g opacity={o} transform={`translate(0 ${lift})`}>
      <rect x={x} y={y} width={w} height={CH} rx={3} fill={color} fillOpacity={on ? 0.85 : 0.12} stroke={color} strokeOpacity={on ? 1 : 0.55} strokeWidth={1.4} />
      {w > 14 ? (
        <text x={x + w / 2} y={y + CH / 2 + 10} textAnchor="middle" fontFamily={MONO} fontSize={28} fontWeight={600} fill={on ? P.ink : color} opacity={textO}>
          {bit}
        </text>
      ) : null}
    </g>
  );
};

const Bracket: React.FC<{x1: number; x2: number; y: number; color: string; label: string; sub?: string; t: number; up?: boolean}> = ({
  x1,
  x2,
  y,
  color,
  label,
  sub,
  t,
  up,
}) => {
  if (t <= 0.001) return null;
  const k = ease.out(clamp(t));
  const d = up ? -10 : 10;
  const mid = (x1 + x2) / 2;
  const hw = ((x2 - x1) / 2) * k;
  return (
    <g opacity={k}>
      <path d={`M ${mid - hw} ${y} l 0 ${d} L ${mid + hw} ${y + d} l 0 ${-d}`} fill="none" stroke={color} strokeWidth={1.5} />
      <text x={mid} y={up ? y - 22 : y + 44} textAnchor="middle" fontFamily={fontStack} fontSize={24} fontWeight={600} fill={color} letterSpacing="0.06em">
        {label}
        {sub ? (
          <tspan fill={P.mist} fontWeight={500} fontSize={20}>
            {'  '}
            {sub}
          </tspan>
        ) : null}
      </text>
    </g>
  );
};

export const Bits: React.FC<{f: number; anchors: A}> = ({f, anchors}) => {
  const q = an(anchors, 'q', 45);
  const fp32 = an(anchors, 'fp32', 508);
  const fp16 = an(anchors, 'fp16', 807);
  const half = an(anchors, 'half', 911);
  const calc = an(anchors, 'calc', 968);

  // 數字田：一大片權重，中央那一個是主角
  const field = env(f, q - 20, q + 50, fp32 - 150, fp32 - 70);
  const heroLift = tween(f, fp32 - 140, fp32 - 40, 0, 1, ease.camera);
  const heroY = lerp(540, 250, heroLift);
  const heroSize = lerp(64, 76, heroLift);
  const heroOut = 1 - progress(f, calc + 10, calc + 40);

  const r = rng(404);
  const nums: {x: number; y: number; v: string; o: number}[] = [];
  for (let row = -4; row <= 4; row++) {
    for (let col = -6; col <= 6; col++) {
      const v = (r() * 2 - 1) * 0.98;
      if (row === 0 && col === 0) continue;
      const dist = Math.hypot(col / 6, row / 4);
      nums.push({x: 960 + col * 148, y: 540 + row * 92, v: (v >= 0 ? ' ' : '') + v.toFixed(4).replace('-', '−'), o: 0.55 - dist * 0.3});
    }
  }

  // FP32 列
  const t32 = (i: number) => ease.out(progress(f, fp32 - 30 + i * 1.6, fp32 + 6 + i * 1.6));
  const lab32 = progress(f, fp32 + 40, fp32 + 75);
  // FP16 列
  const in16 = ease.out(progress(f, fp16 - 40, fp16 - 4));
  const col16 = ease.inOut(progress(f, fp16 + 10, half + 6)); // 收合
  const lab16 = progress(f, half - 10, half + 30);
  const halfMark = ease.out(progress(f, half - 4, half + 30));

  // 「算算看」：FP16 長條擠成一塊 2 位元組的晶片（之後由鏡頭帶到下一站）
  const squash = ease.inOut(progress(f, calc - 20, calc + 30));
  const allOut = 1 - progress(f, calc + 20, calc + 60);

  const x16 = (() => {
    const xs: number[] = [];
    let x = X0;
    for (let i = 0; i < 32; i++) {
      xs.push(x);
      const w = keep16(i) ? CW : CW * (1 - col16);
      x += w + (PITCH - CW) * (keep16(i) ? 1 : 1 - col16);
    }
    return xs;
  })();
  const w16 = (i: number) => (keep16(i) ? CW : CW * (1 - col16));
  const end32 = X0 + 32 * PITCH - (PITCH - CW);
  const end16 = X0 + 16 * PITCH - (PITCH - CW);
  const end16Now = lerp(end32, end16, col16);

  const row32O = allOut * (1 - squash * 0.65);

  return (
    <>
      {/* 數字田 */}
      {field > 0.001
        ? nums.map((n, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: n.x - 70,
                top: n.y - 18,
                width: 140,
                textAlign: 'center',
                fontFamily: MONO,
                fontSize: 30,
                color: n.v.includes('−') ? P.ice : P.amber,
                opacity: Math.max(0, n.o) * field * (0.55 + 0.45 * Math.sin(f / 50 + i * 1.7) ** 2),
              }}
            >
              {n.v}
            </div>
          ))
        : null}
      {/* 主角數字 */}
      <div
        style={{
          position: 'absolute',
          left: 560,
          top: heroY - heroSize * 0.68,
          width: 800,
          textAlign: 'center',
          fontFamily: MONO,
          fontSize: heroSize,
          fontWeight: 600,
          color: P.amber,
          opacity: heroOut,
          textShadow: '0 0 28px rgba(255,181,71,0.25)',
        }}
      >
        0.7312
      </div>
      <Txt x={960} y={heroY + 62} align="center" size={22} color={P.mist} t={progress(f, q + 30, q + 70) * heroOut * (1 - heroLift)}>
        其中一個權重
      </Txt>

      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        {/* 主角到 FP32 列的細引線 */}
        <line x1={960} y1={heroY + 30} x2={960} y2={Y32 - 14} stroke={P.amber} strokeOpacity={0.4 * t32(16) * heroOut * (1 - squash)} strokeWidth={1.2} strokeDasharray="3 5" />

        {/* FP32 */}
        {FP32.split('').map((b, i) => (
          <Cell key={`a${i}`} x={X0 + i * PITCH} y={Y32} w={CW} bit={b} color={segColor(i, 32)} o={t32(i) * row32O} lift={(1 - t32(i)) * -24} />
        ))}
        <g opacity={allOut * (1 - squash)}>
          <Bracket x1={X0} x2={X0 + CW} y={Y32 + CH + 8} color={P.mint} label="符號" sub="1" t={lab32} />
          <Bracket x1={X0 + PITCH} x2={X0 + 8 * PITCH + CW} y={Y32 + CH + 8} color={P.ice} label="指數" sub="8 位元" t={lab32} />
          <Bracket x1={X0 + 9 * PITCH} x2={end32} y={Y32 + CH + 8} color={P.amber} label="尾數" sub="23 位元" t={lab32} />
        </g>

        {/* FP16 */}
        <g opacity={in16 * allOut} transform={`translate(0 ${(1 - in16) * -80})`}>
          {FP32.split('').map((b32, i) => {
            const k = keep16(i);
            const bit16 = k ? FP16[idx16(i)] : b32;
            // 保留的格子：位元在收合過程中由 FP32 值轉成 FP16 值
            const morph = progress(f, fp16 + 20, half - 10);
            const bit = k ? (morph > 0.5 ? bit16 : b32) : b32;
            const xSq = lerp(x16[i], 960 - 60 + (idx16(i) >= 0 ? idx16(i) : 0) * (120 / 16), squash);
            const wSq = lerp(w16(i), k ? 120 / 16 - 0.5 : 0, squash);
            return (
              <Cell
                key={`b${i}`}
                x={xSq}
                y={lerp(Y16, Y16 + 30, squash)}
                w={wSq}
                bit={bit}
                color={segColor(k ? idx16(i) : i, k ? 16 : 32)}
                o={k ? 1 : 1 - col16}
                textO={(1 - squash) * (k ? 1 - 0.8 * Math.sin(Math.PI * clamp((morph - 0.3) / 0.4)) : 1)}
              />
            );
          })}
        </g>
        <g opacity={allOut * (1 - squash)}>
          <Bracket x1={X0} x2={X0 + CW} y={Y16 + CH + 8} color={P.mint} label="符號" sub="1" t={lab16} />
          <Bracket x1={X0 + PITCH} x2={X0 + 5 * PITCH + CW} y={Y16 + CH + 8} color={P.ice} label="指數" sub="5" t={lab16} />
          <Bracket x1={X0 + 6 * PITCH} x2={end16} y={Y16 + CH + 8} color={P.amber} label="尾數" sub="10 位元" t={lab16} />
          {/* 減半：尺寸標線 */}
          <g opacity={halfMark}>
            <line x1={end16} y1={Y32 - 8} x2={end16} y2={Y16 + CH + 6} stroke={P.paper} strokeOpacity={0.35} strokeDasharray="4 6" />
            <line x1={end16 + 14} y1={Y16 + CH / 2} x2={lerp(end16 + 14, end32, halfMark)} y2={Y16 + CH / 2} stroke={P.amber} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="2 6" />
            <text x={lerp(end16, end32, 0.5)} y={Y16 + CH / 2 + 22} textAnchor="middle" fontFamily={fontStack} fontWeight={800} fontSize={76} fill={P.amber} opacity={halfMark}>
              ½
            </text>
          </g>
        </g>
        {/* 收合中的右緣 */}
        {col16 > 0 && col16 < 1 ? <line x1={end16Now + 6} y1={Y16 - 6} x2={end16Now + 6} y2={Y16 + CH + 6} stroke={P.amber} strokeWidth={2} opacity={0.7 * in16} /> : null}

        {/* 2 位元組晶片 */}
        {squash > 0.02 ? (
          <g opacity={allOut}>
            <rect x={960 - 64} y={Y16 + 26} width={128} height={CH + 8} rx={6} fill="none" stroke={P.amber} strokeWidth={2} opacity={squash} />
            <text x={960} y={Y16 + 26 + CH + 46} textAnchor="middle" fontFamily={fontStack} fontWeight={600} fontSize={26} fill={P.amber} opacity={squash}>
              1 個參數 ＝ 2 位元組
            </text>
          </g>
        ) : null}
      </svg>
      <div style={{position: 'absolute', inset: 0, opacity: allOut * (1 - squash)}}>
          <Txt x={X0} y={Y32 - 38} size={30} weight={700} t={progress(f, fp32 - 10, fp32 + 20)} color={P.paper}>
            FP32
            <span style={{color: P.mist, fontWeight: 500, fontSize: 22, marginLeft: 18}}>32 位元 ＝ 4 位元組</span>
          </Txt>
          <Txt x={end32} y={Y32 - 38} align="right" size={22} mono color={P.mist} t={lab32}>
            實際存下 0.7311999798…
          </Txt>
          <Txt x={X0} y={Y16 - 38} size={30} weight={700} t={in16} color={P.paper}>
            FP16
            <span style={{color: P.mist, fontWeight: 500, fontSize: 22, marginLeft: 18}}>16 位元 ＝ 2 位元組</span>
          </Txt>
          <Txt x={end32} y={Y16 - 38} align="right" size={22} mono color={P.mist} t={lab16}>
            實際存下 0.7309570…
          </Txt>
      </div>
    </>
  );
};
