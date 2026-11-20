import React from 'react';
import {palette as P} from '../../theme/palette';
import {clamp, ease, lerp, progress, rng} from '../../lib/anim';
import {CameraLayer, type Cam2D} from '../../lib/camera2d';
import {make2DRig, makePath, PacketTile, type Act2Times} from './shared';

/**
 * 窗外的世界（一條連續的橫向長鏡頭）：城市 → 海岸 → 海底電纜 → 對岸 → 資料中心。
 * 世界座標：海平面 y=600，海底電纜中心 y=1300，資料中心大門 (6200, 534)。
 */
export const SEA_Y = 600;
export const CABLE_Y = 1300;
export const CUT = {x0: 1990, x1: 2390};
export const DOOR = {x: 6200, y: 532};
export const LANDING = {x: 1410, y: 552};
export const FAR_LANDING = {x: 5560, y: 552};

export const outsideCam = (T: Act2Times, frame: number, room: Cam2D): Cam2D => {
  const S: Cam2D = {cx: 620 + (room.cx - 1060) * 0.08, cy: 330 + (room.cy - 520) * 0.08, zoom: Math.pow(room.zoom, 0.12)};
  if (frame < T.packet + 30 || frame > T.local - 40) return S;
  const rig = journeyRig(T);
  const j = rig(frame);
  const k = ease.inOut(progress(frame, T.packet + 30, T.packet + 82));
  if (k >= 1) return j;
  return {cx: lerp(S.cx, j.cx, k), cy: lerp(S.cy, j.cy, k), zoom: Math.exp(lerp(Math.log(S.zoom), Math.log(j.zoom), k))};
};

const rigCache = new Map<string, ReturnType<typeof make2DRig>>();
const journeyRig = (T: Act2Times) => {
  const key = `${T.packet}-${T.cable}-${T.datacenter}`;
  let r = rigCache.get(key);
  if (!r) {
    const p = T.packet;
    const c = T.cable;
    const d = T.datacenter;
    r = make2DRig(
      [
        {f: p + 30, cx: 640, cy: 330, zoom: 1.02},
        {f: p + 66, cx: 900, cy: 370, zoom: 1.12},
        {f: Math.min(p + 94, c - 8), cx: 1250, cy: 470, zoom: 1.08},
        {f: c + 6, cx: 1520, cy: 700, zoom: 0.92},
        {f: c + 46, cx: 2170, cy: 1294, zoom: 2.45},
        {f: c + 118, cx: 2270, cy: 1296, zoom: 2.65},
        {f: d - 30, cx: 4300, cy: 1040, zoom: 0.72},
        {f: d + 2, cx: 5960, cy: 470, zoom: 1.02},
        {f: d + 32, cx: 6170, cy: 505, zoom: 1.9},
        {f: d + 74, cx: DOOR.x, cy: DOOR.y + 6, zoom: 90},
      ],
      12,
    );
    rigCache.set(key, r);
  }
  return r;
};

/** 封包在戶外的路徑：從窗戶飛過城市 → 登陸站入海（化為光脈衝）→ 對岸再組合 → 進入資料中心大門。 */
export const outsideTiles = (T: Act2Times, frame: number) => {
  const p = T.packet;
  const d = T.datacenter;
  const seg1 = makePath(
    [
      {f: p + 50, x: 640, y: 352},
      {f: p + 72, x: 960, y: 330},
      {f: Math.min(p + 92, T.cable - 10), x: 1290, y: 420},
      {f: Math.min(p + 104, T.cable - 2), x: LANDING.x, y: LANDING.y - 6},
    ],
    6,
  );
  const seg2 = makePath(
    [
      {f: d - 20, x: FAR_LANDING.x, y: FAR_LANDING.y - 6},
      {f: d + 4, x: 5800, y: 500},
      {f: d + 26, x: 6060, y: 512},
      {f: d + 44, x: DOOR.x, y: DOOR.y + 6},
    ],
    6,
  );
  const out: {x: number; y: number; o: number; s: number}[] = [];
  for (let i = 0; i < 10; i++) {
    const f = frame - i * 1.7;
    const lat = Math.sin(i * 2.3) * 12;
    if (f >= p + 50 && f <= Math.min(p + 106, T.cable)) {
      const q = seg1(f);
      const end = Math.min(p + 104, T.cable - 2);
      const o = progress(f, p + 50, p + 58) * (1 - progress(f, end - 8, end + 2));
      out.push({x: q.x + lat * 0.4, y: q.y + lat, o, s: 22 * (1 - 0.6 * progress(f, end - 10, end + 2))});
    } else if (f >= d - 20 && f <= d + 46) {
      const q = seg2(f);
      const o = progress(f, d - 20, d - 10) * (1 - progress(f, d + 38, d + 46));
      out.push({x: q.x + lat * 0.3, y: q.y + lat * 0.5, o, s: 20 * (0.5 + 0.5 * progress(f, d - 20, d - 8)) * (1 - 0.5 * progress(f, d + 34, d + 46))});
    }
  }
  return out;
};

// ---------------- 繪圖 ----------------

type Bld = {x: number; w: number; h: number; lit: [number, number, number][]};
const makeCity = (seed: number, x0: number, x1: number, hMin: number, hMax: number): Bld[] => {
  const r = rng(seed);
  const out: Bld[] = [];
  let x = x0;
  while (x < x1) {
    const w = 46 + r() * 90;
    const h = hMin + r() * (hMax - hMin);
    const lit: [number, number, number][] = [];
    for (let yy = 16; yy < h - 14; yy += 22) {
      for (let xx = 10; xx < w - 12; xx += 16) {
        const v = r();
        if (v > 0.8) lit.push([xx, yy, v > 0.94 ? 1 : 0]);
      }
    }
    out.push({x, w, h, lit});
    x += w + 4 + r() * 16;
  }
  return out;
};
const NEAR = makeCity(11, -900, 1250, 110, 330);
const MID = makeCity(23, -1400, 1900, 160, 380);
const STARS = (() => {
  const r = rng(5);
  return Array.from({length: 120}).map(() => [r() * 9000 - 1500, r() * 900 - 700, r()] as const);
})();

export const OutsideWorld: React.FC<{cam: Cam2D; frame: number; T: Act2Times}> = ({cam, frame, T}) => {
  const tiles = outsideTiles(T, frame);
  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden', background: '#0A1222'}}>
      {/* 天空 */}
      <CameraLayer cam={cam} depth={0.2}>
        <svg width={1920} height={1080} style={{overflow: 'visible'}}>
          <defs>
            <linearGradient id="a2-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#070C18" />
              <stop offset="0.7" stopColor="#111B31" />
              <stop offset="1" stopColor="#1A2540" />
            </linearGradient>
          </defs>
          <rect x={-6000} y={-3000} width={20000} height={3700} fill="url(#a2-sky)" />
          {STARS.map(([x, y, v], i) => (
            <circle key={i} cx={x} cy={y} r={0.8 + v * 1.2} fill="#DCE4F5" opacity={0.15 + v * 0.4} />
          ))}
          <circle cx={1180} cy={120} r={22} fill="#D8DDEA" opacity={0.8} />
        </svg>
      </CameraLayer>
      {/* 遠景：城市剪影與對岸山丘 */}
      <CameraLayer cam={cam} depth={0.6}>
        <svg width={1920} height={1080} style={{overflow: 'visible'}}>
          {MID.map((b, i) => (
            <rect key={i} x={b.x} y={560 - b.h} width={b.w} height={b.h + 400} fill="#131D33" />
          ))}
          {MID.filter((_, i) => i % 3 === 0).map((b, i) => (
            <rect key={i} x={b.x + b.w * 0.4} y={560 - b.h + 20} width={4} height={6} fill={P.amber} opacity={0.35} />
          ))}
          <path d="M 2600 600 C 3000 520 3300 540 3600 500 C 3900 470 4200 520 4600 480 L 4600 900 L 2600 900 Z" fill="#111A2E" />
        </svg>
      </CameraLayer>
      {/* 主景 */}
      <CameraLayer cam={cam}>
        <svg width={1920} height={1080} style={{overflow: 'visible'}}>
          <defs>
            <linearGradient id="a2-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0E2440" />
              <stop offset="0.35" stopColor="#0A1A30" />
              <stop offset="1" stopColor="#050B16" />
            </linearGradient>
            <linearGradient id="a2-shaft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={P.ice} stopOpacity={0.09} />
              <stop offset="1" stopColor={P.ice} stopOpacity={0} />
            </linearGradient>
          </defs>
          {/* 海水 */}
          <rect x={1420} y={SEA_Y} width={4220} height={2600} fill="url(#a2-water)" />
          {[1700, 2150, 2700, 3300, 3900, 4500, 5000].map((x, i) => (
            <path key={i} d={`M ${x} ${SEA_Y} L ${x + 90} ${SEA_Y} L ${x - 160} ${SEA_Y + 700} L ${x - 300} ${SEA_Y + 700} Z`} fill="url(#a2-shaft)" />
          ))}
          {/* 海面 */}
          <rect x={1420} y={SEA_Y - 1} width={4220} height={2} fill={P.ice} opacity={0.28} />
          {Array.from({length: 60}).map((_, i) => {
            const x = 1460 + i * 70 + ((frame * 0.6 + i * 23) % 40);
            return <rect key={i} x={x} y={SEA_Y + 4 + (i % 3) * 5} width={22} height={1.5} fill={P.ice} opacity={0.1} />;
          })}
          {/* 海床 */}
          <path d={`M 1300 590 L 1460 610 C 1600 700 1750 1100 1900 1322 L 5000 1322 C 5150 1100 5320 720 5560 600 L 5560 3400 L 1300 3400 Z`} fill="#131B2B" />
          <path d={`M 1460 610 C 1600 700 1750 1100 1900 1322 L 5000 1322 C 5150 1100 5320 720 5560 600`} fill="none" stroke="#24304A" strokeWidth={3} />
          {Array.from({length: 40}).map((_, i) => {
            const x = 1950 + i * 77 + Math.sin(i * 4.1) * 20;
            return <ellipse key={i} cx={x} cy={1326} rx={8 + (i % 4) * 5} ry={4 + (i % 3) * 2} fill="#1A2336" />;
          })}
          {/* 城市近景 */}
          {NEAR.map((b, i) => (
            <g key={i}>
              <rect x={b.x} y={560 - b.h} width={b.w} height={b.h} fill="#18233B" />
              <rect x={b.x} y={560 - b.h} width={b.w} height={3} fill="#24304C" />
              {b.lit.map(([xx, yy, a], j) => (
                <rect key={j} x={b.x + xx} y={560 - b.h + yy} width={7} height={9} fill={a ? P.amber : '#7E8DB0'} opacity={a ? 0.6 : 0.4} />
              ))}
            </g>
          ))}
          {/* 地面與海岸 */}
          <path d="M -3000 560 L 1300 560 C 1360 566 1420 580 1470 606 L 1470 3400 L -3000 3400 Z" fill="#101828" />
          <path d="M 5520 606 C 5560 580 5600 566 5650 560 L 9000 560 L 9000 3400 L 5520 3400 Z" fill="#0E1525" />
          <rect x={-3000} y={559} width={4300} height={2} fill="#24304C" />
          <rect x={-3000} y={574} width={4290} height={14} fill="#182236" />
          <rect x={5660} y={574} width={3400} height={14} fill="#182236" />
          {Array.from({length: 40}).map((_, i) => {
            const x = -1500 + i * 150 + (i % 2) * 20;
            if (x > 1260 && x < 5700) return null;
            return (
              <g key={`lamp${i}`}>
                <ellipse cx={x} cy={582} rx={34} ry={5} fill={P.amber} opacity={0.14} />
                <rect x={x - 1} y={548} width={2} height={28} fill="#2A3550" />
                <circle cx={x} cy={548} r={2.4} fill={P.amber} opacity={0.8} />
              </g>
            );
          })}
          {Array.from({length: 26}).map((_, i) => (
            <rect key={`car${i}`} x={((frame * (i % 2 ? 3 : -2.4) + i * 173) % 4200 + 4200) % 4200 - 2900} y={i % 2 ? 577 : 582} width={10} height={2.4} fill={i % 2 ? '#F5E6C8' : '#E0605A'} opacity={0.55} />
          ))}
          <rect x={5650} y={559} width={3400} height={2} fill="#24304C" />
          {/* 登陸站 */}
          <LandingStation x={LANDING.x - 40} />
          <LandingStation x={FAR_LANDING.x - 20} />
          {/* 海底電纜 */}
          <Cable frame={frame} T={T} />
          {/* 資料中心 */}
          <Datacenter frame={frame} />
          {/* 封包 */}
          {tiles.map((t, i) => (
            <PacketTile key={i} x={t.x} y={t.y} size={t.s} o={t.o} rot={Math.sin(i * 1.7 + frame / 20) * 6} />
          ))}
        </svg>
      </CameraLayer>
    </div>
  );
};

const LandingStation: React.FC<{x: number}> = ({x}) => (
  <g>
    <rect x={x} y={526} width={64} height={34} fill="#1C2436" />
    <rect x={x} y={522} width={64} height={5} fill="#2A3550" />
    <rect x={x + 8} y={536} width={12} height={8} fill={P.ice} opacity={0.45} />
    <rect x={x + 44} y={540} width={12} height={20} fill="#10151F" />
  </g>
);

const cableD = `M ${LANDING.x} ${LANDING.y + 4} C 1460 570 1480 600 1500 640 C 1620 860 1760 1180 1900 ${CABLE_Y} L 5000 ${CABLE_Y} C 5160 1180 5300 860 5440 640 C 5470 600 5500 572 ${FAR_LANDING.x} ${FAR_LANDING.y + 4}`;

const Cable: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const y = CABLE_Y;
  const R = 17; // 外護套
  const A = 13; // 鋼絲鎧裝
  const Cu = 9.5; // 銅管
  const In = 6.5; // 光纖單元
  const {x0, x1} = CUT;
  const live = progress(frame, T.cable - 20, T.cable) * (1 - progress(frame, T.datacenter + 10, T.datacenter + 30));
  // 沿整條電纜行進的訊號光（示意）
  const signalX = (k: number) => 1500 + (((frame - T.cable) * 46 + k * 520) % 3800 + 3800) % 3800;
  return (
    <g>
      <defs>
        <linearGradient id="a2-sheath" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3A4560" />
          <stop offset="0.45" stopColor="#222A3B" />
          <stop offset="1" stopColor="#11151F" />
        </linearGradient>
        <linearGradient id="a2-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#B8C0CF" />
          <stop offset="0.5" stopColor="#6B7489" />
          <stop offset="1" stopColor="#2E3546" />
        </linearGradient>
        <linearGradient id="a2-copper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E7A56E" />
          <stop offset="0.5" stopColor={P.copper} />
          <stop offset="1" stopColor="#6E4426" />
        </linearGradient>
        <pattern id="a2-armour" width={6} height={30} patternUnits="userSpaceOnUse" patternTransform="skewX(-35)">
          <rect width={6} height={30} fill="url(#a2-steel)" />
          <rect width={1.2} height={30} fill="#1A1F2B" opacity={0.7} />
        </pattern>
      </defs>
      {/* 傾斜段（整條） */}
      <path d={cableD} fill="none" stroke="#0B0F17" strokeWidth={2 * R + 4} strokeLinecap="round" />
      <path d={cableD} fill="none" stroke="#252D3F" strokeWidth={2 * R} strokeLinecap="round" />
      <path d={cableD} fill="none" stroke="#46516C" strokeWidth={3} strokeLinecap="round" transform="translate(0 -9)" opacity={0.7} />
      {/* 水平段的護套（切開處留空） */}
      <rect x={1900} y={y - R} width={x0 - 1900} height={2 * R} fill="url(#a2-sheath)" />
      <rect x={x1} y={y - R} width={5000 - x1} height={2 * R} fill="url(#a2-sheath)" />
      {/* 剖面：鋼絲 → 銅管 → 光纖 */}
      <rect x={x0} y={y - A} width={60} height={2 * A} fill="url(#a2-armour)" />
      <rect x={x1 - 60} y={y - A} width={60} height={2 * A} fill="url(#a2-armour)" />
      <rect x={x0 + 60} y={y - Cu} width={60} height={2 * Cu} fill="url(#a2-copper)" />
      <rect x={x1 - 120} y={y - Cu} width={60} height={2 * Cu} fill="url(#a2-copper)" />
      <rect x={x0 + 120} y={y - In} width={x1 - x0 - 240} height={2 * In} fill="#0A111D" />
      {/* 切口端面（橢圓） */}
      {[
        [x0, R, '#2E374C'],
        [x0 + 60, A, '#59627A'],
        [x0 + 120, Cu, '#8C5A35'],
      ].map(([x, r, c], i) => (
        <ellipse key={i} cx={x as number} cy={y} rx={3.4} ry={r as number} fill={c as string} />
      ))}
      {[
        [x1, R, '#2E374C'],
        [x1 - 60, A, '#59627A'],
        [x1 - 120, Cu, '#8C5A35'],
      ].map(([x, r, c], i) => (
        <ellipse key={`r${i}`} cx={x as number} cy={y} rx={3.4} ry={r as number} fill={c as string} />
      ))}
      {/* 光纖與光脈衝 */}
      {[-4.4, -1.5, 1.5, 4.4].map((dy, fi) => (
        <g key={fi}>
          <rect x={x0 + 120} y={y + dy - 0.55} width={x1 - x0 - 240} height={1.1} fill={fi % 2 ? '#2C5F8A' : '#6B5A35'} />
          {live > 0
            ? Array.from({length: 4}).map((_, k) => {
                const span = x1 - x0 - 240;
                const t = ((((frame - T.cable) * 2.6 + k * span * 0.25 + fi * 23) % span) + span) % span;
                const env = Math.sin((t / span) * Math.PI);
                return <rect key={k} x={x0 + 120 + t - 9} y={y + dy - 1} width={18} height={2} fill={fi % 2 ? P.ice : P.amber} opacity={live * env} />;
              })
            : null}
        </g>
      ))}
      {/* 沿電纜行進的訊號（示意） */}
      {live > 0
        ? [0, 1, 2, 3, 4, 5, 6].map((k) => {
            const sx = signalX(k);
            if (sx > x0 - 30 && sx < x1 + 30) return null;
            if (sx < 1900 || sx > 5000) return null;
            return <rect key={k} x={sx - 40} y={y - 1.2} width={80} height={2.4} fill={P.ice} opacity={0.55 * live} />;
          })
        : null}
    </g>
  );
};

const Datacenter: React.FC<{frame: number}> = ({frame}) => {
  const x0 = 5800;
  const x1 = 6600;
  const top = 420;
  const base = 560;
  return (
    <g>
      {/* 附屬建築與發電機 */}
      <rect x={6620} y={486} width={200} height={74} fill="#161E30" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={6636 + i * 62} y={504} width={48} height={36} fill="#1E2739" stroke="#2A3550" strokeWidth={1.5} />
      ))}
      {/* 主建築 */}
      <rect x={x0} y={top} width={x1 - x0} height={base - top} fill="#1B2335" />
      {Array.from({length: 20}).map((_, i) => (
        <rect key={i} x={x0 + 20 + i * 40} y={top} width={1.5} height={base - top} fill="#243049" />
      ))}
      <rect x={x0} y={top} width={x1 - x0} height={4} fill="#2C3858" />
      {/* 百葉帶 */}
      <rect x={x0 + 30} y={446} width={x1 - x0 - 60} height={28} fill="#121928" />
      {Array.from({length: 6}).map((_, i) => (
        <rect key={i} x={x0 + 30} y={449 + i * 4.4} width={x1 - x0 - 60} height={1.4} fill="#26314A" />
      ))}
      {/* 屋頂冷卻機組 */}
      {Array.from({length: 11}).map((_, i) => {
        const cx = x0 + 50 + i * 68;
        return (
          <g key={i}>
            <rect x={cx - 28} y={top - 16} width={56} height={16} fill="#232C40" />
            {[-13, 13].map((dx) => (
              <g key={dx}>
                <ellipse cx={cx + dx} cy={top - 16} rx={10} ry={2.6} fill="#0F1420" />
                <line
                  x1={cx + dx - Math.cos(frame * 0.3 + i + dx) * 9}
                  y1={top - 16}
                  x2={cx + dx + Math.cos(frame * 0.3 + i + dx) * 9}
                  y2={top - 16}
                  stroke="#3A4560"
                  strokeWidth={1.2}
                />
              </g>
            ))}
          </g>
        );
      })}
      {/* 窗帶：冷色機房光 */}
      {[5880, 5960, 6040, 6340, 6420, 6500].map((x, i) => (
        <rect key={i} x={x} y={490} width={44} height={8} fill={P.ice} opacity={0.32 + ((i * 3) % 4) * 0.06} />
      ))}
      {/* 大門與雨遮 */}
      <rect x={DOOR.x - 40} y={500} width={80} height={5} fill="#2E3A58" />
      <ellipse cx={DOOR.x} cy={base} rx={70} ry={10} fill={P.ice} opacity={0.12} />
      <rect x={DOOR.x - 18} y={507} width={36} height={53} fill="#CFE6FF" />
      <rect x={DOOR.x - 18} y={507} width={36} height={53} fill="none" stroke="#3A4C70" strokeWidth={2} />
      <rect x={DOOR.x - 0.6} y={507} width={1.2} height={53} fill="#7FA6D0" />
      {/* 圍籬與路燈 */}
      {Array.from({length: 34}).map((_, i) => (
        <rect key={i} x={5680 + i * 36} y={540} width={2} height={20} fill="#2A3550" />
      ))}
      <rect x={5680} y={544} width={1190} height={1.2} fill="#2A3550" />
      {[5720, 6000, 6400, 6860].map((x) => (
        <g key={x}>
          <rect x={x} y={470} width={3} height={90} fill="#2A3550" />
          <rect x={x - 6} y={468} width={14} height={3} fill="#2A3550" />
          <ellipse cx={x + 1.5} cy={556} rx={30} ry={5} fill={P.amber} opacity={0.12} />
          <circle cx={x + 1.5} cy={472} r={3} fill={P.amber} opacity={0.85} />
        </g>
      ))}
      {/* 樹 */}
      {[5640, 5690, 6900, 6950, 7010].map((x, i) => (
        <ellipse key={x} cx={x} cy={540 - (i % 2) * 6} rx={18} ry={26} fill="#142030" />
      ))}
    </g>
  );
};

export const doorScreenFill = (cam: Cam2D) => clamp((cam.zoom - 6) / 20);
