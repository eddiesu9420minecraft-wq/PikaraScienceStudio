import React from 'react';
import {palette as P} from '../../theme/palette';
import {ease, progress} from '../../lib/anim';
import {A3, hash01, MONO, SANS} from './common';

/**
 * 開場鉤子：畫面中央一個模型檔案（好幾 GB），檔案裡隱約流動的位元組；
 * 「到底是什麼？」→ 鏡頭鑽進檔案，接到「答案資料庫」的想像。
 */
const FW = 300;
const FH = 380;
const CX = 960;
const CY = 470;

export const Hook: React.FC<{frame: number; A: A3}> = ({frame: f, A}) => {
  const diveS = A.hook + 30;
  const diveE = A.hook + 110;
  if (f > diveE + 4) return null;
  const inT = ease.out(progress(f, 0, 40));
  const dive = ease.in(progress(f, diveS, diveE));
  const scale = (0.94 + 0.06 * inT) * (1 + 7 * dive) + 0.012 * Math.sin(f / 30) * (1 - dive);
  const op = 1 - progress(f, diveS + 30, diveE);
  const qT = ease.out(progress(f, A.hook - 24, A.hook + 8));
  const sizeT = progress(f, 30, Math.max(60, A.hook - 60));
  const rows = 9;
  return (
    <div style={{position: 'absolute', inset: 0, opacity: op}}>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <linearGradient id="a3file" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#24304D" />
            <stop offset="1" stopColor="#161F35" />
          </linearGradient>
          <clipPath id="a3fileClip">
            <rect x={-FW / 2 + 14} y={-FH / 2 + 72} width={FW - 28} height={FH - 150} />
          </clipPath>
        </defs>
        <g transform={`translate(${CX} ${CY}) scale(${scale})`}>
          <ellipse cx={0} cy={FH / 2 + 30} rx={FW * 0.6} ry={18} fill="#000" opacity={0.35 * (1 - dive)} />
          <path
            d={`M ${-FW / 2 + 10} ${-FH / 2} L ${FW / 2 - 64} ${-FH / 2} L ${FW / 2} ${-FH / 2 + 64} L ${FW / 2} ${FH / 2 - 10} Q ${FW / 2} ${FH / 2} ${FW / 2 - 10} ${FH / 2} L ${-FW / 2 + 10} ${FH / 2} Q ${-FW / 2} ${FH / 2} ${-FW / 2} ${FH / 2 - 10} L ${-FW / 2} ${-FH / 2 + 10} Q ${-FW / 2} ${-FH / 2} ${-FW / 2 + 10} ${-FH / 2} Z`}
            fill="url(#a3file)"
            stroke={P.amber}
            strokeWidth={2.5}
          />
          <path d={`M ${FW / 2 - 64} ${-FH / 2} L ${FW / 2 - 64} ${-FH / 2 + 64} L ${FW / 2} ${-FH / 2 + 64}`} fill="#2E3B5E" stroke={P.amber} strokeWidth={2.5} strokeLinejoin="round" />
          {/* 檔案裡的位元組（看不懂的內容） */}
          <g clipPath="url(#a3fileClip)" opacity={0.55 * (1 - qT * 0.6)}>
            {Array.from({length: rows}, (_, r) => {
              const shift = (f * 0.6 + r * 37) % 60;
              const s = Array.from({length: 8}, (_, k) => Math.floor(hash01(r * 31 + k, Math.floor((f + r * 7) / 12)) * 256).toString(16).padStart(2, '0').toUpperCase()).join(' ');
              return (
                <text key={r} x={-FW / 2 + 24 - shift} y={-FH / 2 + 96 + r * 22} fontFamily={MONO} fontSize={18} fill={r % 3 === 0 ? P.amber : P.mist}>
                  {s + ' ' + s}
                </text>
              );
            })}
          </g>
          <text x={0} y={-FH / 2 + 46} fontFamily={MONO} fontSize={26} fontWeight={600} fill={P.paper} textAnchor="middle" transform={`translate(-22 0)`}>
            model.gguf
          </text>
          {/* 檔案大小條：好幾 GB */}
          <rect x={-FW / 2 + 24} y={FH / 2 - 52} width={FW - 48} height={12} rx={6} fill={P.line} />
          <rect x={-FW / 2 + 24} y={FH / 2 - 52} width={(FW - 48) * ease.inOut(sizeT)} height={12} rx={6} fill={P.amber} />
          <text x={FW / 2 - 24} y={FH / 2 - 66} fontFamily={SANS} fontSize={22} fontWeight={700} fill={P.amber} textAnchor="end" opacity={progress(f, 40, 70)}>
            好幾 GB
          </text>
          {/* ？ */}
          {qT > 0 ? (
            <text x={0} y={18} fontFamily={SANS} fontSize={150} fontWeight={800} fill={P.amber} textAnchor="middle" dominantBaseline="central" opacity={qT} transform={`scale(${0.7 + 0.3 * qT})`}>
              ？
            </text>
          ) : null}
        </g>
      </svg>
    </div>
  );
};
