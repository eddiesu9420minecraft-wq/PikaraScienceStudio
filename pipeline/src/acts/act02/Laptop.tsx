import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack} from '../../theme/fonts';
import {clamp, ease, lerp} from '../../lib/anim';

/**
 * 筆電（房間世界座標，SVG）。鍵盤底座以梯形近似透視，deck(u,v) 把底座本地座標（u：左→右，v：後→前）映射到世界座標，
 * 讓 X 光透視下的零件（SSD、晶片、記憶體）與標籤都能準確定位。
 */
export const LAP = {
  backY: 606,
  frontY: 684,
  backL: 806,
  backR: 1114,
  frontL: 772,
  frontR: 1148,
  lidTop: 386,
  disp: {x: 816, y: 396, w: 288, h: 200},
};

export const deck = (u: number, v: number) => {
  const l = lerp(LAP.backL, LAP.frontL, v);
  const r = lerp(LAP.backR, LAP.frontR, v);
  return {x: lerp(l, r, u), y: lerp(LAP.backY, LAP.frontY, v)};
};

const quad = (u0: number, v0: number, u1: number, v1: number) => {
  const a = deck(u0, v0);
  const b = deck(u1, v0);
  const c = deck(u1, v1);
  const d = deck(u0, v1);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y} L ${d.x} ${d.y} Z`;
};

/** SSD 與晶片在底座上的位置（給外部標籤／資料流使用）。 */
export const SSD_UV = {u0: 0.63, v0: 0.17, u1: 0.9, v1: 0.33};
export const CHIP_UV = {u0: 0.41, v0: 0.13, u1: 0.56, v1: 0.38};
export const RAM_UV = {u0: 0.25, v0: 0.13, u1: 0.35, v1: 0.38};
export const ssdCenter = () => deck((SSD_UV.u0 + SSD_UV.u1) / 2, (SSD_UV.v0 + SSD_UV.v1) / 2);
export const chipCenter = () => deck((CHIP_UV.u0 + CHIP_UV.u1) / 2, (CHIP_UV.v0 + CHIP_UV.v1) / 2);
export const ramCenter = () => deck((RAM_UV.u0 + RAM_UV.u1) / 2, (RAM_UV.v0 + RAM_UV.v1) / 2);
/** 模型檔案圖示：立在 SSD 上方的看板（世界座標中心）。 */
export const FILE_H = 50;
export const fileCenter = (rise: number) => {
  const s = ssdCenter();
  return {x: s.x, y: s.y - 6 - (FILE_H / 2 + 12) * rise};
};

export const PROMPT = '幫我想三道簡單的晚餐';
export const ANSWER = ['可以試試：番茄炒蛋、', '蒜炒青菜、味噌豆腐湯。'];
export const bubbleCharPos = (i: number) => ({x: 952 + i * 13.4 + 6.7, y: 448});

export type LaptopState = {
  frame: number;
  mode: 'cloud' | 'local';
  typed: number; // 已輸入字數（輸入框）
  sent: number; // 0..1 送出動畫
  charsHidden: number; // 0..1 泡泡文字被封包取代
  waiting: number; // 0..1 顯示「等待回覆」
  answer: number; // 0..1 回覆文字逐字出現
  xray: number; // 0..1 底座透視
  ssdGlow: number;
  chipGlow: number;
  weightFlow: number; // SSD → 記憶體 → 晶片 的琥珀流
};

export const mixHex = (a: string, b: string, t: number) => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((x, i) => Math.round(lerp(x, pb[i], clamp(t)))).join(',')})`;
};

export const Laptop: React.FC<{s: LaptopState}> = ({s}) => {
  const {frame} = s;
  const D = LAP.disp;
  const xr = s.xray;
  const hingeL = deck(0, 0);
  const hingeR = deck(1, 0);
  return (
    <g>
      {/* 桌面接觸陰影 */}
      <ellipse cx={960} cy={LAP.frontY + 8} rx={236} ry={13} fill="#05070D" opacity={0.5} />
      {/* ---------- 螢幕上蓋 ---------- */}
      <path
        d={`M ${LAP.backL} ${LAP.backY} L ${LAP.backL + 2} ${LAP.lidTop + 6} Q ${LAP.backL + 2} ${LAP.lidTop} ${LAP.backL + 8} ${LAP.lidTop} L ${LAP.backR - 8} ${LAP.lidTop} Q ${LAP.backR - 2} ${LAP.lidTop} ${LAP.backR - 2} ${LAP.lidTop + 6} L ${LAP.backR} ${LAP.backY} Z`}
        fill="#1A1F2C"
      />
      <path d={`M ${LAP.backL + 3} ${LAP.backY - 1} L ${LAP.backL + 4} ${LAP.lidTop + 4} L ${LAP.backR - 4} ${LAP.lidTop + 4} L ${LAP.backR - 3} ${LAP.backY - 1} Z`} fill="none" stroke="#2C3448" strokeWidth={1.2} />
      <Screen s={s} />
      {/* 螢幕玻璃反光 */}
      <path d={`M ${D.x + 150} ${D.y} L ${D.x + 196} ${D.y} L ${D.x + 96} ${D.y + D.h} L ${D.x + 50} ${D.y + D.h} Z`} fill="#FFFFFF" opacity={0.03} />
      <circle cx={960} cy={LAP.lidTop + 5} r={1.6} fill="#0A0D14" />
      {/* 鉸鍊 */}
      <rect x={hingeL.x + 20} y={LAP.backY - 3} width={hingeR.x - hingeL.x - 40} height={5} fill="#141924" />

      {/* ---------- 底座 ---------- */}
      <path d={`M ${LAP.frontL} ${LAP.frontY} L ${LAP.frontR} ${LAP.frontY} L ${LAP.frontR - 3} ${LAP.frontY + 9} L ${LAP.frontL + 3} ${LAP.frontY + 9} Z`} fill="#1B2130" />
      <path d={quad(0, 0, 1, 1)} fill={mixHex('#343C50', '#121A28', xr * 0.85)} />
      <path d={`M ${LAP.frontL} ${LAP.frontY} L ${LAP.frontR} ${LAP.frontY}`} stroke="#56607A" strokeWidth={1.4} />
      <path d={`M ${LAP.backL} ${LAP.backY} L ${LAP.frontL} ${LAP.frontY}`} stroke="#465067" strokeWidth={1} />
      <path d={`M ${LAP.backR} ${LAP.backY} L ${LAP.frontR} ${LAP.frontY}`} stroke="#465067" strokeWidth={1} />
      {/* 內部零件（X 光） */}
      {xr > 0.01 ? <Internals s={s} /> : null}
      {/* 鍵盤與觸控板（透視時淡化） */}
      <g opacity={1 - xr * 0.86}>
        <path d={quad(0.06, 0.07, 0.94, 0.53)} fill="#262D3D" />
        {Array.from({length: 4}).map((_, r) =>
          Array.from({length: 13}).map((__, c) => {
            const u0 = 0.075 + c * 0.0665;
            const v0 = 0.09 + r * 0.108;
            const lit = s.mode === 'cloud' && s.typed > 0 && s.typed < PROMPT.length && (Math.floor(frame / 3) + c * 5 + r * 3) % 13 === 0;
            return <path key={`${r}-${c}`} d={quad(u0, v0, u0 + 0.056, v0 + 0.085)} fill={lit ? '#4F6A8E' : '#3B4459'} />;
          }),
        )}
        <path d={quad(0.33, 0.62, 0.67, 0.93)} fill="#2D3447" stroke="#475170" strokeWidth={0.8} />
      </g>
    </g>
  );
};

const Screen: React.FC<{s: LaptopState}> = ({s}) => {
  const D = LAP.disp;
  const {frame} = s;
  const cursorOn = Math.floor(frame / 16) % 2 === 0;
  const local = s.mode === 'local';
  const sentK = ease.out(s.sent);
  const inputText = PROMPT.slice(0, Math.floor(s.typed));
  const dots = Math.floor(frame / 12) % 4;
  const total = ANSWER[0].length + ANSWER[1].length;
  const ansChars = Math.floor(s.answer * total);
  const a0 = ANSWER[0].slice(0, ansChars);
  const a1 = ANSWER[1].slice(0, Math.max(0, ansChars - ANSWER[0].length));
  return (
    <g fontFamily={fontStack}>
      <defs>
        <linearGradient id="a2-disp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#14233D" />
          <stop offset="1" stopColor="#0C1526" />
        </linearGradient>
      </defs>
      <rect x={D.x} y={D.y} width={D.w} height={D.h} fill="url(#a2-disp)" />
      {/* 標題列 */}
      <text x={D.x + 12} y={D.y + 17} fontSize={9.5} fill={P.mist} fontWeight={500} letterSpacing={0.6}>
        {local ? '本地模型' : 'AI 聊天服務'}
      </text>
      <circle cx={D.x + D.w - 46} cy={D.y + 13.5} r={2.6} fill={local ? P.amber : P.ice} />
      <text x={D.x + D.w - 40} y={D.y + 17} fontSize={9.5} fill={local ? P.amber : P.ice} fontWeight={500}>
        {local ? '離線' : '雲端'}
      </text>
      <rect x={D.x + 10} y={D.y + 25} width={D.w - 20} height={0.8} fill="#22304C" />
      {/* 使用者泡泡 */}
      {s.sent > 0.001 ? (
        <g opacity={Math.min(1, s.sent * 2)} transform={`translate(0 ${(1 - sentK) * 110})`}>
          <rect x={946} y={436} width={146} height={22} fill="#1B2A44" opacity={1 - s.charsHidden * 0.6} />
          <rect x={946} y={436} width={2} height={22} fill={P.amber} />
          {PROMPT.split('').map((ch, i) => {
            const p = bubbleCharPos(i);
            return (
              <text key={i} x={p.x} y={p.y + 4.5} fontSize={12.2} fill={P.paper} fontWeight={500} textAnchor="middle" opacity={1 - clamp(s.charsHidden * PROMPT.length - i)}>
                {ch}
              </text>
            );
          })}
        </g>
      ) : null}
      {/* 等待雲端回覆 */}
      {s.waiting > 0.01 ? (
        <g opacity={s.waiting}>
          <text x={D.x + 14} y={488} fontSize={10} fill={P.mist}>
            等待回覆
          </text>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={D.x + 62 + i * 7} cy={484.5} r={1.8} fill={P.ice} opacity={i < dots ? 0.95 : 0.25} />
          ))}
        </g>
      ) : null}
      {/* 本地回覆 */}
      {s.answer > 0.001 ? (
        <g>
          <rect x={D.x + 12} y={472} width={2} height={a1.length ? 42 : 21} fill={P.ice} />
          <text x={D.x + 22} y={487} fontSize={12} fill="#CFE2F5">
            {a0}
            {s.answer < 1 && !a1.length && cursorOn ? <tspan fill={P.ice}>▍</tspan> : null}
          </text>
          <text x={D.x + 22} y={507} fontSize={12} fill="#CFE2F5">
            {a1}
            {s.answer < 1 && a1.length > 0 && cursorOn ? <tspan fill={P.ice}>▍</tspan> : null}
          </text>
        </g>
      ) : null}
      {/* 輸入框 */}
      <rect x={D.x + 12} y={D.y + D.h - 30} width={D.w - 24} height={20} fill="#0E1729" stroke="#2A3A5C" strokeWidth={0.9} />
      <text x={D.x + 20} y={D.y + D.h - 16} fontSize={10.5} fill={s.sent > 0.3 || inputText.length === 0 ? '#56647F' : P.paper} fontWeight={500}>
        {s.sent > 0.3 || inputText.length === 0 ? '輸入訊息…' : inputText}
        {s.sent <= 0.3 && inputText.length > 0 && cursorOn ? <tspan fill={P.amber}>▍</tspan> : null}
      </text>
      <path d={`M ${D.x + D.w - 26} ${D.y + D.h - 25} l 8 5 l -8 5 z`} fill={s.sent > 0 && s.sent < 0.6 ? P.amber : '#3A4A6C'} />
    </g>
  );
};

const Internals: React.FC<{s: LaptopState}> = ({s}) => {
  const {frame} = s;
  const xr = s.xray;
  const chip = chipCenter();
  const ram = ramCenter();
  const ssd = ssdCenter();
  const fanC = deck(0.14, 0.26);
  const fanRx = 30;
  const fanRy = 9;
  const fanA = frame * 0.06 * (0.4 + s.chipGlow);
  return (
    <g opacity={ease.out(xr)}>
      {/* 主機板 */}
      <path d={quad(0.04, 0.05, 0.96, 0.47)} fill={P.pcb} stroke="#24443A" strokeWidth={0.8} />
      {[0.2, 0.3, 0.42].map((v) => (
        <path key={v} d={`M ${deck(0.08, v).x} ${deck(0.08, v).y} L ${deck(0.92, v).x} ${deck(0.92, v).y}`} stroke={P.copper} strokeWidth={0.5} opacity={0.35} />
      ))}
      {/* 電池 */}
      {[0, 1, 2].map((i) => (
        <path key={i} d={quad(0.08 + i * 0.285, 0.55, 0.34 + i * 0.285, 0.93)} fill="#1C2333" stroke="#30394F" strokeWidth={0.8} />
      ))}
      {/* 風扇 */}
      <ellipse cx={fanC.x} cy={fanC.y} rx={fanRx} ry={fanRy} fill="#141A26" stroke="#3A4560" strokeWidth={1} />
      {Array.from({length: 7}).map((_, i) => {
        const a = fanA + (i / 7) * Math.PI * 2;
        return <line key={i} x1={fanC.x} y1={fanC.y} x2={fanC.x + Math.cos(a) * fanRx * 0.85} y2={fanC.y + Math.sin(a) * fanRy * 0.85} stroke="#4A5675" strokeWidth={1.4} />;
      })}
      {/* 熱導管 */}
      <path d={`M ${fanC.x + fanRx - 2} ${fanC.y - 3} L ${chip.x - 20} ${chip.y - 9}`} stroke={P.copper} strokeWidth={3} opacity={0.7} strokeLinecap="round" />
      {/* 記憶體 */}
      <path d={quad(RAM_UV.u0, RAM_UV.v0, RAM_UV.u1, RAM_UV.v1)} fill="#1E2536" stroke="#3E4964" strokeWidth={0.8} />
      {[0, 1, 2, 3].map((i) => (
        <path key={i} d={quad(RAM_UV.u0 + 0.012, RAM_UV.v0 + 0.03 + i * 0.055, RAM_UV.u1 - 0.012, RAM_UV.v0 + 0.07 + i * 0.055)} fill="#11151F" />
      ))}
      {/* 晶片（CPU／GPU） */}
      <path d={quad(CHIP_UV.u0, CHIP_UV.v0, CHIP_UV.u1, CHIP_UV.v1)} fill="#1F3A2E" stroke="#335A48" strokeWidth={0.8} />
      <path d={quad(CHIP_UV.u0 + 0.03, CHIP_UV.v0 + 0.06, CHIP_UV.u1 - 0.03, CHIP_UV.v1 - 0.06)} fill={mixHex('#1A2030', '#FFB547', s.chipGlow * (0.7 + 0.15 * Math.sin(frame / 5)))} />
      {s.chipGlow > 0.01 ? <ellipse cx={chip.x} cy={chip.y} rx={46} ry={17} fill={P.amber} opacity={0.16 * s.chipGlow} /> : null}
      {/* SSD（M.2） */}
      <path d={quad(SSD_UV.u0, SSD_UV.v0, SSD_UV.u1, SSD_UV.v1)} fill="#13241D" stroke={s.ssdGlow > 0.05 ? P.amber : '#2D4C40'} strokeWidth={0.8 + s.ssdGlow * 1.2} />
      <path d={quad(SSD_UV.u0 + 0.015, SSD_UV.v0 + 0.03, SSD_UV.u0 + 0.06, SSD_UV.v1 - 0.03)} fill="#2C3242" />
      <path d={quad(SSD_UV.u0 + 0.08, SSD_UV.v0 + 0.03, SSD_UV.u0 + 0.155, SSD_UV.v1 - 0.03)} fill="#1A1E28" />
      <path d={quad(SSD_UV.u0 + 0.17, SSD_UV.v0 + 0.03, SSD_UV.u1 - 0.025, SSD_UV.v1 - 0.03)} fill="#1A1E28" />
      <path d={quad(SSD_UV.u1 - 0.012, SSD_UV.v0 + 0.02, SSD_UV.u1, SSD_UV.v1 - 0.02)} fill={P.gold} opacity={0.8} />
      {s.ssdGlow > 0.01 ? <ellipse cx={ssd.x} cy={ssd.y} rx={52} ry={14} fill={P.amber} opacity={0.14 * s.ssdGlow} /> : null}
      {/* 權重流：SSD → 記憶體 → 晶片（沿主機板下緣繞行） */}
      {s.weightFlow > 0.01
        ? Array.from({length: 10}).map((_, i) => {
            const t = (((frame / 50 + i / 10) % 1) + 1) % 1;
            const lane = deck(0.5, 0.45).y;
            let x: number;
            let y: number;
            if (t < 0.25) {
              const k = t / 0.25;
              x = ssd.x;
              y = lerp(ssd.y, lane, k);
            } else if (t < 0.75) {
              const k = (t - 0.25) / 0.5;
              x = lerp(ssd.x, ram.x, k);
              y = lane;
            } else {
              const k = (t - 0.75) / 0.25;
              x = ram.x;
              y = lerp(lane, ram.y, k);
            }
            const env = Math.sin(t * Math.PI);
            return <rect key={i} x={x - 4} y={y - 1.3} width={8} height={2.6} fill={P.amber} opacity={s.weightFlow * (0.35 + 0.65 * env)} />;
          })
        : null}
      {s.weightFlow > 0.01
        ? Array.from({length: 4}).map((_, i) => {
            const t = (((frame / 26 + i / 4) % 1) + 1) % 1;
            const x = lerp(ram.x + 14, chip.x - 16, t);
            return <rect key={i} x={x - 4} y={ram.y - 1.3} width={8} height={2.6} fill={P.amber} opacity={s.weightFlow * Math.sin(t * Math.PI)} />;
          })
        : null}
    </g>
  );
};

/** 模型檔案圖示（世界座標，中心 cx,cy，高度 h）。 */
export const ModelFile: React.FC<{cx: number; cy: number; h: number; o?: number; glow?: number; frame: number; cells?: number}> = ({
  cx,
  cy,
  h,
  o = 1,
  glow = 0,
  frame,
  cells = 5,
}) => {
  if (o <= 0.001 || h <= 0.5) return null;
  const w = h * 0.78;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const fold = w * 0.26;
  const pad = w * 0.14;
  const gw = w - pad * 2;
  const gy = y0 + h * 0.36;
  const gh = h * 0.5;
  const cw = gw / cells;
  const rows = Math.max(3, Math.round(cells * 1.1));
  const ch = gh / rows;
  return (
    <g opacity={o}>
      <defs>
        <radialGradient id="a2-file-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={P.amber} stopOpacity={0.22} />
          <stop offset="1" stopColor={P.amber} stopOpacity={0} />
        </radialGradient>
      </defs>
      {glow > 0.01 ? <ellipse cx={cx} cy={cy} rx={w * 0.95} ry={h * 0.8} fill="url(#a2-file-glow)" opacity={glow} /> : null}
      <path d={`M ${x0} ${y0} L ${x0 + w - fold} ${y0} L ${x0 + w} ${y0 + fold} L ${x0 + w} ${y0 + h} L ${x0} ${y0 + h} Z`} fill="#18213A" stroke={P.amber} strokeWidth={h * 0.03} strokeLinejoin="round" />
      <path d={`M ${x0 + w - fold} ${y0} L ${x0 + w - fold} ${y0 + fold} L ${x0 + w} ${y0 + fold}`} fill="#2A3656" stroke={P.amber} strokeWidth={h * 0.024} strokeLinejoin="round" />
      <rect x={x0 + pad} y={y0 + h * 0.12} width={gw * 0.5} height={h * 0.05} fill={P.amber} opacity={0.9} />
      <rect x={x0 + pad} y={y0 + h * 0.215} width={gw * 0.32} height={h * 0.035} fill={P.mist} opacity={0.6} />
      {Array.from({length: rows * cells}).map((_, i) => {
        const r = Math.floor(i / cells);
        const c = i % cells;
        const v = Math.sin(i * 12.9898 + 4.1) * 0.5 + 0.5;
        const pulse = 0.5 + 0.5 * Math.sin(frame / 9 + i * 0.7);
        return (
          <rect
            key={i}
            x={x0 + pad + c * cw + cw * 0.12}
            y={gy + r * ch + ch * 0.12}
            width={cw * 0.76}
            height={ch * 0.76}
            fill={v > 0.5 ? P.amber : P.ice}
            opacity={0.25 + v * 0.45 + pulse * glow * 0.25}
          />
        );
      })}
    </g>
  );
};
