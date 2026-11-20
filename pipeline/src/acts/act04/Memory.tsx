import React from 'react';
import {clamp, ease, lerp, progress, wobble} from '../../lib/anim';
import {A, an, env, HatchDefs, MONO, P, Txt, fontStack} from './common';

/**
 * 站點 2：8B × 2 位元組 ≈ 16 GB 的記憶體方塊逐格填滿；6 GB（或 8 GB）的 VRAM 容器出現，方塊放不下。
 * 每格 = 1 GB（10⁹ 位元組）。
 */
const T = 118; // 格子邊長
const G = 12;
const COLS = 8;
const ROWS = 2;
const GW = COLS * T + (COLS - 1) * G;

export const Memory: React.FC<{f: number; anchors: A}> = ({f, anchors}) => {
  const calc = an(anchors, 'calc', 968);
  const result = an(anchors, 'result', 1327);
  const vram6 = an(anchors, 'vram6', 1594);
  const quant = an(anchors, 'quant', 1710);

  const fIn = progress(f, calc + 50, calc + 90);
  const fillStart = calc + 110;
  const fillEnd = result - 6;
  const filled = clamp((f - fillStart) / (fillEnd - fillStart)) * 16;
  const gb = Math.min(16, filled);
  const resultPop = ease.out(progress(f, result - 8, result + 24));

  // 容器出現與方塊滑入
  const boxIn = ease.out(progress(f, vram6 - 50, vram6 - 5));
  const slide = ease.camera(progress(f, vram6 - 10, vram6 + 60));
  const strain = progress(f, vram6 + 50, vram6 + 80);
  const quantT = ease.out(progress(f, quant - 12, quant + 26));

  // 格子位置：先置中，再滑到容器（左對齊）
  const gx0Center = 960 - GW / 2;
  const boxX = 230;
  const boxPad = 18;
  const gx0Box = boxX + boxPad;
  const gx0 = lerp(gx0Center, gx0Box, slide);
  const gy0Center = 400;
  const gy0Box = 470;
  const gy0 = lerp(gy0Center, gy0Box, slide);
  const fitCols = 3; // 6 GB = 3 欄 × 2 列
  const boxW = fitCols * T + (fitCols - 1) * G + boxPad * 2;
  const box8W = 4 * T + 3 * G + boxPad * 2;
  const boxH = ROWS * T + G + boxPad * 2;
  const boxY = gy0Box - boxPad;

  const out = 1 - progress(f, quant + 120, quant + 170);

  const tiles: React.ReactNode[] = [];
  for (let i = 0; i < 16; i++) {
    const col = Math.floor(i / ROWS);
    const row = i % ROWS;
    const k = clamp(filled - i);
    if (k <= 0) continue;
    const pop = ease.out(k);
    const x = gx0 + col * (T + G);
    const y = gy0 + row * (T + G);
    const overflow = col >= fitCols;
    const ov = overflow ? strain : 0;
    // 放不下的格子：微微下垂、晃動
    const droop = ov * (6 + (col - fitCols) * 7) + ov * wobble(f + i * 7, 40) * 2.5;
    tiles.push(
      <g key={i} transform={`translate(${x + T / 2} ${y + T / 2 + droop}) rotate(${ov * (col - fitCols + 1) * 1.1}) scale(${0.7 + 0.3 * pop})`} opacity={pop}>
        <rect x={-T / 2} y={-T / 2} width={T} height={T} rx={6} fill={P.amber} fillOpacity={lerp(0.78, 0.18, ov)} stroke={P.amber} strokeWidth={1.5} />
        {ov > 0 ? <rect x={-T / 2} y={-T / 2} width={T} height={T} rx={6} fill="url(#a4memHatch)" opacity={ov} /> : null}
        {/* 晶片紋理 */}
        {[0, 1, 2].map((j) => (
          <line key={j} x1={-T / 2 + 16} x2={T / 2 - 16} y1={-22 + j * 22} y2={-22 + j * 22} stroke={ov > 0.5 ? P.amber : P.ink} strokeOpacity={0.35} strokeWidth={2} />
        ))}
        <text x={0} y={T / 2 - 14} textAnchor="middle" fontFamily={fontStack} fontWeight={700} fontSize={22} fill={ov > 0.5 ? P.amber : P.ink}>
          1 GB
        </text>
      </g>,
    );
  }

  return (
    <div style={{position: 'absolute', inset: 0, opacity: out}}>
      {/* 算式 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: 1920,
          top: lerp(150, 120, slide),
          textAlign: 'center',
          fontFamily: fontStack,
          fontSize: 44,
          fontWeight: 700,
          color: P.paper,
          opacity: fIn,
          transform: `translateY(${(1 - ease.out(fIn)) * 20}px)`,
          letterSpacing: '0.04em',
        }}
      >
        <span style={{fontFamily: MONO, color: P.amber}}>8,000,000,000</span>
        <span style={{color: P.mist, fontSize: 30, margin: '0 10px'}}>個參數</span>
        <span>×</span>
        <span style={{fontFamily: MONO, color: P.amber, marginLeft: 16}}>2</span>
        <span style={{color: P.mist, fontSize: 30, margin: '0 10px'}}>位元組</span>
        <span>≈</span>
        <span style={{fontFamily: MONO, color: P.amber, marginLeft: 16, display: 'inline-block', minWidth: 190, textAlign: 'left', transform: `scale(${1 + resultPop * 0.12 * (1 - progress(f, result + 24, result + 60))})`}}>
          {gb.toFixed(0)} GB
        </span>
      </div>
      <Txt x={960} y={lerp(236, 204, slide)} align="center" size={20} color={P.mist} t={fIn * 0.9}>
        只算權重本身 · 1 GB ＝ 10⁹ 位元組
      </Txt>

      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <defs>
          <HatchDefs id="a4memHatch" color={P.amber} gap={9} width={1.6} opacity={0.55} />
        </defs>
        {/* 空格框（尚未填滿的位置） */}
        <g opacity={fIn * (1 - slide)}>
          {Array.from({length: 16}).map((_, i) => {
            const col = Math.floor(i / ROWS);
            const row = i % ROWS;
            return <rect key={i} x={gx0 + col * (T + G)} y={gy0 + row * (T + G)} width={T} height={T} rx={6} fill="none" stroke={P.line} strokeWidth={1.5} strokeDasharray="5 6" />;
          })}
        </g>

        {/* VRAM 容器 */}
        <g opacity={boxIn}>
          {/* 8 GB 虛線延伸 */}
          <rect x={boxX} y={boxY} width={box8W} height={boxH} rx={14} fill="none" stroke={P.ice} strokeOpacity={0.55} strokeWidth={1.6} strokeDasharray="7 7" />
          <rect x={boxX} y={boxY} width={boxW} height={boxH} rx={14} fill={P.iceDeep} fillOpacity={0.1} stroke={P.ice} strokeWidth={2.4} />
          {/* 筆電線稿圖示 */}
          <g transform={`translate(${boxX + 6} ${boxY - 92})`} stroke={P.ice} strokeWidth={2} fill="none">
            <rect x={0} y={0} width={64} height={40} rx={4} />
            <path d="M -8 46 L 72 46 L 66 54 L -2 54 Z" />
          </g>
          <text x={boxX + 92} y={boxY - 56} fontFamily={fontStack} fontSize={28} fontWeight={700} fill={P.ice} letterSpacing="0.05em">
            筆電顯示卡 VRAM
          </text>
          <text x={boxX + boxW / 2} y={boxY + boxH + 40} textAnchor="middle" fontFamily={fontStack} fontSize={26} fontWeight={700} fill={P.ice}>
            6 GB
          </text>
          <text x={boxX + boxW + (box8W - boxW) / 2} y={boxY + boxH + 40} textAnchor="middle" fontFamily={fontStack} fontSize={22} fontWeight={500} fill={P.ice} opacity={0.75}>
            或 8 GB
          </text>
        </g>

        {tiles}

        {/* 放不下 */}
        <g opacity={strain * (1 - quantT * 0.4)}>
          <path
            d={`M ${boxX + box8W + 14} ${boxY - 30} L ${boxX + box8W + 14} ${boxY + boxH + 30}`}
            stroke={P.amber}
            strokeWidth={2}
            strokeDasharray="3 6"
            opacity={0.6}
          />
          <text x={gx0Box + 4 * (T + G) + (4 * T + 3 * G) / 2} y={boxY - 34} textAnchor="middle" fontFamily={fontStack} fontSize={30} fontWeight={700} fill={P.amber} letterSpacing="0.1em">
            放不下
          </text>
        </g>
      </svg>

      {/* 量化 */}
      <div
        style={{
          position: 'absolute',
          left: 1240,
          top: 700,
          width: 560,
          textAlign: 'right',
          opacity: quantT,
          transform: `translateY(${(1 - quantT) * 24}px)`,
          fontFamily: fontStack,
        }}
      >
        <span style={{fontSize: 30, color: P.mist, fontWeight: 500, letterSpacing: '0.08em', marginRight: 18}}>解法</span>
        <span style={{fontSize: 72, fontWeight: 800, color: P.paper, letterSpacing: '0.1em'}}>量化</span>
      </div>
    </div>
  );
};
