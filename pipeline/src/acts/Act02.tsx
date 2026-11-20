import React, {useMemo} from 'react';
import {AbsoluteFill} from 'remotion';
import * as THREE from 'three';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {clamp, ease, lerp, progress} from '../lib/anim';
import {CameraLayer, type Cam2D} from '../lib/camera2d';
import {buildCamera, project} from '../lib/camera3d';
import {Vignette} from '../components/Vignette';
import {Callout, fade, getTimes, make2DRig, PacketTile, SchematicTag, SectionTitle, toScreen, type Act2Times} from './act02/shared';
import {bubbleCharPos, chipCenter, FILE_H, fileCenter, Laptop, type LaptopState, ModelFile, PROMPT, ssdCenter} from './act02/Laptop';
import {DeskBoundary, Desk, ROUTER, RoomBack, WINDOW_C} from './act02/Room';
import {CABLE_Y, CUT, DOOR, OutsideWorld, outsideCam} from './act02/Outside';
import {Datacenter3D, dcRig, targetFront} from './act02/Datacenter3D';
import {RouteMap} from './act02/RouteMap';
import {Compare, LAPTOP_SCREEN} from './act02/Compare';

/**
 * 第 02 幕：本地 AI 與雲端 AI。
 * 鏡頭：筆電螢幕 → 拉出夜晚書桌 → 文字碎成封包 → 穿窗而出，越過城市、潛入海底電纜 → 對岸資料中心 → 3D 機房
 * → 拉高成示意地圖，回覆沿路線回家（雲端推理）→ 路線剪斷，回到同一台筆電（本地推理，X 光看見 SSD 上的模型檔案）
 * → 拉開成雲端／本地雙側對照 → 推進到模型檔案（收合轉場）。
 */
export const Act02: React.FC<ActProps> = ({frame, durationInFrames, anchors}) => {
  const T = useMemo(() => getTimes(anchors, durationInFrames), [anchors, durationInFrames]);
  const rigs = useMemo(() => makeRigs(T), [T]);
  const f = frame;

  // ---- 各段可見範圍 ----
  const phaseA = f < T.packet + 92;
  const roomCamA = rigs.roomA(f);
  const roomCamC = rigs.roomC(f);
  const inC = f >= T.local - 2;
  const roomCam = inC ? roomCamC : roomCamA;
  const roomVisible = inC || (phaseA && !(f > T.packet + 50 && roomCamA.zoom > 6.2));
  const outsideOn = f < T.datacenter + 80 || inC;
  const dcOn = f >= T.datacenter + 56 && f < T.ret + 52;
  const dcO = progress(f, T.datacenter + 58, T.datacenter + 76);
  const mapOn = f >= T.ret + 12 && f < T.local + 38;
  const mapO = progress(f, T.ret + 14, T.ret + 34) * (1 - progress(f, T.local + 10, T.local + 36));
  const oCam = outsideCam(T, f, roomCam);

  const lap = laptopState(T, f);
  const compareO = progress(f, T.compare - 20, T.compare + 30) * (1 - progress(f, T.question - 90, T.question - 40));
  const fileRise = ease.out(progress(f, T.disk - 18, T.disk + 22));
  const fc = fileCenter(fileRise);

  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden'}}>
      {outsideOn && (!dcOn || dcO < 1) && (!mapOn || mapO < 1) ? <OutsideWorld cam={oCam} frame={f} T={T} /> : null}

      {roomVisible && (!mapOn || mapO < 1) ? (
        <CameraLayer cam={roomCam}>
          <svg width={1920} height={1080} style={{overflow: 'visible'}}>
            <RoomBack frame={f} routerHit={routerHit(T, f)} />
            <Desk frame={f} />
            <NotLocalHint T={T} f={f} />
            {inC ? <rect x={-4000} y={-3000} width={10000} height={8000} fill={P.ink} opacity={0.93 * progress(f, T.compare - 30, T.compare + 40)} /> : null}
            {inC ? <DeskBoundary t={fade(f, T.stay - 24, T.stay + 30, T.compare - 30, T.compare + 10)} frame={f} /> : null}
            <Laptop s={lap} />
            {inC ? <LocalFlow T={T} f={f} /> : <RoomPackets T={T} f={f} />}
            {inC ? (
              <ModelFile
                cx={fc.x}
                cy={fc.y}
                h={FILE_H * fileRise}
                o={progress(f, T.disk - 18, T.disk - 6)}
                glow={Math.max(fade(f, T.disk, T.disk + 20, T.stay - 20, T.stay + 20), progress(f, T.question - 40, T.question + 10))}
                frame={f}
              />
            ) : null}
          </svg>
        </CameraLayer>
      ) : null}

      {/* 戶外段落的標註 */}
      {!inC && f > T.packet ? <JourneyLabels T={T} f={f} roomCam={roomCamA} oCam={oCam} /> : null}

      {dcOn ? (
        <div style={{position: 'absolute', inset: 0, opacity: dcO}}>
          <Datacenter3D frame={f} T={T} />
          <DcLabels T={T} f={f} />
        </div>
      ) : null}

      {mapOn ? (
        <div style={{position: 'absolute', inset: 0, opacity: mapO}}>
          <RouteMap frame={f} T={T} />
        </div>
      ) : null}

      {inC ? <LocalLabels T={T} f={f} cam={roomCamC} /> : null}
      {inC ? <Compare frame={f} T={T} o={compareO} /> : null}
      <Vignette strength={0.5} />
    </AbsoluteFill>
  );
};

// ---------------- 攝影機 ----------------

const makeRigs = (T: Act2Times) => {
  const fcEnd = fileCenter(1);
  const cmp = {cx: 960 - (LAPTOP_SCREEN.x - 960) / LAPTOP_SCREEN.zoom, cy: 540 - (LAPTOP_SCREEN.y - 540) / LAPTOP_SCREEN.zoom, zoom: LAPTOP_SCREEN.zoom};
  const p = T.packet;
  const roomA = make2DRig(
    [
      {f: 0, cx: 960, cy: 492, zoom: 2.75},
      {f: T.laptop - 16, cx: 962, cy: 494, zoom: 2.35},
      {f: T.laptop + 110, cx: 1060, cy: 520, zoom: 1.0},
      {f: Math.min(T.notlocal + 90, p - 80), cx: 1110, cy: 505, zoom: 1.03},
      {f: p - 40, cx: 985, cy: 490, zoom: 1.7},
      {f: p + 8, cx: 1000, cy: 482, zoom: 1.66},
      {f: p + 36, cx: 1370, cy: 468, zoom: 1.5},
      {f: p + 60, cx: 1555, cy: 382, zoom: 2.7},
      {f: p + 88, cx: WINDOW_C.x, cy: WINDOW_C.y, zoom: 10},
    ],
    12,
  );
  const roomC = make2DRig(
    [
      {f: T.local - 4, cx: 960, cy: 500, zoom: 3.0},
      {f: T.local + 70, cx: 975, cy: 545, zoom: 1.6},
      {f: T.disk - 30, cx: 1012, cy: 598, zoom: 2.4},
      {f: T.disk + 60, cx: 1000, cy: 590, zoom: 2.5},
      {f: T.stay - 60, cx: 985, cy: 560, zoom: 1.9},
      {f: T.stay + 40, cx: 920, cy: 520, zoom: 1.0},
      {f: T.compare - 30, cx: 915, cy: 520, zoom: 1.0},
      {f: T.compare + 50, ...cmp},
      {f: T.question - 70, ...cmp},
      {f: T.question + 56, cx: fcEnd.x, cy: fcEnd.y, zoom: 8.5},
      {f: T.end, cx: fcEnd.x, cy: fcEnd.y, zoom: 9.4},
    ],
    14,
  );
  return {roomA, roomC};
};

// ---------------- 筆電狀態 ----------------

const laptopState = (T: Act2Times, f: number): LaptopState => {
  const inC = f >= T.local - 2;
  if (!inC) {
    return {
      frame: f,
      mode: 'cloud',
      typed: lerp(0, PROMPT.length, progress(f, 34, T.hook - 34)),
      sent: progress(f, T.hook - 26, T.hook - 6),
      charsHidden: progress(f, T.packet - 4, T.packet + 18),
      waiting: progress(f, T.hook + 30, T.hook + 50),
      answer: 0,
      xray: 0,
      ssdGlow: 0,
      chipGlow: 0,
      weightFlow: 0,
    };
  }
  const hwGlow = fade(f, T.hw - 10, T.hw + 20, T.offline - 10, T.offline + 20);
  return {
    frame: f,
    mode: 'local',
    typed: PROMPT.length,
    sent: 1,
    charsHidden: 0,
    waiting: 0,
    answer: progress(f, T.disk + 96, T.stay - 30),
    xray: progress(f, T.local + 36, T.local + 96),
    ssdGlow: Math.max(fade(f, T.disk - 30, T.disk, T.stay, T.stay + 40), 0.5 * progress(f, T.question - 60, T.question)),
    chipGlow: Math.max(fade(f, T.disk + 56, T.disk + 90, T.stay + 10, T.stay + 60), hwGlow),
    weightFlow: fade(f, T.disk + 26, T.disk + 56, T.stay + 10, T.stay + 50),
  };
};

// ---------------- 房間內的封包 ----------------

type Pt = {x: number; y: number};
const qb = (a: Pt, c: Pt, b: Pt, t: number): Pt => ({
  x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
  y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
});

const roomTile = (T: Act2Times, f: number, i: number) => {
  const tau = f - (T.packet + i * 2.2);
  const c = bubbleCharPos(i);
  const lat = Math.sin(i * 2.1) * 14;
  if (tau < -14) return null;
  if (tau < 0) {
    const k = ease.out(progress(tau, -14, 0));
    return {x: c.x, y: c.y, s: 13 * k, o: 1, charO: 1, rot: 0};
  }
  if (tau < 34) {
    const k = ease.inOutSoft(tau / 34);
    const p = qb(c, {x: 1240, y: 300 + lat * 3}, {x: ROUTER.x + lat * 1.8, y: ROUTER.y - 22}, k);
    return {x: p.x, y: p.y, s: lerp(13, 18, k), o: 1, charO: 1 - progress(tau, 4, 22), rot: Math.sin(tau / 8 + i) * 8};
  }
  if (tau < 64) {
    const k = ease.inOutSoft((tau - 34) / 30);
    const p = qb({x: ROUTER.x + lat * 1.8, y: ROUTER.y - 22}, {x: WINDOW_C.x + lat * 2, y: 470}, {x: WINDOW_C.x + lat * 1.2, y: WINDOW_C.y - 10 + lat}, k);
    return {x: p.x, y: p.y, s: lerp(18, 13, k), o: 1 - progress(tau, 44, 54), charO: 0, rot: Math.sin(tau / 8 + i) * 8};
  }
  return null;
};

const routerHit = (T: Act2Times, f: number) => {
  let h = 0;
  for (let i = 0; i < PROMPT.length; i++) {
    const tau = f - (T.packet + i * 2.2);
    h = Math.max(h, Math.exp(-((tau - 34) ** 2) / 40));
  }
  return h;
};

const RoomPackets: React.FC<{T: Act2Times; f: number}> = ({T, f}) => {
  // 開場鉤子：「飛越」時，一顆封包從泡泡起飛、劃出畫面
  const hk = progress(f, T.hook - 8, T.hook + 36);
  const hookTile =
    hk > 0 && hk < 1
      ? (() => {
          const a = {x: 1080, y: 446};
          const b = {x: 1500, y: 180};
          const items = [0, 4, 8].map((lag, j) => {
            const k = ease.in(clamp(progress(f - lag, T.hook - 8, T.hook + 36)));
            const p = qb(a, {x: 1240, y: 470}, b, k);
            return <PacketTile key={j} x={p.x} y={p.y} size={12 + k * 6} o={(j === 0 ? 1 : 0.35 / j) * progress(f - lag, T.hook - 8, T.hook - 2)} rot={k * 30} />;
          });
          return <g>{items.reverse()}</g>;
        })()
      : null;
  return (
    <g>
      {hookTile}
      {PROMPT.split('').map((ch, i) => {
        const t = roomTile(T, f, i);
        if (!t) return null;
        return <PacketTile key={i} x={t.x} y={t.y} size={t.s} o={t.o} rot={t.rot} char={ch} charO={t.charO} />;
      })}
    </g>
  );
};

/** 「不是在你的電腦上算的」：一條冷色虛線從筆電延伸出窗外。 */
const NotLocalHint: React.FC<{T: Act2Times; f: number}> = ({T, f}) => {
  const t = progress(f, T.notlocal - 10, T.notlocal + 50);
  const o = 1 - progress(f, T.packet - 30, T.packet - 4);
  if (t <= 0 || o <= 0 || f > T.local) return null;
  const a = {x: 1100, y: 430};
  const c = {x: 1380, y: 250};
  const b = {x: 1700, y: 300};
  const n = Math.floor(ease.inOut(t) * 40);
  return (
    <g opacity={o}>
      {Array.from({length: n}).map((_, i) => {
        const p0 = qb(a, c, b, i / 40);
        const p1 = qb(a, c, b, (i + 0.5) / 40);
        return <line key={i} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={P.ice} strokeWidth={2.2} opacity={0.75} strokeLinecap="round" />;
      })}
      {n > 2
        ? (() => {
            const p = qb(a, c, b, n / 40);
            return <circle cx={p.x} cy={p.y} r={4} fill={P.ice} />;
          })()
        : null}
    </g>
  );
};

/** 本地推理：提問化為小封包，往下流進晶片；權重從 SSD 經記憶體流向晶片（在 Laptop 內）。 */
const LocalFlow: React.FC<{T: Act2Times; f: number}> = ({T, f}) => {
  const chip = chipCenter();
  return (
    <g>
      {Array.from({length: 6}).map((_, i) => {
        const t = progress(f - i * 4, T.disk + 40, T.disk + 84);
        if (t <= 0 || t >= 1) return null;
        const a = bubbleCharPos(i * 2);
        const p = qb(a, {x: a.x - 40, y: 560}, {x: chip.x, y: chip.y - 2}, ease.inOutSoft(t));
        return <PacketTile key={i} x={p.x} y={p.y} size={lerp(12, 6, t)} o={1 - progress(t, 0.8, 1)} rot={t * 40} />;
      })}
    </g>
  );
};

// ---------------- 標註 ----------------

const JourneyLabels: React.FC<{T: Act2Times; f: number; roomCam: Cam2D; oCam: Cam2D}> = ({T, f, roomCam, oCam}) => {
  const r = toScreen(roomCam, ROUTER.x, ROUTER.y + 10);
  const routerT = fade(f, T.packet + 22, T.packet + 40, T.packet + 52, T.packet + 62);
  const sheath = toScreen(oCam, CUT.x1 + 90, CABLE_Y + 14);
  const fiber = toScreen(oCam, CUT.x0 + 200, CABLE_Y - 1.5);
  const cableT = fade(f, T.cable + 34, T.cable + 60, T.datacenter - 44, T.datacenter - 32);
  const fiberT = fade(f, T.cable + 50, T.cable + 76, T.datacenter - 44, T.datacenter - 32);
  const roof = toScreen(oCam, DOOR.x + 120, 420);
  const dcT = fade(f, T.datacenter - 6, T.datacenter + 14, T.datacenter + 40, T.datacenter + 52);
  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      <Callout x={r.x} y={r.y} dx={-140} dy={150} title="路由器" t={routerT} color={P.ice} />
      <Callout x={sheath.x} y={sheath.y} dx={110} dy={150} title="海底電纜" t={cableT} color={P.paper} />
      <Callout x={fiber.x} y={fiber.y} dx={130} dy={-170} title="光纖" sub="資料化為光脈衝" t={fiberT} color={P.ice} />
      <Callout x={roof.x} y={roof.y} dx={120} dy={-140} title="資料中心" t={dcT} color={P.ice} />
      <SchematicTag o={fade(f, T.cable + 30, T.cable + 50, T.datacenter - 40, T.datacenter - 28)} />
    </div>
  );
};

const DcLabels: React.FC<{T: Act2Times; f: number}> = ({T, f}) => {
  const rig = useMemo(() => dcRig(T), [T]);
  const cam = buildCamera(rig(f));
  const tf = targetFront();
  const p = project(cam, new THREE.Vector3(tf.x, 2.0, tf.z));
  const t = fade(f, T.servers - 8, T.servers + 16, T.ret - 20, T.ret - 4);
  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      {p.visible ? <Callout x={p.x} y={p.y} dx={140} dy={-130} title="GPU 伺服器" t={t} color={P.amber} /> : null}
    </div>
  );
};

const LocalLabels: React.FC<{T: Act2Times; f: number; cam: Cam2D}> = ({T, f, cam}) => {
  const titleT = fade(f, T.local + 4, T.local + 34, T.disk - 50, T.disk - 30);
  const fcw = fileCenter(1);
  const file = toScreen(cam, fcw.x + 14, fcw.y - 14);
  const ssd = toScreen(cam, ssdCenter().x + 40, ssdCenter().y + 4);
  const chip = toScreen(cam, chipCenter().x - 20, chipCenter().y);
  const fileT = fade(f, T.disk + 4, T.disk + 30, T.stay - 40, T.stay - 20);
  const ssdT = fade(f, T.disk - 14, T.disk + 10, T.stay - 40, T.stay - 20);
  const chipT = fade(f, T.disk + 64, T.disk + 90, T.stay - 40, T.stay - 20);
  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      <SectionTitle text="本地推理" t={titleT} color={P.amber} x={140} y={104} />
      <Callout x={file.x} y={file.y} dx={140} dy={-120} title="模型檔案" t={fileT} color={P.amber} />
      <Callout x={ssd.x} y={ssd.y} dx={150} dy={110} title="硬碟" t={ssdT} color={P.paper} />
      <Callout x={chip.x} y={chip.y} dx={-250} dy={110} title="晶片" t={chipT} color={P.paper} />
      <SchematicTag o={fade(f, T.local + 60, T.local + 90, T.stay + 10, T.stay + 30)} />
    </div>
  );
};
