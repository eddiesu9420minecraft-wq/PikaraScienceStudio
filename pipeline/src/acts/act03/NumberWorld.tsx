import React, {useMemo} from 'react';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {clamp, ease, keyframes, lerp, progress, tween} from '../../lib/anim';
import {cam2dAt, camTransform} from '../../lib/camera2d';
import {A3, Bracket, fmt, H1, hash01, mix, MONO, SANS, tint, W1, W2, X1, Y1, Y2} from './common';

/**
 * 段落 1–3：答案資料庫 → 數字洪流 → 權重場 → 矩陣 × 向量 → 激活 → 下一層。
 * 全部在同一個 SVG 世界裡，數字 token 從抽屜流出、落入權重場、再被挑出排成矩陣。
 */

// ---------------- 檔案櫃 ----------------
const COLS = 7;
const ROWS = 5;
const DW = 210;
const DH = 118;
const GAP = 14;
const CAB_W = COLS * DW + (COLS - 1) * GAP;
const CAB_H = ROWS * DH + (ROWS - 1) * GAP;
const CX = 960;
const CY = 470;
const X0 = CX - CAB_W / 2;
const Y0 = CY - CAB_H / 2;
const CENTER = 17;

const TOPICS = [
  '天氣', '數學', '歷史', '食譜', '翻譯', '程式', '地理',
  '醫學', '法律', '詩詞', '物理', '化學', '音樂', '電影',
  '旅遊', '運動', '經濟', '所有答案？', '天文', '生物', '語言',
  '哲學', '藝術', '心理', '動物', '植物', '科技', '新聞',
  '遊戲', '笑話', '名言', '百科', '常識', '冷知識', '人物',
];
const OPEN = [17, 9, 26, 2, 22, 12, 31];

const drawerXY = (d: number) => ({x: X0 + (d % COLS) * (DW + GAP), y: Y0 + Math.floor(d / COLS) * (DH + GAP)});
const drawerDelay = (d: number) => {
  const {x, y} = drawerXY(d);
  const dist = Math.hypot(x + DW / 2 - CX, (y + DH / 2 - CY) * 1.6);
  return (dist / 900) * 40 + hash01(d, 3) * 12;
};

// ---------------- 數字 token ----------------
const FC = 24;
const FR = 16;
const FPX = 76;
const FPY = 44;
const FCX = 960;
const FCY = 500;
const fieldXY = (c: number, r: number) => ({x: FCX + (c - (FC - 1) / 2) * FPX, y: FCY + (r - (FR - 1) / 2) * FPY});
const MB_R0 = 4;
const MB_C0 = 9;

// 矩陣舞台
const MX = 700;
const MY = 470;
const MCP = 130;
const MRP = 86;
const XV = 1180;
const XP = 72;
const YV = 1400;
const HV = 1690;
const wXY = (i: number, j: number, cols = 5) => ({x: MX + (j - (cols - 1) / 2) * MCP, y: MY + (i - 1.5) * MRP});
const xY = (k: number) => MY + (k - 2) * XP;

type Tok = {
  c: number;
  r: number;
  fx: number;
  fy: number;
  sx: number;
  sy: number;
  qx: number;
  qy: number;
  v: number;
  t0: number;
  dur: number;
  mi: number;
  mj: number;
};

const useTokens = (notdb: number) =>
  useMemo(() => {
    const toks: Tok[] = [];
    for (let i = 0; i < FC * FR; i++) {
      const c = i % FC;
      const r = Math.floor(i / FC);
      const d = (i * 7 + r) % 35;
      const {x: dx, y: dy} = drawerXY(d);
      const sx = dx + DW / 2 + (hash01(i, 1) - 0.5) * (DW - 50);
      const sy = dy + DH / 2 + (hash01(i, 2) - 0.5) * (DH - 40);
      const {x: fx, y: fy} = fieldXY(c, r);
      const mx = (sx + fx) / 2;
      const my = (sy + fy) / 2;
      const len = Math.hypot(fx - sx, fy - sy) + 1;
      const swirl = (hash01(d, 9) - 0.5) * 520 + (hash01(i, 4) - 0.5) * 120;
      const qx = mx + (-(fy - sy) / len) * swirl;
      const qy = my + ((fx - sx) / len) * swirl;
      const inBlock = r >= MB_R0 && r < MB_R0 + 4 && c >= MB_C0 && c < MB_C0 + 5;
      const mi = inBlock ? r - MB_R0 : -1;
      const mj = inBlock ? c - MB_C0 : -1;
      let v = (hash01(i, 5) + hash01(i, 6) + hash01(i, 7) - 1.5) * 1.6;
      if (inBlock) v = W1[mi][mj] + (hash01(i, 8) - 0.5) * 0.09;
      toks.push({c, r, fx, fy, sx, sy, qx, qy, v, t0: notdb - 8 + drawerDelay(d) + hash01(i, 10) * 30, dur: 110 + hash01(i, 11) * 40, mi, mj});
    }
    return toks;
  }, [notdb]);

const BG_COLS = 38;
const BG_ROWS = 26;
const useBgNums = () =>
  useMemo(() => {
    const out: {x: number; y: number; s: string; v: number}[] = [];
    for (let r = 0; r < BG_ROWS; r++)
      for (let c = 0; c < BG_COLS; c++) {
        const i = r * BG_COLS + c;
        const v = (hash01(i, 21) + hash01(i, 22) - 1) * 2.4;
        out.push({x: 960 + (c - (BG_COLS - 1) / 2) * 60 + (r % 2) * 30, y: 500 + (r - (BG_ROWS - 1) / 2) * 38, s: fmt(v, 3), v});
      }
    return out;
  }, []);

const RING = [
  [2, 4],
  [5, 19],
  [11, 2],
  [12, 16],
  [9, 7],
];

export const NumberWorld: React.FC<{frame: number; A: A3}> = ({frame: f, A}) => {
  const toks = useTokens(A.notdb);
  const bg = useBgNums();

  // ---- 攝影機：從中央抽屜拉遠到整座檔案櫃 ----
  const cam = cam2dAt(f, [
    {f: A.hook + 40, v: {cx: CX, cy: CY, zoom: 2.7}},
    {f: A.db - 10, v: {cx: 960, cy: 540, zoom: 1.0}, ease: ease.camera},
    {f: A.notdb, v: {cx: 960, cy: 540, zoom: 0.985}},
    {f: A.numbers, v: {cx: 960, cy: 540, zoom: 1}},
  ]);

  // 場的縮放（推近感），矩陣出現時其他數字飛越鏡頭
  const zf = keyframes(f, [
    {f: A.numbers, v: 1},
    {f: A.matrix - 110, v: 1.08, ease: ease.inOutSoft},
    {f: A.matrix + 20, v: 1.9, ease: ease.camera},
  ]);
  const fieldPos = (x: number, y: number, z = zf) => ({x: FCX + (x - FCX) * z, y: FCY + (y - FCY) * z});

  const cabinetFade = 1 - progress(f, A.notdb + 20, A.notdb + 90);
  const cabIn = ease.inOut(progress(f, A.hook + 46, A.hook + 104));
  const tintT = ease.inOut(progress(f, A.numbers - 60, A.weights));
  const pm = ease.camera(progress(f, A.matrix - 95, A.matrix + 5)); // 矩陣 token 歸位
  const restFade = 1 - 0.96 * ease.inOut(progress(f, A.matrix - 110, A.matrix + 10));
  const endFade = 1 - progress(f, A.nextlayer - 10, A.nextlayer + 40); // 第一層元素退場
  const labelT = ease.out(progress(f, A.weights - 34, A.weights + 6)) * (1 - progress(f, A.matrix - 120, A.matrix - 90));

  // ---- 矩陣乘法時序（以 multiply → nextlayer 的長度伸縮） ----
  const S = A.multiply;
  const k = (A.nextlayer - A.multiply) / 231;
  const at = (o: number) => S + o * k;
  const xIn = (kk: number) => ease.out(progress(f, A.matrix + 30 + kk * 7, A.matrix + 70 + kk * 7));
  const rowStart = (i: number) => (i === 0 ? at(0) : at(80 + (i - 1) * 22));
  const termT = (i: number, j: number) => (i === 0 ? progress(f, at(8 + j * 10), at(14 + j * 10)) : progress(f, rowStart(i), rowStart(i) + 8 * k));
  const sumT = (i: number) => (i === 0 ? progress(f, at(56), at(62)) : progress(f, rowStart(i) + 10 * k, rowStart(i) + 15 * k));
  const yT = (i: number) => ease.out(progress(f, i === 0 ? at(62) : rowStart(i) + 14 * k, (i === 0 ? at(62) : rowStart(i) + 14 * k) + 10));
  const curRow = [3, 2, 1, 0].find((i) => f >= rowStart(i)) ?? -1;
  const rowActive = (i: number) => (curRow === i && f < at(150) ? 1 : 0) * progress(f, rowStart(i), rowStart(i) + 5);
  const lineFade = 1 - progress(f, at(146), at(156));
  const plotT = ease.out(progress(f, at(128), at(158)));
  const hMove = ease.inOut(progress(f, at(164), at(204)));
  const nl = A.nextlayer;
  const shiftT = ease.camera(progress(f, nl - 10, nl + 50));
  const hSlide = ease.camera(progress(f, nl, nl + 50));
  const w2In = ease.out(progress(f, nl + 10, nl + 60));
  const w2RowStart = (i: number) => nl + 64 + i * 12;
  const y2T = (i: number) => ease.out(progress(f, w2RowStart(i) + 8, w2RowStart(i) + 18));
  const stackHand = progress(f, A.transformer - 170, A.transformer - 130); // 交棒給 3D 疊層
  const cellBg = ease.inOut(progress(f, A.transformer - 235, A.transformer - 175));
  const w2Fade = 1 - stackHand;
  const restOfLayer2Fade = 1 - progress(f, A.transformer - 200, A.transformer - 160);

  if (f > A.transformer - 120) return null;

  const fieldOn = f >= A.notdb - 20;

  return (
    <div style={{position: 'absolute', inset: 0}}>
      <div style={{position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transformOrigin: '0 0', transform: camTransform(cam)}}>
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
          <defs>
            <linearGradient id="a3drawer" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1F2B45" />
              <stop offset="1" stopColor="#141C2F" />
            </linearGradient>
            <linearGradient id="a3plate" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2A3758" />
              <stop offset="1" stopColor="#202B47" />
            </linearGradient>
            <radialGradient id="a3spot" cx="0.5" cy="0" r="0.9">
              <stop offset="0" stopColor="#FFD9A0" stopOpacity="0.16" />
              <stop offset="0.6" stopColor="#FFD9A0" stopOpacity="0.03" />
              <stop offset="1" stopColor="#FFD9A0" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="a3floor" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1C2740" stopOpacity="0.8" />
              <stop offset="1" stopColor="#1C2740" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* 背景：微小數字構成的密集紋理（「非常、非常多」） */}
          {f > A.numbers - 80 ? (
            <g
              opacity={0.17 * progress(f, A.numbers - 70, A.numbers + 30) * (1 - 0.7 * progress(f, A.matrix - 90, A.matrix + 10))}
              transform={`translate(${FCX} ${FCY}) scale(${1 + (zf - 1) * 0.45}) translate(${-FCX} ${-FCY})`}
            >
              {bg.map((b, i) => (
                <text key={i} x={b.x} y={b.y} fontFamily={MONO} fontSize={16} fill={tint(b.v, 2.4)} textAnchor="middle" dominantBaseline="central">
                  {b.s}
                </text>
              ))}
            </g>
          ) : null}

          {/* 檔案櫃 */}
          {cabinetFade > 0 && cabIn > 0 ? (
            <g opacity={cabIn}>
              <g opacity={cabinetFade}>
                <rect x={X0 - 34} y={Y0 - 66} width={CAB_W + 68} height={CAB_H + 100} rx={6} fill="#111A2C" stroke={P.line} strokeWidth={2} />
                <rect x={X0 - 34} y={Y0 - 66} width={CAB_W + 68} height={44} rx={6} fill="#18223A" stroke={P.line} strokeWidth={2} />
                <text x={CX} y={Y0 - 43} fontFamily={SANS} fontSize={22} fontWeight={600} letterSpacing="0.5em" fill={P.mist} textAnchor="middle" dominantBaseline="central">
                  答 案 資 料 庫
                </text>
                <rect x={X0 - 34} y={Y0 + CAB_H + 34} width={CAB_W + 68} height={120} fill="url(#a3floor)" opacity={0.5} />
                {/* 左右延伸的櫃子（暗示龐大） */}
                {[-1, 1].map((side) => (
                  <g key={side} opacity={0.35}>
                    {Array.from({length: ROWS * 2}, (_, q) => {
                      const r = q % ROWS;
                      const cc = Math.floor(q / ROWS);
                      const x = side < 0 ? X0 - 60 - (cc + 1) * (DW + GAP) : X0 + CAB_W + 60 + cc * (DW + GAP);
                      return <rect key={q} x={x} y={Y0 + r * (DH + GAP)} width={DW} height={DH} rx={4} fill="url(#a3drawer)" stroke={P.line} />;
                    })}
                  </g>
                ))}
              </g>
              {[0, 1].map((pass) =>
                TOPICS.map((topic, d) => {
                  const oi = OPEN.indexOf(d);
                  const isOpen = oi >= 0;
                  if ((pass === 1) !== isOpen) return null;
                  const {x, y} = drawerXY(d);
                  const pd = ease.inOut(progress(f, A.notdb - 8 + drawerDelay(d), A.notdb + 40 + drawerDelay(d)));
                  if (pd >= 1) return null;
                  const o = isOpen ? ease.out(progress(f, A.db - 34 + oi * 6, A.db + 8 + oi * 6)) * (1 - pd) : 0;
                  const isC = d === CENTER;
                  const glowC = isC ? 0.6 + 0.4 * Math.sin(f / 14) : 0;
                  return (
                    <g key={d} opacity={1 - pd} transform={`translate(0 ${-10 * pd})`}>
                      {isOpen ? (
                        <g>
                          <rect x={x} y={y} width={DW} height={DH} fill="#05080F" />
                          {[0, 1, 2, 3].map((q) => (
                            <rect
                              key={q}
                              x={x + 26 + q * 42}
                              y={y + 6 + (q % 2) * 3}
                              width={34}
                              height={24}
                              rx={2}
                              fill={q === 1 ? P.amber : P.paper}
                              opacity={(q === 1 ? 0.85 : 0.75) * o}
                            />
                          ))}
                        </g>
                      ) : null}
                      <g transform={`translate(${x + DW / 2} ${y + DH / 2 + 24 * o}) scale(${1 + 0.035 * o}) translate(${-(x + DW / 2)} ${-(y + DH / 2)})`}>
                        {o > 0 ? <rect x={x + 4} y={y + 10} width={DW - 8} height={DH} rx={6} fill="#000" opacity={0.35 * o} /> : null}
                        <rect x={x} y={y} width={DW} height={DH} rx={4} fill="url(#a3drawer)" stroke={isC ? P.amber : P.line} strokeWidth={isC ? 2 : 1.5} strokeOpacity={isC ? 0.5 + 0.4 * glowC : 1} />
                        <line x1={x + 6} y1={y + 1.5} x2={x + DW - 6} y2={y + 1.5} stroke="#FFFFFF" strokeOpacity={0.08} />
                        <rect x={x + DW / 2 - 66} y={y + 20} width={132} height={40} rx={3} fill="url(#a3plate)" stroke={isC ? P.amber : P.metalLight} strokeWidth={1.2} />
                        <text
                          x={x + DW / 2}
                          y={y + 41}
                          fontFamily={SANS}
                          fontSize={isC ? 22 : 22}
                          fontWeight={isC ? 700 : 500}
                          fill={isC ? P.amber : P.paper}
                          textAnchor="middle"
                          dominantBaseline="central"
                        >
                          {topic}
                        </text>
                        <rect x={x + DW / 2 - 30} y={y + DH - 30} width={60} height={11} rx={5.5} fill={P.metalLight} />
                        <rect x={x + DW / 2 - 26} y={y + DH - 29} width={52} height={3} rx={1.5} fill="#FFFFFF" opacity={0.25} />
                        <text x={x + 14} y={y + DH - 24} fontFamily={MONO} fontSize={18} fill={P.mist} opacity={0.7} dominantBaseline="central">
                          {String((d * 397 + 128) % 9000).padStart(4, '0')}
                        </text>
                      </g>
                    </g>
                  );
                }),
              )}
              <rect x={X0 - 200} y={Y0 - 160} width={CAB_W + 400} height={CAB_H + 300} fill="url(#a3spot)" opacity={cabinetFade} />
            </g>
          ) : null}

          {/* 數字 token：流出 → 權重場 → 矩陣 */}
          {fieldOn
            ? toks.map((t, i) => {
                if (f < t.t0) return null;
                const isM = t.mi >= 0;
                const pt = progress(f, t.t0, t.t0 + t.dur);
                const e = ease.inOut(pt);
                // 二次貝茲曲線
                const bx = (1 - e) * (1 - e) * t.sx + 2 * (1 - e) * e * t.qx + e * e * t.fx;
                const by = (1 - e) * (1 - e) * t.sy + 2 * (1 - e) * e * t.qy + e * e * t.fy;
                let {x, y} = pt < 1 ? {x: bx, y: by} : fieldPos(t.fx, t.fy);
                if (pt >= 1 && isM) {
                  const fp = fieldPos(t.fx, t.fy, lerp(1, zf, 1 - pm));
                  const tgt = wXY(t.mi, t.mj);
                  x = lerp(fp.x, tgt.x, pm);
                  y = lerp(fp.y, tgt.y, pm);
                }
                const appear = progress(f, t.t0, t.t0 + 10);
                let op = appear * (0.55 + 0.45 * clamp(Math.abs(t.v) / 1.6));
                if (!isM) {
                  op *= restFade * (1 - progress(f, A.multiply, A.nextlayer));
                  // 權重標籤區域淨空
                  if (labelT > 0 && y < 205) op *= 1 - 0.85 * labelT;
                  if (x < -60 || x > 1980 || y < -40 || y > 1120) return null;
                } else {
                  op = Math.max(op, pm) * endFade;
                }
                if (op <= 0.01) return null;
                const rolling = pt < 1 ? t.v + (hash01(i, Math.floor(f / 4)) - 0.5) * 3 * (1 - pt) : t.v;
                const text = isM && pm > 0.5 ? fmt(W1[t.mi][t.mj], 1) : fmt(rolling, 3);
                const fs = isM ? lerp(20, 38, pm) : (pt < 1 ? 22 : 20) * (pt >= 1 ? lerp(1, zf, 0.6) : 1);
                const fill = pt < 1 ? mix(P.paper, P.mist, pt * 0.5) : tintT < 1 ? blendCss(P.mist, t.v, tintT) : tint(t.v, 1.6);
                const active = isM ? rowActive(t.mi) : 0;
                return (
                  <text
                    key={i}
                    x={x}
                    y={y}
                    fontFamily={MONO}
                    fontSize={fs}
                    fontWeight={isM && pm > 0.5 ? 600 : 500}
                    fill={active > 0 ? mix(P.paper, P.amber, 0.25) : fill}
                    opacity={op}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {text}
                  </text>
                );
              })
            : null}

          {/* 權重標籤：圈出幾個數字 */}
          {labelT > 0 ? (
            <g opacity={labelT}>
              {RING.map(([r, c], q) => {
                const p = fieldPos(fieldXY(c, r).x, fieldXY(c, r).y);
                const lt = ease.out(progress(f, A.weights - 20 + q * 5, A.weights + 14 + q * 5));
                const ax = 760 + q * 100;
                const ay = 158;
                return (
                  <g key={q}>
                    <rect x={p.x - 44} y={p.y - 17} width={88} height={34} rx={8} fill="none" stroke={P.amber} strokeWidth={1.6} opacity={lt} />
                    <line x1={ax} y1={ay} x2={lerp(ax, p.x, lt)} y2={lerp(ay, p.y - 17, lt)} stroke={P.amber} strokeWidth={1.2} opacity={0.55 * lt} />
                  </g>
                );
              })}
              <text x={960} y={112} fontFamily={SANS} fontSize={46} fontWeight={700} letterSpacing="0.06em" fill={P.paper} textAnchor="middle" dominantBaseline="central">
                <tspan fill={P.amber}>權重</tspan>
                <tspan fontSize={26} fill={P.mist} dx={8}>weights</tspan>
                <tspan dx={22}>＝</tspan>
                <tspan dx={22} fill={P.amber}>參數</tspan>
                <tspan fontSize={26} fill={P.mist} dx={8}>parameters</tspan>
              </text>
            </g>
          ) : null}

          {/* ---------------- 矩陣舞台 ---------------- */}
          {f > A.matrix - 60 ? (
            <g>
              {/* 第一層：W·x = y → GELU → h */}
              <g opacity={endFade} transform={`translate(${-420 * shiftT} 0)`}>
                <Bracket x={MX - 2.5 * MCP - 22} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="l" color={P.paper} t={progress(f, A.matrix - 30, A.matrix + 10)} />
                <Bracket x={MX + 2.5 * MCP + 22} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="r" color={P.paper} t={progress(f, A.matrix - 30, A.matrix + 10)} />
                <text x={MX} y={MY - 2 * MRP - 46} fontFamily={SANS} fontSize={26} fontWeight={600} letterSpacing="0.1em" fill={P.amber} textAnchor="middle" opacity={progress(f, A.matrix, A.matrix + 20)}>
                  權重矩陣 W
                </text>
                {/* 列高亮 */}
                {[0, 1, 2, 3].map((i) => {
                  const a = rowActive(i);
                  if (a <= 0) return null;
                  return <rect key={i} x={MX - 2.5 * MCP + 6} y={MY + (i - 1.5) * MRP - 30} width={5 * MCP - 12} height={60} rx={10} fill={P.amber} fillOpacity={0.08 * a} stroke={P.amber} strokeOpacity={0.7 * a} strokeWidth={1.6} />;
                })}
                {/* 逐項高亮（第一列） */}
                {[0, 1, 2, 3, 4].map((j) => {
                  const a = progress(f, at(8 + j * 10), at(12 + j * 10)) * (1 - progress(f, at(18 + j * 10), at(24 + j * 10)));
                  if (a <= 0 || curRow !== 0) return null;
                  const p = wXY(0, j);
                  return (
                    <g key={j} opacity={a}>
                      <rect x={p.x - 50} y={p.y - 26} width={100} height={52} rx={8} fill={P.amber} fillOpacity={0.18} stroke={P.amber} strokeWidth={2} />
                      <rect x={XV - 54} y={xY(j) - 25} width={108} height={50} rx={8} fill={P.ice} fillOpacity={0.18} stroke={P.ice} strokeWidth={2} />
                    </g>
                  );
                })}

                {/* 輸入向量 x */}
                <Bracket x={XV - 66} y1={xY(0) - 40} y2={xY(4) + 40} side="l" color={P.ice} t={progress(f, A.matrix + 20, A.matrix + 60)} />
                <Bracket x={XV + 66} y1={xY(0) - 40} y2={xY(4) + 40} side="r" color={P.ice} t={progress(f, A.matrix + 20, A.matrix + 60)} />
                <text x={XV} y={MY - 2 * MRP - 46} fontFamily={SANS} fontSize={26} fontWeight={600} letterSpacing="0.1em" fill={P.ice} textAnchor="middle" opacity={progress(f, A.matrix + 30, A.matrix + 50)}>
                  輸入 x
                </text>
                {X1.map((v, kk) => {
                  const t = xIn(kk);
                  if (t <= 0) return null;
                  const colActive = curRow >= 0 && f < at(150) ? 1 : 0;
                  return (
                    <text key={kk} x={lerp(2060, XV, t)} y={xY(kk)} fontFamily={MONO} fontSize={38} fontWeight={600} fill={colActive ? mix(P.paper, P.ice, 0.4) : P.paper} textAnchor="middle" dominantBaseline="central" opacity={t}>
                      {fmt(v, 1)}
                    </text>
                  );
                })}

                {/* = 與輸出 y */}
                <text x={1290} y={MY} fontFamily={SANS} fontSize={48} fill={P.paper} textAnchor="middle" dominantBaseline="central" opacity={progress(f, at(50), at(62))}>
                  =
                </text>
                <Bracket x={YV - 70} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="l" color={P.paper} t={progress(f, at(52), at(66))} />
                <Bracket x={YV + 70} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="r" color={P.paper} t={progress(f, at(52), at(66))} />
                <text x={YV} y={MY - 2 * MRP - 46} fontFamily={SANS} fontSize={26} fontWeight={600} letterSpacing="0.1em" fill={P.paper} textAnchor="middle" opacity={progress(f, at(56), at(70))}>
                  輸出 y
                </text>
                {Y1.map((v, i) => {
                  const t = yT(i);
                  if (t <= 0) return null;
                  const yy = MY + (i - 1.5) * MRP;
                  const x = lerp(YV, HV, hMove);
                  const val = hMove > 0.5 ? H1[i] : v;
                  return (
                    <g key={i}>
                      <text x={YV} y={yy} fontFamily={MONO} fontSize={38 * (0.8 + 0.2 * t)} fontWeight={600} fill={tint(v, 2.5)} textAnchor="middle" dominantBaseline="central" opacity={t * (1 - 0.45 * hMove)}>
                        {fmt(v, 2)}
                      </text>
                      {hMove > 0 && hMove < 1 ? (
                        <text x={x} y={yy} fontFamily={MONO} fontSize={38} fontWeight={600} fill={tint(val, 2.5)} textAnchor="middle" dominantBaseline="central" opacity={Math.min(1, hMove * 4)}>
                          {fmt(val, 2)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                {/* 乘加算式（第 i 列） */}
                {curRow >= 0 && lineFade > 0 ? <ProductLine i={curRow} termT={termT} sumT={sumT} opacity={lineFade * progress(f, at(4), at(10))} /> : null}

                {/* 激活函數 */}
                {plotT > 0 ? <ActivationPlot t={plotT} pulse={hMove} /> : null}
              </g>

              {/* h：滑到下一層的輸入位置 */}
              {hMove >= 1 || f > A.nextlayer - 10 ? (
                <g opacity={restOfLayer2Fade}>
                  <Bracket x={lerp(HV, XV, hSlide) - 72} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="l" color={P.ice} t={1} />
                  <Bracket x={lerp(HV, XV, hSlide) + 72} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="r" color={P.ice} t={1} />
                  {H1.map((v, i) => (
                    <text key={i} x={lerp(HV, XV, hSlide)} y={MY + (i - 1.5) * MRP} fontFamily={MONO} fontSize={38} fontWeight={600} fill={tint(v, 2.5)} textAnchor="middle" dominantBaseline="central">
                      {fmt(v, 2)}
                    </text>
                  ))}
                  <text x={lerp(HV, XV, hSlide)} y={MY - 2 * MRP - 46} fontFamily={SANS} fontSize={26} fontWeight={600} letterSpacing="0.1em" fill={P.ice} textAnchor="middle" opacity={hSlide}>
                    新的數字 h
                  </text>
                  {/* 第二層輸出 */}
                  <text x={1290} y={MY} fontFamily={SANS} fontSize={48} fill={P.paper} textAnchor="middle" dominantBaseline="central" opacity={progress(f, nl + 56, nl + 66)}>
                    =
                  </text>
                  <Bracket x={YV - 70} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="l" color={P.paper} t={progress(f, nl + 58, nl + 72)} />
                  <Bracket x={YV + 70} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="r" color={P.paper} t={progress(f, nl + 58, nl + 72)} />
                  {Y2.map((v, i) => (
                    <text key={i} x={YV} y={MY + (i - 1.5) * MRP} fontFamily={MONO} fontSize={38} fontWeight={600} fill={tint(v, 2.5)} textAnchor="middle" dominantBaseline="central" opacity={y2T(i)}>
                      {fmt(v, 2)}
                    </text>
                  ))}
                </g>
              ) : null}

              {/* 第二層權重矩陣 W₂ */}
              {w2In > 0 ? (
                <g opacity={w2In * w2Fade} transform={`translate(${MX} ${MY}) scale(${0.92 + 0.08 * w2In}) translate(${-MX} ${-MY})`}>
                  <Bracket x={MX - 2 * MCP - 22} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="l" color={P.paper} opacity={1 - cellBg} />
                  <Bracket x={MX + 2 * MCP + 22} y1={MY - 2 * MRP - 8} y2={MY + 2 * MRP + 8} side="r" color={P.paper} opacity={1 - cellBg} />
                  <text x={MX} y={MY - 2 * MRP - 46} fontFamily={SANS} fontSize={26} fontWeight={600} letterSpacing="0.1em" fill={P.amber} textAnchor="middle" opacity={1 - cellBg}>
                    下一層的權重矩陣
                  </text>
                  {W2.map((row, i) =>
                    row.map((v, j) => {
                      const p = wXY(i, j, 4);
                      const hl = progress(f, w2RowStart(i), w2RowStart(i) + 4) * (1 - progress(f, w2RowStart(i) + 12, w2RowStart(i) + 18));
                      return (
                        <g key={`${i}-${j}`}>
                          {cellBg > 0 ? (
                            <rect x={p.x - 61} y={p.y - 39} width={122} height={78} rx={6} fill={tint(v, 1.2)} fillOpacity={0.3 * cellBg} stroke={tint(v, 1.2)} strokeOpacity={0.55 * cellBg} strokeWidth={1.5} />
                          ) : null}
                          {hl > 0 ? <rect x={p.x - 56} y={p.y - 28} width={112} height={56} rx={8} fill={P.amber} fillOpacity={0.12 * hl} stroke={P.amber} strokeOpacity={0.6 * hl} /> : null}
                          <text x={p.x} y={p.y} fontFamily={MONO} fontSize={38} fontWeight={600} fill={tint(v, 1.2)} textAnchor="middle" dominantBaseline="central">
                            {fmt(v, 1)}
                          </text>
                        </g>
                      );
                    }),
                  )}
                </g>
              ) : null}
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
};

const blendCss = (base: string, v: number, t: number) => {
  // 由灰（未上色）過渡到正負色
  const target = tint(v, 1.6);
  const m = target.match(/\d+/g)!.map(Number);
  const b = [parseInt(base.slice(1, 3), 16), parseInt(base.slice(3, 5), 16), parseInt(base.slice(5, 7), 16)];
  const c = b.map((x, i) => Math.round(x + (m[i] - x) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

const ProductLine: React.FC<{i: number; termT: (i: number, j: number) => number; sumT: (i: number) => number; opacity: number}> = ({i, termT, sumT, opacity}) => {
  const terms = W1[i].map((w, j) => w * X1[j]);
  const sub = ['₁', '₂', '₃', '₄'][i];
  return (
    <text x={MX + 260} y={790} fontFamily={MONO} fontSize={32} fill={P.paper} textAnchor="middle" dominantBaseline="central" opacity={opacity}>
      <tspan fill={P.mist}>{`y${sub} = `}</tspan>
      {terms.map((p, j) => {
        const sign = j === 0 ? (p < 0 ? '−' : '') : p < 0 ? ' − ' : ' + ';
        return (
          <tspan key={j} opacity={termT(i, j)} fill={tint(p, 1.5)}>
            {sign + Math.abs(p).toFixed(2)}
          </tspan>
        );
      })}
      <tspan opacity={sumT(i)} fill={P.paper} fontWeight={700}>
        {' = ' + fmt(Y1[i], 2)}
      </tspan>
    </text>
  );
};

/** 小型激活函數圖（GELU），位於 y 與 h 之間。 */
const ActivationPlot: React.FC<{t: number; pulse: number}> = ({t, pulse}) => {
  const ox = 1545;
  const oy = 470;
  const sx = 16; // px per unit
  const sy = 16;
  const pts: string[] = [];
  for (let q = 0; q <= 40; q++) {
    const x = -3.2 + (6.4 * q) / 40;
    const g = 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));
    pts.push(`${(ox + x * sx).toFixed(1)},${(oy - g * sy).toFixed(1)}`);
  }
  const glow = Math.sin(pulse * Math.PI);
  return (
    <g opacity={t}>
      <line x1={ox - 56} y1={oy} x2={ox + 56} y2={oy} stroke={P.mist} strokeWidth={1.2} opacity={0.6} />
      <line x1={ox} y1={oy + 26} x2={ox} y2={oy - 56} stroke={P.mist} strokeWidth={1.2} opacity={0.6} />
      <polyline points={pts.join(' ')} fill="none" stroke={P.mint} strokeWidth={3 + glow * 1.5} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - t} />
      <text x={ox} y={oy - 92} fontFamily={SANS} fontSize={22} fontWeight={600} letterSpacing="0.08em" fill={P.mint} textAnchor="middle">
        簡單運算
      </text>
      <text x={ox} y={oy + 58} fontFamily={MONO} fontSize={20} fill={P.mist} textAnchor="middle">
        GELU
      </text>
      <path d={`M ${ox - 62} ${oy + 100} L ${ox + 62} ${oy + 100}`} stroke={P.mint} strokeWidth={1.5} opacity={0.5} />
      <path d={`M ${ox + 54} ${oy + 94} L ${ox + 64} ${oy + 100} L ${ox + 54} ${oy + 106}`} fill="none" stroke={P.mint} strokeWidth={1.5} opacity={0.5} />
    </g>
  );
};
