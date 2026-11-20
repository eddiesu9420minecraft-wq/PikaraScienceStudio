import React from 'react';
import * as THREE from 'three';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, ease, progress} from '../../lib/anim';
import {makeRig} from '../../lib/camera3d';
import type {Cam2D} from '../../lib/camera2d';

/** 第二幕所有時間點：全部由旁白錨點推導（沒有寫死的影格）。 */
export type Act2Times = {
  hook: number;
  laptop: number;
  notlocal: number;
  packet: number;
  cable: number;
  datacenter: number;
  servers: number;
  ret: number;
  cloud: number;
  local: number;
  disk: number;
  stay: number;
  compare: number;
  cloudcol: number;
  net: number;
  privacy: number;
  cost: number;
  localcol: number;
  hw: number;
  offline: number;
  keep: number; // 「資料留在自己手上」：離線 與 電費 之間（推導）
  power: number;
  question: number;
  end: number;
};

const FALLBACK: Record<string, number> = {
  hook: 0.05, laptop: 0.054, notlocal: 0.092, packet: 0.159, cable: 0.188, datacenter: 0.239, servers: 0.312, return: 0.347, cloud: 0.366,
  local: 0.389, disk: 0.458, stay: 0.515, compare: 0.577, cloudcol: 0.611, net: 0.677, privacy: 0.712, cost: 0.75, localcol: 0.766,
  hw: 0.798, offline: 0.839, power: 0.883, question: 0.965,
};

export const getTimes = (anchors: Record<string, number>, duration: number): Act2Times => {
  const a = (k: string) => anchors[k] ?? FALLBACK[k] * duration;
  const offline = a('offline');
  const power = a('power');
  return {
    hook: a('hook'),
    laptop: a('laptop'), notlocal: a('notlocal'), packet: a('packet'), cable: a('cable'), datacenter: a('datacenter'), servers: a('servers'),
    ret: a('return'), cloud: a('cloud'), local: a('local'), disk: a('disk'), stay: a('stay'), compare: a('compare'), cloudcol: a('cloudcol'),
    net: a('net'), privacy: a('privacy'), cost: a('cost'), localcol: a('localcol'), hw: a('hw'), offline, keep: offline + (power - offline) * 0.42,
    power, question: a('question'), end: duration,
  };
};

/** 平滑 2D 攝影機：位置與對數縮放走 Catmull-Rom，關鍵點之間不停頓。 */
export type CamKey2 = {f: number; cx: number; cy: number; zoom: number};
export const make2DRig = (keys: CamKey2[], smooth = 12) => {
  const sorted = [...keys].sort((x, y) => x.f - y.f);
  const rig = makeRig(
    sorted.map((k) => ({f: k.f, pos: new THREE.Vector3(k.cx, k.cy, Math.log(k.zoom) * 400), target: new THREE.Vector3(0, 0, 0)})),
    smooth,
  );
  return (frame: number): Cam2D => {
    const s = rig(frame);
    return {cx: s.pos.x, cy: s.pos.y, zoom: Math.exp(s.pos.z / 400)};
  };
};

/** 一般路徑（時間 → 世界座標）也用同一套平滑曲線。 */
export const makePath = (keys: {f: number; x: number; y: number}[], smooth = 8) => {
  const rig = make2DRig(keys.map((k) => ({f: k.f, cx: k.x, cy: k.y, zoom: 1})), smooth);
  return (frame: number) => {
    const c = rig(frame);
    return {x: c.cx, y: c.cy};
  };
};

export const toScreen = (cam: Cam2D, x: number, y: number, depth = 1) => {
  const z = Math.pow(cam.zoom, depth);
  const cx = 960 + (cam.cx - 960) * depth;
  const cy = 540 + (cam.cy - 540) * depth;
  return {x: (x - cx) * z + 960, y: (y - cy) * z + 540, s: z};
};

/** 細引線＋小字（無底框）。 */
export const Callout: React.FC<{
  x: number;
  y: number;
  dx: number;
  dy: number;
  title: string;
  sub?: string;
  t: number;
  color?: string;
  size?: number;
  lineLen?: number;
}> = ({x, y, dx, dy, title, sub, t, color = P.paper, size = 28, lineLen = 160}) => {
  if (t <= 0.001) return null;
  const k = ease.out(Math.min(1, t * 1.6));
  const ex = x + dx * k;
  const ey = y + dy * k;
  const textT = progress(t, 0.35, 1);
  const alignRight = dx < 0;
  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <circle cx={x} cy={y} r={4.5} fill="none" stroke={color} strokeWidth={1.5} opacity={t} />
        <circle cx={x} cy={y} r={1.8} fill={color} opacity={t} />
        <line x1={x} y1={y} x2={ex} y2={ey} stroke={color} strokeWidth={1.3} opacity={0.8 * t} />
        <line x1={ex} y1={ey} x2={ex + (alignRight ? -lineLen : lineLen) * textT} y2={ey} stroke={color} strokeWidth={1.3} opacity={0.5 * t} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: alignRight ? ex - 460 : ex,
          top: ey - size - 14,
          width: 460,
          textAlign: alignRight ? 'right' : 'left',
          opacity: textT,
          transform: `translateY(${(1 - textT) * 8}px)`,
          fontFamily: fontStack,
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{...type.title, fontSize: size, color, textShadow: '0 2px 10px rgba(5,8,16,0.8)'}}>{title}</div>
        {sub ? <div style={{...type.label, fontSize: 19, color: P.mist, marginTop: 20, textShadow: '0 2px 8px rgba(5,8,16,0.9)'}}>{sub}</div> : null}
      </div>
    </>
  );
};

/** 「示意圖」角標。 */
export const SchematicTag: React.FC<{o: number; text?: string}> = ({o, text = '示意圖'}) =>
  o > 0.001 ? (
    <div
      style={{
        position: 'absolute',
        right: 124,
        top: 84,
        opacity: o,
        
        ...type.label,
        fontSize: 19,
        color: P.mist,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{width: 18, height: 1.5, background: P.mist, display: 'inline-block'}} />
      {text}
    </div>
  ) : null;

/** 大標題（片段名稱），以遮罩由下而上揭示。 */
export const SectionTitle: React.FC<{text: string; sub?: string; t: number; color: string; x: number; y: number; align?: 'left' | 'center'}> = ({
  text,
  sub,
  t,
  color,
  x,
  y,
  align = 'left',
}) => {
  if (t <= 0.001) return null;
  const k = ease.out(clamp(t * 1.3));
  const w = align === 'center' ? 900 : 900;
  return (
    <div style={{position: 'absolute', left: align === 'center' ? x - w / 2 : x, top: y, width: w, textAlign: align, fontFamily: fontStack, opacity: Math.min(1, t * 2)}}>
      <div style={{overflow: 'hidden', paddingBottom: 6}}>
        <div style={{...type.display, fontSize: 64, color, transform: `translateY(${(1 - k) * 80}px)`, textShadow: '0 4px 24px rgba(5,8,16,0.75)'}}>{text}</div>
      </div>
      <div
        style={{
          height: 2,
          background: color,
          opacity: 0.7,
          width: 120 * ease.out(progress(t, 0.2, 1)),
          margin: align === 'center' ? '10px auto 0' : '10px 0 0',
        }}
      />
      {sub ? (
        <div style={{...type.label, fontSize: 24, color: P.mist, marginTop: 16, opacity: progress(t, 0.4, 1), textShadow: '0 2px 10px rgba(5,8,16,0.9)'}}>{sub}</div>
      ) : null}
    </div>
  );
};

/** 網路封包方塊（SVG，世界座標）：琥珀色本體＋冰藍色標頭。answer=true 時顏色對調（回覆封包）。 */
export const PacketTile: React.FC<{x: number; y: number; size: number; rot?: number; o?: number; char?: string; charO?: number; answer?: boolean}> = ({
  x,
  y,
  size,
  rot = 0,
  o = 1,
  char,
  charO = 0,
  answer = false,
}) => {
  if (o <= 0.001 || size <= 0.01) return null;
  const s = size;
  const body = answer ? P.ice : P.amber;
  const head = answer ? P.amber : P.ice;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`} opacity={o}>
      <rect x={-s * 0.62} y={-s * 0.62} width={s * 1.24} height={s * 1.24} fill={body} opacity={0.14} />
      <rect x={-s / 2} y={-s / 2} width={s} height={s} fill={body} />
      <rect x={-s / 2} y={-s / 2} width={s} height={s * 0.24} fill={head} />
      <rect x={-s / 2} y={-s / 2 + s * 0.24} width={s} height={s * 0.05} fill="#0B1220" opacity={0.35} />
      {char && charO > 0.01 ? (
        <text x={0} y={s * 0.3} fontSize={s * 0.56} textAnchor="middle" fontFamily={fontStack} fontWeight={700} fill="#1A1206" opacity={charO}>
          {char}
        </text>
      ) : (
        <g opacity={0.55}>
          <rect x={-s * 0.32} y={s * 0.02} width={s * 0.64} height={s * 0.06} fill="#3A2606" />
          <rect x={-s * 0.32} y={s * 0.16} width={s * 0.44} height={s * 0.06} fill="#3A2606" />
        </g>
      )}
    </g>
  );
};

export const fade = (f: number, a: number, b: number, c: number, d: number) => progress(f, a, b) * (1 - progress(f, c, d));
