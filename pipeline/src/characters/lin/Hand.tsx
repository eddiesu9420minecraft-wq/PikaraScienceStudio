import React from 'react';
import {palette as P} from '../../theme/palette';
import {deg, mixHex, n2, V} from './util';

/**
 * Hand seen from the little-finger side (palm down), hand-local coords: origin = wrist,
 * +x toward the knuckles, +y toward the palm. Fingers are 3-joint chains (MCP, PIP, DIP angles in
 * degrees, + = curl toward the palm). Index is farthest from camera (drawn first, darkest).
 * `flip` scales local y (cos-like 1 -> -1 reads as a forearm rotation).
 */
export type Finger = [number, number, number];
export type HandPose = {
  wrist: V;
  angle: number;
  flip: number;
  fingers: [Finger, Finger, Finger, Finger]; // index, middle, ring, pinky
  thumb: [number, number];
};

const BASES: V[] = [
  [40.5, -7.2],
  [40.5, -4.4],
  [39.5, -1.6],
  [37, 1.2],
];
const LENS: [number, number, number][] = [
  [17, 10.5, 8.5],
  [19, 11.5, 9],
  [18, 11, 8.5],
  [14.5, 9, 7.5],
];
const WIDTH = [7.4, 7.6, 7.2, 6.4];

const chain = (base: V, lens: [number, number, number], f: Finger): V[] => {
  const pts: V[] = [base];
  let a = 0;
  let p = base;
  for (let i = 0; i < 3; i++) {
    a += f[i];
    p = [p[0] + Math.cos(a * deg) * lens[i], p[1] + Math.sin(a * deg) * lens[i]];
    pts.push(p);
  }
  return pts;
};

const poly = (pts: V[]) => pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');

export const Hand: React.FC<{pose: HandPose; far?: boolean}> = ({pose, far}) => {
  const base = far ? mixHex(P.skin, P.skinShadow, 0.7) : P.skin;
  const edge = far ? mixHex(P.skinShadow, '#4A2E2A', 0.5) : mixHex(P.skinShadow, '#7A4636', 0.55);
  const light = far ? base : P.skinLight;
  const {wrist, angle, flip, fingers, thumb} = pose;
  const fy = Math.abs(flip) < 0.08 ? 0.08 * Math.sign(flip || 1) : flip;

  const th = chain([7, 5], [15, 11, 0.01], [thumb[0], thumb[1], 0]);
  return (
    <g transform={`translate(${n2(wrist[0])} ${n2(wrist[1])}) rotate(${n2(angle)}) scale(1 ${n2(fy)})`}>
      {/* thumb (far side, behind the palm) */}
      <path d={poly(th)} stroke={edge} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d={poly(th)} stroke={mixHex(base, P.skinShadow, 0.45)} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* fingers, far -> near */}
      {fingers.map((f, i) => {
        const pts = chain(BASES[i], LENS[i], f);
        const c = mixHex(base, P.skinShadow, (3 - i) * 0.22);
        return (
          <g key={i}>
            <path d={poly(pts)} stroke={edge} strokeWidth={WIDTH[i] + 1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <path d={poly(pts)} stroke={c} strokeWidth={WIDTH[i]} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            {/* knuckle crease */}
            <circle cx={pts[2][0]} cy={pts[2][1]} r={0.9} fill={edge} opacity={0.45} />
          </g>
        );
      })}
      {/* palm / back of hand */}
      <path
        d="M -3 -7.5 C 10 -11 28 -11.5 40 -9.5 C 45.5 -8.5 46.5 -2 45 2.5 C 43.5 6.5 39 8 34 8.2 C 22 9.4 9 9.2 -2 7.4 Z"
        fill={base}
        stroke={edge}
        strokeWidth={1.2}
      />
      {/* tendon / knuckle highlights on the back of the hand */}
      <path d="M 10 -8.4 C 20 -10 30 -10.2 39 -8.6" stroke={light} strokeWidth={1.8} fill="none" strokeLinecap="round" opacity={0.85} />
      <path d="M 34 4.8 C 26 6.6 14 6.8 4 5.2" stroke={edge} strokeWidth={1} fill="none" strokeLinecap="round" opacity={0.45} />
    </g>
  );
};
