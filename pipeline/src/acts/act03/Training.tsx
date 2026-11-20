import React, {useMemo} from 'react';
import {palette as P} from '../../theme/palette';
import {clamp, ease, keyframes, lerp, progress} from '../../lib/anim';
import {A3, Bracket, fmt, hash01, mix, MONO, SANS, tint} from './common';
import {TRAIN_RECT} from './Scale';

/**
 * 段落 7–9：訓練迴圈（猜下一個字 → 比對 → 誤差回傳 → 權重微調），
 * 拉遠看見大量文字與 GPU 牆；訓練完成權重凍結；推理只往前算；
 * 最後權重場展開成有結構的熱圖（學到的規律，而不是一條條答案）。
 */
const N = 6;
const CELL = TRAIN_RECT.w / N; // 96
const MCX = TRAIN_RECT.x + TRAIN_RECT.w / 2; // 960
const MCY = TRAIN_RECT.y + TRAIN_RECT.h / 2; // 450
const SNIP_X = 150;
const SNIP_Y = MCY;
const GX = 1450;
const HM_C = 44;
const HM_R = 22;
const HM_CELL = 33;

type Cycle = {snip: string; truth: string; guess: string; tS: number; tF0: number; tF1: number; tT: number; tB0: number; tB1: number; typing: boolean};

const FAST = [
  {snip: '一閃一閃亮', truth: '晶', guess: '光'},
  {snip: '春眠不覺', truth: '曉', guess: '曉'},
  {snip: '今天天氣很', truth: '好', guess: '熱'},
  {snip: '謝謝你的幫', truth: '忙', guess: '忙'},
  {snip: '早安，吃飽了', truth: '嗎', guess: '嗎'},
];

const RIVER = [
  '從前從前，有一座小鎮，鎮上住著一位很會做麵包的師傅……',
  '光合作用是植物利用陽光、水和二氧化碳製造養分的過程。',
  '請把下列句子翻譯成英文：今天的會議改到下午三點。',
  '第一章　夜裡下起了雨，街角的燈一盞一盞亮起來。',
  'def add(a, b):  return a + b    # 兩數相加',
  '地球繞太陽一圈大約需要 365 天，所以一年有 365 天。',
  '他打開窗戶，深深吸了一口氣，決定重新開始。',
  '問：為什麼天空是藍色的？　答：因為大氣會散射藍光……',
  '食譜：番茄炒蛋。先把蛋打散，熱鍋下油……',
  '新聞快訊：本週末北部地區有機會出現短暫陣雨。',
];

const CARDS = [
  ['問：台灣最高峰？', '答：玉山'],
  ['問：水的沸點？', '答：100°C'],
  ['問：一年有幾天？', '答：365 天'],
  ['問：太陽系最大行星？', '答：木星'],
  ['問：1 + 1 = ？', '答：2'],
  ['問：「謝謝」的英文？', '答：thank you'],
];

const heatVal = (c: number, r: number, f: number) => {
  const x = c / HM_C;
  const y = r / HM_R;
  const g1 = Math.exp(-((x - 0.28) ** 2 + (y - 0.4) ** 2) / 0.05);
  const g2 = Math.exp(-((x - 0.72) ** 2 + (y - 0.58) ** 2) / 0.045);
  const g3 = Math.exp(-((x - 0.5) ** 2 + (y - 0.15) ** 2) / 0.03);
  const drift = f / 240;
  return clamp(
    0.95 * g1 * Math.sin(2 * Math.PI * (2.2 * x + 0.9 * y) + 0.4 + drift) +
      0.95 * g2 * Math.sin(2 * Math.PI * (-1.1 * x + 2.6 * y) + 1.3 - drift) +
      0.8 * g3 * Math.cos(2 * Math.PI * 4 * x + drift * 0.5) +
      0.28 * Math.sin(2 * Math.PI * (0.7 * x - 0.5 * y) + drift * 0.7) * Math.cos(2 * Math.PI * 1.5 * y) +
      0.18 * (hash01(c * 101 + r, 77) - 0.5),
    -1,
    1,
  );
};

export const Training: React.FC<{frame: number; A: A3}> = ({frame: f, A}) => {
  const baseVals = useMemo(() => Array.from({length: N * N}, (_, q) => (hash01(q, 51) + hash01(q, 52) + hash01(q, 53) - 1.5) * 1.5), []);

  const cycles: Cycle[] = useMemo(() => {
    const tT = A.guess + 28;
    const main: Cycle = {
      snip: '我喜歡喝咖',
      truth: '啡',
      guess: '哩',
      tS: A.train - 4,
      tF0: A.guess - 80,
      tF1: A.guess - 10,
      tT,
      tB0: Math.min(tT + 14, A.adjust - 22),
      tB1: A.adjust,
      typing: true,
    };
    const FC0 = A.adjust + 56;
    const Pd = (A.freeze - 70 - FC0) / FAST.length;
    const fast = FAST.map((c, i) => {
      const b = FC0 + i * Pd;
      return {...c, tS: b, tF0: b + 0.06 * Pd, tF1: b + 0.34 * Pd, tT: b + 0.42 * Pd, tB0: b + 0.5 * Pd, tB1: b + 0.78 * Pd, typing: false};
    });
    return [main, ...fast];
  }, [A]);

  if (f < A.train - 45) return null;

  const PS = A.l9;
  const appear = progress(f, A.train - 42, A.train - 8);
  const uiFade = 1 - progress(f, PS - 20, PS + 20);
  const trainingOn = f < A.freeze - 60;
  const cur = trainingOn ? [...cycles].reverse().find((c) => f >= c.tS) : undefined;

  // 權重值：每次猜錯 → 微調
  const vals = baseVals.map((v, q) => {
    let out = v;
    cycles.forEach((c, ci) => {
      if (c.guess === c.truth) return;
      out += (hash01(q * 13 + ci, 61) - 0.5) * 0.09 * ease.inOut(progress(f, c.tB1, c.tB1 + 22));
    });
    return out;
  });
  const adjFlash = cycles.reduce((m, c) => (c.guess === c.truth ? m : Math.max(m, progress(f, c.tB1 - 2, c.tB1 + 4) * (1 - progress(f, c.tB1 + 14, c.tB1 + 34)))), 0);

  // 拉遠看見 GPU 牆
  const FC0 = cycles[1].tS;
  const zo = keyframes(f, [
    {f: FC0 - 4, v: 1},
    {f: FC0 + 44, v: 0.6, ease: ease.camera},
    {f: A.freeze - 80, v: 0.56, ease: ease.inOutSoft},
    {f: A.freeze - 14, v: 1, ease: ease.camera},
  ]);
  const wallT = clamp((1 - zo) / 0.4);
  const riverT = (0.16 + 0.22 * wallT) * progress(f, A.train + 20, A.train + 60) * (1 - progress(f, A.freeze - 60, A.freeze - 20));

  // 凍結、推理
  const frostT = ease.inOut(progress(f, A.freeze - 16, A.freeze + 40));
  const lockT = ease.out(progress(f, A.freeze + 6, A.freeze + 36));
  const infOn = f >= A.inference - 14;
  const Q = (PS - 20 - (A.inference - 10)) / 3;
  const OUTS = ['很', '好', '。'];
  const infK = infOn ? Math.min(2, Math.floor((f - (A.inference - 10)) / Q)) : -1;
  const infU = infOn ? (f - (A.inference - 10 + infK * Q)) / Q : 0;

  // 規律
  const shrink = ease.camera(progress(f, PS + 80, PS + 170));
  const mScale = lerp(1, HM_CELL / CELL, shrink);
  const heatR = lerp(0, 1100, ease.inOutSoft(progress(f, PS + 100, A.patterns + 10)));
  const matFade = 1 - progress(f, PS + 150, PS + 190);

  // ---- 目前的資料流脈衝 ----
  let fwdU = -1;
  let fwdColor: string = P.ice;
  if (cur && f >= cur.tF0 && f <= cur.tF1 + 4) fwdU = progress(f, cur.tF0, cur.tF1);
  if (infOn && infK >= 0 && infU < 0.6 && uiFade > 0) {
    fwdU = clamp(infU / 0.55);
    fwdColor = P.ice;
  }
  const pathPt = (u: number) => {
    // 片段：文字尾端 → 矩陣 → 穿過 → 輸出
    const xs = [600, TRAIN_RECT.x - 10, TRAIN_RECT.x + TRAIN_RECT.w + 10, GX - 70];
    const segs = [0.18, 0.82, 1];
    if (u < segs[0]) return {x: lerp(xs[0], xs[1], u / segs[0]), y: MCY};
    if (u < segs[1]) return {x: lerp(xs[1], xs[2], (u - segs[0]) / (segs[1] - segs[0])), y: MCY};
    return {x: lerp(xs[2], xs[3], (u - segs[1]) / (1 - segs[1])), y: MCY};
  };
  const fp = fwdU >= 0 ? pathPt(fwdU) : null;

  // 誤差脈衝（只在猜錯時）
  let backU = -1;
  if (cur && cur.guess !== cur.truth && f >= cur.tB0 && f <= cur.tB1) backU = progress(f, cur.tB0, cur.tB1);
  const backPath = `M ${GX} 330 L ${GX} 112 L ${MCX} 112 L ${MCX} ${TRAIN_RECT.y - 14}`;
  const backPt = (u: number) => {
    const L1 = 330 - 112;
    const L2 = GX - MCX;
    const L3 = TRAIN_RECT.y - 14 - 112;
    const d = u * (L1 + L2 + L3);
    if (d < L1) return {x: GX, y: 330 - d};
    if (d < L1 + L2) return {x: GX - (d - L1), y: 112};
    return {x: MCX, y: 112 + (d - L1 - L2)};
  };
  const bp = backU >= 0 ? backPt(backU) : null;
  const backPathT = trainingOn ? progress(f, cycles[0].tB0 - 10, cycles[0].tB0 + 6) * (1 - progress(f, A.freeze - 80, A.freeze - 50)) : 0;

  // 片段文字
  let snipText = '';
  let showBlank = false;
  let blankFill = '';
  let guessChar = '';
  let guessT = 0;
  let truthT = 0;
  let correct = false;
  if (cur) {
    const n = cur.typing ? clamp(Math.floor((f - cur.tS) / 9), 0, cur.snip.length) : cur.snip.length;
    snipText = cur.snip.slice(0, n);
    showBlank = n === cur.snip.length;
    guessT = ease.out(progress(f, cur.tF1 - 2, cur.tF1 + 8));
    guessChar = cur.guess;
    truthT = ease.out(progress(f, cur.tT, cur.tT + 10));
    correct = cur.guess === cur.truth;
    blankFill = truthT > 0.5 ? cur.truth : '';
  } else if (infOn) {
    const appended = OUTS.slice(0, Math.max(0, infK + (infU > 0.8 ? 1 : 0))).join('');
    snipText = '今天天氣' + appended;
    showBlank = true;
    guessChar = infK >= 0 ? OUTS[infK] : '';
    guessT = infK >= 0 ? ease.out(progress(infU, 0.55, 0.65)) * (1 - progress(infU, 0.85, 0.98)) : 0;
  }
  const modeT = progress(f, A.inference - 30, A.inference); // 訓練 → 推理 標題

  // 正在被脈衝穿過的欄
  const sweepCol = fp && fp.x > TRAIN_RECT.x && fp.x < TRAIN_RECT.x + TRAIN_RECT.w ? (fp.x - TRAIN_RECT.x) / CELL : -10;

  return (
    <div style={{position: 'absolute', inset: 0, opacity: appear}}>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <radialGradient id="a3loopBack" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor={P.ink} stopOpacity="0.92" />
            <stop offset="0.7" stopColor={P.ink} stopOpacity="0.75" />
            <stop offset="1" stopColor={P.ink} stopOpacity="0" />
          </radialGradient>
          <linearGradient id="a3riverFade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.25" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.85" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id="a3mclip">
            <rect x={TRAIN_RECT.x} y={TRAIN_RECT.y} width={TRAIN_RECT.w} height={TRAIN_RECT.h} />
          </clipPath>
          <mask id="a3riverMask">
            <rect x={-200} y={0} width={780} height={1080} fill="url(#a3riverFade)" />
          </mask>
          <linearGradient id="a3frost" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={P.ice} stopOpacity="0" />
            <stop offset="0.45" stopColor={P.ice} stopOpacity="0" />
            <stop offset="0.5" stopColor="#DFF4FF" stopOpacity="0.55" />
            <stop offset="0.55" stopColor={P.ice} stopOpacity="0" />
            <stop offset="1" stopColor={P.ice} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* GPU 牆（大量運算資源，示意） */}
        {wallT > 0.01 ? <GpuWall f={f} t={wallT} /> : null}

        <g transform={`translate(${MCX} ${MCY}) scale(${zo}) translate(${-MCX} ${-MCY})`}>
          {wallT > 0.01 ? <ellipse cx={MCX} cy={MCY} rx={1500} ry={720} fill="url(#a3loopBack)" opacity={wallT} /> : null}

          {/* 大量文字流入 */}
          {riverT > 0.01 ? (
            <g mask="url(#a3riverMask)" opacity={riverT}>
              {RIVER.map((s, i) => {
                const y = 190 + i * 62 + (i % 2) * 8;
                const speed = 2.2 + hash01(i, 5) * 1.6;
                const x = -900 + ((f * speed * (1 + wallT * 1.5) + i * 397) % 1500);
                if (Math.abs(y - SNIP_Y) < 40) return null;
                return (
                  <text key={i} x={x} y={y} fontFamily={i === 4 ? MONO : SANS} fontSize={22} fill={P.mist} dominantBaseline="central">
                    {s}
                  </text>
                );
              })}
            </g>
          ) : null}

          {/* 輸入片段 */}
          <g opacity={uiFade}>
            <text x={SNIP_X} y={SNIP_Y} fontFamily={SANS} fontSize={46} fontWeight={600} fill={P.paper} dominantBaseline="central" letterSpacing="0.04em">
              {snipText}
              {showBlank ? (
                <tspan fill={blankFill ? P.mint : P.mist} dx={6}>
                  {blankFill || '＿'}
                </tspan>
              ) : null}
            </text>
            <Arrow x1={590} x2={TRAIN_RECT.x - 22} y={MCY} color={P.ice} t={progress(f, A.train, A.train + 30)} glow={infOn ? 0.6 : 0} />
            <Arrow x1={TRAIN_RECT.x + TRAIN_RECT.w + 22} x2={GX - 80} y={MCY} color={P.ice} t={progress(f, A.train + 10, A.train + 40)} glow={infOn ? 0.6 : 0} />
          </g>

          {/* 權重矩陣 */}
          <g opacity={matFade} transform={`translate(${MCX} ${MCY}) scale(${mScale}) translate(${-MCX} ${-MCY})`}>
            <Bracket x={TRAIN_RECT.x - 14} y1={TRAIN_RECT.y - 10} y2={TRAIN_RECT.y + TRAIN_RECT.h + 10} side="l" color={mix(P.paper, P.ice, frostT)} t={progress(f, A.train - 20, A.train + 10)} opacity={1 - shrink} />
            <Bracket x={TRAIN_RECT.x + TRAIN_RECT.w + 14} y1={TRAIN_RECT.y - 10} y2={TRAIN_RECT.y + TRAIN_RECT.h + 10} side="r" color={mix(P.paper, P.ice, frostT)} t={progress(f, A.train - 20, A.train + 10)} opacity={1 - shrink} />
            {vals.map((v, q) => {
              const i = Math.floor(q / N);
              const j = q % N;
              const x = TRAIN_RECT.x + j * CELL;
              const y = TRAIN_RECT.y + i * CELL;
              const sweep = Math.max(0, 1 - Math.abs(sweepCol - (j + 0.5)) / 1.2);
              const flash = adjFlash * (0.5 + 0.5 * hash01(q, 9));
              const cIn = ease.out(progress(f, A.train - 30 + (i + j) * 2, A.train - 6 + (i + j) * 2));
              const hv = heatVal(j + (HM_C - N) / 2, i + (HM_R - N) / 2, f);
              const fillCol = shrink > 0 ? mix(v >= 0 ? P.amber : P.ice, hv >= 0 ? P.amber : P.ice, shrink, 1) : tint(v, 1.5);
              const fillA = lerp(0.2 + 0.18 * Math.min(1, Math.abs(v) / 1.5) + 0.25 * sweep + 0.35 * flash, 0.15 + 0.75 * Math.abs(hv), shrink);
              return (
                <g key={q} opacity={cIn}>
                  <rect x={x + 4} y={y + 4} width={CELL - 8} height={CELL - 8} rx={8} fill={fillCol} fillOpacity={fillA} stroke={mix(P.mist, P.ice, frostT)} strokeOpacity={0.25 + 0.5 * frostT + 0.4 * flash} strokeWidth={1.5} />
                  {frostT > 0 ? (
                    <path d={`M ${x + 10} ${y + 22} L ${x + 22} ${y + 10} M ${x + CELL - 10} ${y + CELL - 26} L ${x + CELL - 26} ${y + CELL - 10} M ${x + 10} ${y + 36} L ${x + 36} ${y + 10}`} stroke="#DFF4FF" strokeWidth={1.2} opacity={0.45 * frostT * (1 - shrink)} />
                  ) : null}
                  <text x={x + CELL / 2} y={y + CELL / 2} fontFamily={MONO} fontSize={25} fontWeight={600} fill={flash > 0.2 ? mix(P.paper, P.amber, 0.4) : mix(P.paper, P.ice, frostT * 0.4)} opacity={(1 - shrink) * (0.75 + 0.25 * flash)} textAnchor="middle" dominantBaseline="central">
                    {fmt(v, 2)}
                  </text>
                </g>
              );
            })}
            {/* 凍結掃光 */}
            {frostT > 0 && frostT < 1 ? (
              <g clipPath="url(#a3mclip)">
                <rect x={TRAIN_RECT.x} y={TRAIN_RECT.y} width={TRAIN_RECT.w} height={TRAIN_RECT.h} fill="url(#a3frost)" transform={`translate(${lerp(-620, 620, frostT)} ${lerp(-620, 620, frostT)})`} />
              </g>
            ) : null}
          </g>

          {/* 正向脈衝 */}
          {fp && uiFade > 0 ? (
            <g opacity={uiFade}>
              <circle cx={fp.x} cy={fp.y} r={22} fill={fwdColor} opacity={0.18} />
              <circle cx={fp.x} cy={fp.y} r={9} fill={fwdColor} />
            </g>
          ) : null}

          {/* 猜測與比對 */}
          <g opacity={uiFade}>
            {guessT > 0 ? (
              <g opacity={guessT}>
                <text x={GX} y={355} fontFamily={SANS} fontSize={24} fontWeight={600} letterSpacing="0.1em" fill={P.mist} textAnchor="middle">
                  {infOn && !cur ? '輸出' : '猜'}
                </text>
                <text x={GX} y={MCY} fontFamily={SANS} fontSize={84} fontWeight={700} fill={P.ice} textAnchor="middle" dominantBaseline="central" transform={`translate(0 ${(1 - guessT) * 10})`}>
                  {guessChar}
                </text>
              </g>
            ) : null}
            {cur && truthT > 0 ? (
              <g opacity={truthT}>
                <text x={GX} y={575} fontFamily={SANS} fontSize={24} fontWeight={600} letterSpacing="0.1em" fill={P.mist} textAnchor="middle">
                  正確
                </text>
                <text x={GX} y={640} fontFamily={SANS} fontSize={60} fontWeight={700} fill={P.paper} textAnchor="middle" dominantBaseline="central">
                  {cur.truth}
                </text>
                <Mark x={GX + 110} y={MCY} ok={correct} t={truthT} />
              </g>
            ) : null}
          </g>

          {/* 誤差回傳 */}
          {backPathT > 0 ? (
            <g opacity={backPathT * uiFade}>
              <path d={backPath} fill="none" stroke={P.amberDeep} strokeWidth={2} strokeDasharray="6 8" opacity={0.6} />
              <text x={(GX + MCX) / 2} y={94} fontFamily={SANS} fontSize={24} fontWeight={600} letterSpacing="0.1em" fill={P.amber} textAnchor="middle">
                誤差 → 微調權重
              </text>
            </g>
          ) : null}
          {bp ? (
            <g>
              <circle cx={bp.x} cy={bp.y} r={20} fill={P.amber} opacity={0.2} />
              <circle cx={bp.x} cy={bp.y} r={8} fill={P.amber} />
            </g>
          ) : null}
        </g>

        {/* 鎖：權重固定 */}
        {lockT > 0 ? (
          <g opacity={lockT * uiFade} transform={`translate(${TRAIN_RECT.x + TRAIN_RECT.w + 46} ${TRAIN_RECT.y - 40 - (1 - lockT) * 14})`}>
            <path d="M -13 0 L -13 -12 A 13 13 0 0 1 13 -12 L 13 0" fill="none" stroke={P.ice} strokeWidth={4} strokeLinecap="round" />
            <rect x={-20} y={-2} width={40} height={32} rx={6} fill={P.ice} />
            <circle cx={0} cy={12} r={4} fill={P.ink} />
            <text x={34} y={12} fontFamily={SANS} fontSize={28} fontWeight={700} letterSpacing="0.06em" fill={P.ice} dominantBaseline="central">
              權重固定
            </text>
          </g>
        ) : null}
        {infOn ? (
          <text x={MCX} y={812} fontFamily={SANS} fontSize={28} fontWeight={600} letterSpacing="0.08em" fill={P.paper} textAnchor="middle" opacity={progress(f, A.inference, A.inference + 24) * uiFade}>
            <tspan fill={P.ice}>只往前算</tspan>
            <tspan fill={P.mist} dx={18}>·</tspan>
            <tspan dx={18}>權重不變</tspan>
          </text>
        ) : null}

        {/* 一條條答案卡 → 消散 */}
        {f > PS - 10 && f < PS + 140 ? <AnswerCards f={f} PS={PS} /> : null}

        {/* 規律熱圖 */}
        {heatR > 0 ? <HeatMap f={f} R={heatR} /> : null}
        {f > A.patterns - 40 ? (
          <text x={MCX} y={858} fontFamily={SANS} fontSize={30} fontWeight={700} letterSpacing="0.1em" fill={P.paper} textAnchor="middle" opacity={ease.out(progress(f, A.patterns - 30, A.patterns + 6))}>
            學到的<tspan fill={P.amber}>規律</tspan>
            <tspan fill={P.mist} fontSize={22} fontWeight={500} dx={10}>
              （示意圖）
            </tspan>
          </text>
        ) : null}
      </svg>

      {/* 段落標題：訓練 → 推理 */}
      <div style={{position: 'absolute', left: 150, top: 92, opacity: uiFade * progress(f, A.train, A.train + 24) * (1 - wallT)}}>
        <div style={{position: 'absolute', whiteSpace: 'nowrap', opacity: 1 - modeT, fontFamily: SANS, fontWeight: 700, fontSize: 48, letterSpacing: '0.08em', color: P.amber}}>
          訓練 <span style={{fontSize: 24, color: P.mist, fontWeight: 500, letterSpacing: '0.04em'}}>training</span>
        </div>
        <div style={{position: 'absolute', whiteSpace: 'nowrap', opacity: modeT, fontFamily: SANS, fontWeight: 700, fontSize: 48, letterSpacing: '0.08em', color: P.ice}}>
          推理 <span style={{fontSize: 24, color: P.mist, fontWeight: 500, letterSpacing: '0.04em'}}>inference</span>
        </div>
      </div>
    </div>
  );
};

const Arrow: React.FC<{x1: number; x2: number; y: number; color: string; t: number; glow: number}> = ({x1, x2, y, color, t, glow}) => {
  if (t <= 0) return null;
  const xe = lerp(x1, x2, ease.out(t));
  return (
    <g opacity={0.55 + 0.45 * glow}>
      <line x1={x1} y1={y} x2={xe} y2={y} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      <path d={`M ${xe - 12} ${y - 9} L ${xe} ${y} L ${xe - 12} ${y + 9}`} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
};

const Mark: React.FC<{x: number; y: number; ok: boolean; t: number}> = ({x, y, ok, t}) =>
  ok ? (
    <path d={`M ${x - 22} ${y} L ${x - 6} ${y + 16} L ${x + 24} ${y - 18}`} fill="none" stroke={P.mint} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - t} />
  ) : (
    <g stroke={P.amberDeep} strokeWidth={6} strokeLinecap="round">
      <line x1={x - 18} y1={y - 18} x2={x - 18 + 36 * t} y2={y - 18 + 36 * t} />
      <line x1={x + 18} y1={y - 18} x2={x + 18 - 36 * t} y2={y - 18 + 36 * t} />
    </g>
  );

const GpuWall: React.FC<{f: number; t: number}> = ({f, t}) => {
  const cols = 10;
  const rows = 8;
  const pw = 176;
  const ph = 88;
  const ox = 960 - (cols * pw) / 2;
  const oy = 540 - (rows * ph) / 2 - 40;
  const s = 1.12 - 0.12 * t;
  return (
    <g opacity={0.6 * t} transform={`translate(960 500) scale(${s}) translate(-960 -500)`}>
      {Array.from({length: cols * rows}, (_, q) => {
        const c = q % cols;
        const r = Math.floor(q / cols);
        const x = ox + c * pw + 8;
        const y = oy + r * ph + 8;
        const rot = (f * (6 + hash01(q, 2) * 3) + q * 37) % 360;
        const led = (Math.floor(f / 6 + hash01(q, 4) * 10) % 5) > 1;
        return (
          <g key={q}>
            <rect x={x} y={y} width={pw - 16} height={ph - 16} rx={6} fill="#1A2234" stroke={P.metalLight} strokeWidth={1.2} />
            <rect x={x + 6} y={y + ph - 26} width={pw - 28} height={4} rx={2} fill={P.gold} opacity={0.5} />
            {[0, 1].map((k) => {
              const fx = x + 38 + k * 56;
              const fy = y + 30;
              return (
                <g key={k}>
                  <circle cx={fx} cy={fy} r={19} fill="#0E1422" stroke={P.metal} strokeWidth={2} />
                  {[0, 120, 240].map((a) => (
                    <line
                      key={a}
                      x1={fx}
                      y1={fy}
                      x2={fx + 15 * Math.cos(((a + rot) * Math.PI) / 180)}
                      y2={fy + 15 * Math.sin(((a + rot) * Math.PI) / 180)}
                      stroke={P.metalLight}
                      strokeWidth={3}
                      strokeLinecap="round"
                    />
                  ))}
                </g>
              );
            })}
            <circle cx={x + pw - 30} cy={y + 18} r={3.5} fill={led ? P.mint : P.metal} />
            <circle cx={x + pw - 30} cy={y + 32} r={3.5} fill={hash01(q, Math.floor(f / 9)) > 0.5 ? P.amber : P.metal} />
          </g>
        );
      })}
      <text x={960} y={oy - 14} fontFamily={SANS} fontSize={26} fontWeight={600} letterSpacing="0.1em" fill={P.paper} textAnchor="middle" opacity={0.9}>
        大量 GPU 長時間運算
      </text>
    </g>
  );
};

const AnswerCards: React.FC<{f: number; PS: number}> = ({f, PS}) => (
  <g>
    {CARDS.map(([q, a], i) => {
      const ang = (i / CARDS.length) * Math.PI * 2 + 0.4;
      const tx = 960 + Math.cos(ang) * 470;
      const ty = 450 + Math.sin(ang) * 250;
      const sx = 960 + Math.cos(ang) * 1300;
      const sy = 450 + Math.sin(ang) * 800;
      const inT = ease.out(progress(f, PS - 6 + i * 5, PS + 44 + i * 5));
      const strike = ease.out(progress(f, PS + 50 + i * 3, PS + 66 + i * 3));
      const out = ease.in(progress(f, PS + 78 + i * 4, PS + 118 + i * 4));
      if (inT <= 0 || out >= 1) return null;
      const x = lerp(sx, tx, inT);
      const y = lerp(sy, ty, inT) - out * 20;
      const w = 280;
      const h = 112;
      return (
        <g key={i} opacity={inT * (1 - out)} transform={`translate(${x} ${y}) rotate(${(hash01(i, 3) - 0.5) * 8}) scale(${1 - 0.15 * out})`}>
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={6} fill={P.paper} opacity={0.94} />
          <text x={-w / 2 + 20} y={-16} fontFamily={SANS} fontSize={24} fontWeight={600} fill={P.ink} dominantBaseline="central">
            {q}
          </text>
          <text x={-w / 2 + 20} y={22} fontFamily={SANS} fontSize={24} fontWeight={500} fill={P.wallLight} dominantBaseline="central">
            {a}
          </text>
          <line x1={-w / 2 + 12} y1={0} x2={-w / 2 + 12 + (w - 24) * strike} y2={0} stroke={P.amberDeep} strokeWidth={5} strokeLinecap="round" />
        </g>
      );
    })}
  </g>
);

const HeatMap: React.FC<{f: number; R: number}> = ({f, R}) => {
  const ox = 960 - (HM_C * HM_CELL) / 2;
  const oy = MCY - (HM_R * HM_CELL) / 2;
  return (
    <g>
      {Array.from({length: HM_C * HM_R}, (_, q) => {
        const c = q % HM_C;
        const r = Math.floor(q / HM_C);
        const x = ox + c * HM_CELL;
        const y = oy + r * HM_CELL;
        const d = Math.hypot(x + HM_CELL / 2 - 960, (y + HM_CELL / 2 - MCY) * 1.4);
        const vis = clamp((R - d) / 140);
        if (vis <= 0) return null;
        const v = heatVal(c, r, f);
        const a = (0.12 + 0.8 * Math.abs(v)) * vis;
        return <rect key={q} x={x + 1.5} y={y + 1.5} width={HM_CELL - 3} height={HM_CELL - 3} rx={3} fill={v >= 0 ? P.amber : P.ice} opacity={a} />;
      })}
    </g>
  );
};
