import React from 'react';
import {palette as P} from '../../theme/palette';
import {ease, progress} from '../../lib/anim';

/** 房間（世界座標 1920×1080 附近）：右牆窗戶是「洞」，窗外由 Outside 圖層透出。 */
export const WINDOW = {x0: 1380, x1: 1740, y0: 150, y1: 560};
export const WINDOW_C = {x: 1560, y: 360};
export const ROUTER = {x: 1560, y: 548};

export const RoomBack: React.FC<{frame: number; routerHit: number}> = ({frame, routerHit}) => {
  const W = WINDOW;
  return (
    <g>
      <path d={`M -4000 -3000 H 6000 V 5000 H -4000 Z M ${W.x0} ${W.y0} V ${W.y1} H ${W.x1} V ${W.y0} Z`} fill={P.wall} fillRule="evenodd" />
      {/* 牆面壁板 */}
      {Array.from({length: 22}).map((_, i) => {
        const x = -600 + i * 220;
        if (x > W.x0 - 10 && x < W.x1 + 10) return null;
        return <rect key={i} x={x} y={-400} width={2} height={1368} fill={P.wallLight} opacity={0.5} />;
      })}
      {/* 螢幕對牆面的冷光 */}
      <defs>
        <radialGradient id="a2-pool-screen" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={P.ice} stopOpacity={0.13} />
          <stop offset="1" stopColor={P.ice} stopOpacity={0} />
        </radialGradient>
        <radialGradient id="a2-pool-lamp" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={P.amber} stopOpacity={0.18} />
          <stop offset="1" stopColor={P.amber} stopOpacity={0} />
        </radialGradient>
      </defs>
      <ellipse cx={960} cy={470} rx={430} ry={300} fill="url(#a2-pool-screen)" />
      {/* 窗框、橫檔、窗台、窗簾 */}
      <rect x={W.x0 - 7} y={W.y0 - 7} width={W.x1 - W.x0 + 14} height={W.y1 - W.y0 + 14} fill="none" stroke="#232E48" strokeWidth={14} />
      <rect x={W.x0} y={244} width={W.x1 - W.x0} height={9} fill="#232E48" />
      <path d={`M ${W.x0 + 40} ${W.y0} L ${W.x0 + 110} ${W.y0} L ${W.x0 + 10} ${W.y1} L ${W.x0} ${W.y1} L ${W.x0} ${W.y0 + 120} Z`} fill="#FFFFFF" opacity={0.035} />
      <rect x={1356} y={W.y1} width={408} height={18} fill="#283453" />
      <rect x={1356} y={W.y1 + 18} width={408} height={5} fill="#1C2640" />
      <path d="M 1318 128 L 1376 128 C 1366 300 1384 460 1366 600 L 1312 600 C 1328 460 1306 300 1318 128 Z" fill="#26304A" />
      <path d="M 1744 128 L 1802 128 C 1812 300 1792 460 1808 600 L 1754 600 C 1770 460 1752 300 1744 128 Z" fill="#26304A" />
      <rect x={1300} y={122} width={520} height={8} fill="#1E2840" />
      <Router frame={frame} hit={routerHit} />
      {/* 左側層架 */}
      <rect x={250} y={300} width={300} height={10} fill={P.woodEdge} />
      <rect x={270} y={242} width={22} height={58} fill="#3D4A6A" />
      <rect x={296} y={252} width={18} height={48} fill="#6B4E45" />
      <rect x={318} y={236} width={26} height={64} fill="#2F3D5C" />
      <rect x={350} y={258} width={16} height={42} fill="#5E6F94" />
      <path d="M 470 300 C 470 270 490 256 506 256 C 522 256 542 270 542 300 Z" fill="#2E4A44" />
      <path d="M 506 258 C 500 236 488 226 478 222 M 506 258 C 512 232 526 224 536 222" stroke="#3E6A5E" strokeWidth={5} fill="none" strokeLinecap="round" />
      {/* 牆上掛畫（與第一幕相同母題） */}
      <g transform="translate(330 420)">
        <rect x={0} y={0} width={150} height={112} fill="#111829" stroke="#2C3858" strokeWidth={6} />
        {Array.from({length: 5 * 4}).map((_, i) => {
          const cx = i % 5;
          const cy = Math.floor(i / 5);
          const v = Math.sin(i * 12.9898) * 0.5 + 0.5;
          return <rect key={i} x={16 + cx * 25} y={14 + cy * 22} width={17} height={14} fill={v > 0.55 ? P.amber : P.ice} opacity={0.15 + v * 0.35} />;
        })}
      </g>
      {/* 地板 */}
      <rect x={-4000} y={968} width={10000} height={2000} fill={P.floor} />
      <rect x={-4000} y={952} width={10000} height={16} fill="#1A2238" />
    </g>
  );
};

const Router: React.FC<{frame: number; hit: number}> = ({frame, hit}) => {
  const {x, y} = ROUTER;
  return (
    <g>
      <line x1={x - 36} y1={y - 8} x2={x - 50} y2={y - 64} stroke="#2E3850" strokeWidth={5} strokeLinecap="round" />
      <line x1={x + 36} y1={y - 8} x2={x + 50} y2={y - 64} stroke="#2E3850" strokeWidth={5} strokeLinecap="round" />
      <path d={`M ${x - 52} ${y - 10} L ${x + 52} ${y - 10} L ${x + 56} ${y + 12} L ${x - 56} ${y + 12} Z`} fill="#1E2638" />
      <rect x={x - 52} y={y - 10} width={104} height={3} fill="#3A4560" />
      {[0, 1, 2, 3].map((i) => {
        const blink = (Math.floor(frame / (5 + i)) + i) % 3 !== 0;
        const lit = 0.35 + 0.35 * (blink ? 1 : 0) + hit * 0.6;
        return <circle key={i} cx={x - 24 + i * 16} cy={y + 3} r={2.4} fill={i === 0 ? P.mint : P.ice} opacity={Math.min(1, lit)} />;
      })}
      {hit > 0.01 ? <ellipse cx={x} cy={y} rx={90} ry={34} fill={P.ice} opacity={0.12 * hit} /> : null}
    </g>
  );
};

export const Desk: React.FC<{frame: number}> = () => (
  <g>
    {/* 桌腳 */}
    <rect x={500} y={714} width={22} height={256} fill="#2E2321" />
    <rect x={1398} y={714} width={22} height={256} fill="#2E2321" />
    <rect x={522} y={740} width={876} height={10} fill="#2A201E" />
    {/* 桌面（略俯視） */}
    <path d="M 520 590 L 1400 590 L 1440 700 L 480 700 Z" fill={P.woodTop} />
    <path d="M 520 590 L 1400 590" stroke="#7C5E53" strokeWidth={2} />
    <rect x={480} y={700} width={960} height={16} fill={P.woodEdge} />
    {/* 檯燈光池 */}
    <ellipse cx={640} cy={650} rx={210} ry={56} fill="url(#a2-pool-lamp)" />
    {/* 檯燈 */}
    <ellipse cx={600} cy={642} rx={40} ry={7} fill="#262D40" />
    <line x1={600} y1={640} x2={572} y2={520} stroke="#3A4460" strokeWidth={7} strokeLinecap="round" />
    <line x1={572} y1={520} x2={640} y2={470} stroke="#3A4460" strokeWidth={7} strokeLinecap="round" />
    <path d="M 624 456 L 676 470 L 666 504 L 628 492 Z" fill="#454F6C" />
    <path d="M 628 492 L 666 504" stroke={P.amber} strokeWidth={4} strokeLinecap="round" />
    <path d="M 630 494 L 668 506 L 740 660 L 560 660 Z" fill={P.amber} opacity={0.045} />
    {/* 筆記本 */}
    <path d="M 640 668 L 740 668 L 748 690 L 632 690 Z" fill="#2F3B5A" />
    <path d="M 646 671 L 736 671" stroke="#8A97B4" strokeWidth={1} opacity={0.4} />
    {/* 馬克杯 */}
    <path d="M 1236 620 L 1274 620 L 1270 662 L 1240 662 Z" fill="#C9583F" />
    <path d="M 1274 628 C 1290 628 1290 650 1272 650" stroke="#C9583F" strokeWidth={6} fill="none" />
    <rect x={1236} y={620} width={38} height={4} fill="#E47A60" />
    {/* 手機 */}
    <path d="M 1300 676 L 1352 676 L 1358 690 L 1296 690 Z" fill="#141924" />
  </g>
);

/** 「不用離開你的桌面」：桌面周圍的琥珀色邊界（虛線＋轉角）。 */
export const DeskBoundary: React.FC<{t: number; frame: number}> = ({t, frame}) => {
  if (t <= 0.001) return null;
  const x0 = 452;
  const x1 = 1350;
  const y0 = 300;
  const y1 = 738;
  const k = ease.out(t);
  const c = 26;
  return (
    <g>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={P.amber} opacity={0.035 * k} />
      <rect
        x={x0}
        y={y0}
        width={x1 - x0}
        height={y1 - y0}
        fill="none"
        stroke={P.amber}
        strokeWidth={2}
        strokeDasharray="10 9"
        strokeDashoffset={-frame * 0.4}
        opacity={0.75}
        style={{clipPath: `inset(0 ${(1 - k) * 100}% 0 0)`}}
      />
      {[
        [x0, y0, 1, 1],
        [x1, y0, -1, 1],
        [x0, y1, 1, -1],
        [x1, y1, -1, -1],
      ].map(([x, y, sx, sy], i) => (
        <path key={i} d={`M ${x} ${y + sy * c} L ${x} ${y} L ${x + sx * c} ${y}`} fill="none" stroke={P.amber} strokeWidth={4} opacity={progress(t, 0.1 + i * 0.1, 0.5 + i * 0.1)} />
      ))}
    </g>
  );
};
