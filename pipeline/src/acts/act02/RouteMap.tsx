import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {CameraLayer, type Cam2D} from '../../lib/camera2d';
import {fade, make2DRig, PacketTile, SchematicTag, SectionTitle, toScreen, type Act2Times} from './shared';

/** 回程：從資料中心拉遠成示意地圖，回覆封包沿路線回到你的電腦；之後在「本地推理」時把路線剪斷。 */
export const HOME = {x: 520, y: 650};
export const DC = {x: 1480, y: 400};

type V = {x: number; y: number};
const SEGS: [V, V, V, V][] = [
  [DC, {x: 1380, y: 420}, {x: 1300, y: 470}, {x: 1200, y: 500}],
  [{x: 1200, y: 500}, {x: 1060, y: 540}, {x: 900, y: 560}, {x: 790, y: 600}],
  [{x: 790, y: 600}, {x: 700, y: 632}, {x: 600, y: 650}, HOME],
];
const bez = (s: [V, V, V, V], t: number): V => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x, y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y};
};
/** t: 0 = 資料中心, 1 = 你的電腦 */
export const routeAt = (t: number): V => {
  const k = clamp(t) * SEGS.length;
  const i = Math.min(SEGS.length - 1, Math.floor(k));
  return bez(SEGS[i], k - i);
};
const routePath = (t0: number, t1: number) => {
  const pts: string[] = [];
  const n = Math.max(2, Math.ceil((t1 - t0) * 90));
  for (let i = 0; i <= n; i++) {
    const p = routeAt(lerp(t0, t1, i / n));
    pts.push(`${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  return pts.join(' ');
};

const rigs = new Map<string, ReturnType<typeof make2DRig>>();
export const mapCam = (T: Act2Times, frame: number): Cam2D => {
  const key = `${T.ret}-${T.cloud}-${T.local}`;
  let r = rigs.get(key);
  if (!r) {
    r = make2DRig(
      [
        {f: T.ret + 6, cx: DC.x, cy: DC.y, zoom: 6},
        {f: T.ret + 62, cx: 1000, cy: 520, zoom: 1.0},
        {f: T.local - 16, cx: 990, cy: 530, zoom: 1.06},
        {f: T.local + 36, cx: HOME.x, cy: HOME.y - 4, zoom: 8},
      ],
      10,
    );
    rigs.set(key, r);
  }
  return r(frame);
};

const LAND_L =
  'M -900 -400 L 860 -400 C 900 -200 820 -60 880 80 C 930 200 860 300 900 380 C 940 470 860 560 800 640 C 760 700 820 800 760 900 C 720 980 600 1100 560 1500 L -900 1500 Z';
const LAND_R =
  'M 2900 -400 L 1240 -400 C 1200 -260 1290 -120 1220 0 C 1160 110 1250 210 1190 320 C 1140 410 1230 470 1180 540 C 1130 620 1220 720 1260 820 C 1300 920 1240 1040 1300 1500 L 2900 1500 Z';

export const RouteMap: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const cam = mapCam(T, frame);
  const answerProg = progress(frame, T.ret + 18, T.ret + 84);
  const cut = progress(frame, T.local - 22, T.local + 2);
  const titleT = fade(frame, T.cloud - 14, T.cloud + 16, T.local - 20, T.local - 4);
  const labelsT = fade(frame, T.ret + 40, T.ret + 64, T.local + 4, T.local + 18);
  const mid = toScreen(cam, routeAt(0.5).x, routeAt(0.5).y);
  const home = toScreen(cam, HOME.x, HOME.y);
  const dc = toScreen(cam, DC.x, DC.y);
  const tileScale = 1 / Math.pow(cam.zoom, 0.55);
  // 剪斷：海上段在中央裂開並向兩側收回
  const gap = ease.out(cut) * 0.22;
  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden', background: '#0A1324'}}>
      <CameraLayer cam={cam}>
        <svg width={1920} height={1080} style={{overflow: 'visible'}}>
          {/* 經緯格線 */}
          {Array.from({length: 21}).map((_, i) => (
            <line key={`v${i}`} x1={-600 + i * 160} y1={-500} x2={-600 + i * 160} y2={1600} stroke="#15213A" strokeWidth={1.2} />
          ))}
          {Array.from({length: 14}).map((_, i) => (
            <line key={`h${i}`} x1={-900} y1={-500 + i * 160} x2={2900} y2={-500 + i * 160} stroke="#15213A" strokeWidth={1.2} />
          ))}
          <path d={LAND_L} fill="#18233A" stroke="#2A3858" strokeWidth={2} />
          <path d={LAND_R} fill="#18233A" stroke="#2A3858" strokeWidth={2} />
          {/* 城市光點 */}
          {Array.from({length: 40}).map((_, i) => {
            const left = i % 2 === 0;
            const x = left ? 160 + ((i * 97) % 600) : 1300 + ((i * 131) % 700);
            const y = 120 + ((i * 173) % 820);
            return <circle key={i} cx={x} cy={y} r={2} fill={P.amber} opacity={0.18} />;
          })}
          {/* 去程路線（琥珀虛線）＋回程（冰藍，跟隨回覆封包） */}
          <path d={routePath(0, 0.5 - gap)} fill="none" stroke={P.amber} strokeWidth={2.4} strokeDasharray="8 8" opacity={0.55 * (1 - cut * 0.5)} />
          <path d={routePath(0.5 + gap, 1)} fill="none" stroke={P.amber} strokeWidth={2.4} strokeDasharray="8 8" opacity={0.55 * (1 - cut * 0.5)} />
          {answerProg > 0 ? (
            <>
              <path d={routePath(0, Math.min(answerProg, 0.5 - gap))} fill="none" stroke={P.ice} strokeWidth={3.2} opacity={0.85 * (1 - cut * 0.6)} />
              {answerProg > 0.5 + gap ? <path d={routePath(0.5 + gap, answerProg)} fill="none" stroke={P.ice} strokeWidth={3.2} opacity={0.85 * (1 - cut * 0.6)} /> : null}
            </>
          ) : null}
          {/* 剪斷處的小記號 */}
          {cut > 0.05
            ? [0.5 - gap, 0.5 + gap].map((t, i) => {
                const p = routeAt(t);
                return <line key={i} x1={p.x - 8} y1={p.y - 10} x2={p.x + 8} y2={p.y + 10} stroke={P.mist} strokeWidth={2} opacity={cut} />;
              })
            : null}
          {/* 回覆封包 */}
          {Array.from({length: 8}).map((_, i) => {
            const t = progress(frame - i * 3, T.ret + 18, T.ret + 84);
            if (t <= 0 || t >= 1) return null;
            const p = routeAt(ease.inOutSoft(t));
            const o = progress(t, 0, 0.06) * (1 - progress(t, 0.94, 1));
            return <PacketTile key={i} x={p.x} y={p.y - 2} size={20 * tileScale} o={o} answer rot={Math.sin(i + frame / 14) * 8} />;
          })}
          {/* 據點 */}
          <Pin x={DC.x} y={DC.y} color={P.ice} frame={frame} s={tileScale} />
          <Pin x={HOME.x} y={HOME.y} color={P.amber} frame={frame} s={tileScale} />
        </svg>
      </CameraLayer>
      {/* 螢幕空間標籤 */}
      <MapLabel x={dc.x} y={dc.y} text="資料中心" color={P.ice} o={labelsT} dx={30} />
      <MapLabel x={home.x} y={home.y} text="你的電腦" color={P.amber} o={labelsT} dx={-150} />
      <div
        style={{
          position: 'absolute',
          left: mid.x - 200,
          top: mid.y + 36,
          width: 400,
          textAlign: 'center',
          
          ...type.label,
          fontSize: 24,
          color: P.mist,
          opacity: labelsT * (1 - cut),
        }}
      >
        幾百～幾千公里
      </div>
      <SectionTitle text="雲端推理" t={titleT} color={P.ice} x={140} y={104} />
      <SchematicTag o={fade(frame, T.ret + 30, T.ret + 50, T.local + 4, T.local + 18)} />
    </div>
  );
};

const Pin: React.FC<{x: number; y: number; color: string; frame: number; s: number}> = ({x, y, color, frame, s}) => {
  const ring = ((frame / 50) % 1 + 1) % 1;
  return (
    <g>
      <circle cx={x} cy={y} r={(10 + ring * 34) * s} fill="none" stroke={color} strokeWidth={2 * s} opacity={0.5 * (1 - ring)} />
      <circle cx={x} cy={y} r={9 * s} fill={color} />
      <circle cx={x} cy={y} r={4 * s} fill="#0A1324" />
    </g>
  );
};

const MapLabel: React.FC<{x: number; y: number; text: string; color: string; o: number; dx: number}> = ({x, y, text, color, o, dx}) =>
  o > 0.01 ? (
    <div style={{position: 'absolute', left: x + dx, top: y - 20,  ...type.title, fontSize: 28, color, opacity: o, whiteSpace: 'nowrap', textShadow: '0 2px 10px rgba(5,8,16,0.9)'}}>
      {text}
    </div>
  ) : null;
