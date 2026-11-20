import React from 'react';
import {palette as P} from '../../theme/palette';
import {Lit} from './Lit';
import {clamp01, deg, mixHex, mixPath, n2} from './util';
import * as S from './shapes';

/**
 * Lin's head, drawn in head-local coordinates (see shapes.ts).
 * Facial features are 3D points (X lateral, negative = camera side; Y down; Z toward the face) projected
 * with yaw alpha (90deg = profile, 38deg = three-quarter): x = Z sin(a) + X cos(a), depth = -X sin(a) + Z cos(a).
 */
export type HeadProps = {
  id: string;
  turn: number; // 0..1 profile -> three-quarter (toward camera)
  gazeAng: number; // horizontal gaze, degrees, same convention as alpha (90 = toward screen, 0 = toward camera)
  gazeY: number; // vertical iris offset in local units (+ = down)
  blink: number; // 0..1
  think: number; // 0..1
  smile?: number;
};

type P3 = [number, number, number];

const SKIN_RIM = mixHex(P.skinLight, '#CDEBFF', 0.55);
const HAIR_BACK = mixHex(P.hair, '#000000', 0.25);
const HAIR_RIM = mixHex(P.hairLight, P.ice, 0.45);
const LASH = '#1A1418';
const SCLERA = '#F4EEE8';
const IRIS = '#3A2826';
const IRIS_LIGHT = '#7A5340';
const LIP = '#B8665C';

export const Head: React.FC<HeadProps> = ({id, turn, gazeAng, gazeY, blink, think, smile = 0}) => {
  const t = clamp01(turn);
  const alpha = (90 - 52 * t) * deg;
  const sa = Math.sin(alpha);
  const ca = Math.cos(alpha);
  const pr = (p: P3) => ({x: p[2] * sa + p[0] * ca, y: p[1], depth: -p[0] * sa + p[2] * ca});
  const X = (p: P3) => n2(pr(p).x);
  const xy = (p: P3) => `${X(p)} ${n2(p[1])}`;

  const head = mixPath(S.HEAD_P, S.HEAD_Q, t);
  const back = mixPath(S.BACK_P, S.BACK_Q, t);
  const far = mixPath(S.FAR_P, S.FAR_Q, t);
  const cap = mixPath(S.CAP_P, S.CAP_Q, t);
  const farOp = clamp01((t - 0.2) / 0.35);

  // ear
  const earC: P3 = [-44, 8, -6];
  const earPt = (q: [number, number]) => `${n2((earC[2] + q[0]) * sa + earC[0] * ca)} ${n2(earC[1] + q[1])}`;
  const E = S.EAR;
  const earD = `M ${earPt(E[0])} ` + [1, 4, 7, 10].map((i) => `C ${earPt(E[i])} ${earPt(E[i + 1])} ${earPt(E[i + 2])}`).join(' ') + ' Z';
  const EI = S.EAR_IN;
  const earIn = `M ${earPt(EI[0])} C ${earPt(EI[1])} ${earPt(EI[2])} ${earPt(EI[3])} C ${earPt(EI[4])} ${earPt(EI[5])} ${earPt(EI[6])}`;

  // nose
  const nose =
    `M ${xy([0, -5, 43])} C ${xy([0, 4, 46])} ${xy([0, 12, 52])} ${xy([0, 18, 55.5])} ` +
    `C ${xy([0, 21.5, 57])} ${xy([0, 25, 52])} ${xy([0, 25.5, 46.5])} ` +
    `C ${xy([-4, 26, 44])} ${xy([-8, 25, 41])} ${xy([-8, 21, 40])} ` +
    `C ${xy([-7, 12, 40])} ${xy([-4, 2, 41])} ${xy([0, -5, 43])} Z`;
  const noseSide = `M ${xy([-3, 0, 42])} C ${xy([-5, 8, 42])} ${xy([-7, 15, 41])} ${xy([-8, 21, 40.5])}`;
  const nostril = `M ${xy([-6.5, 23.5, 42.5])} C ${xy([-4, 25, 44])} ${xy([-1.5, 25.2, 45.5])} ${xy([0, 25, 46.5])}`;

  // mouth
  const sm = smile * 1.2 - think * 0.8;
  const mouthNear: P3 = [-10.5, 35.6 - sm, 37.5];
  const mouthMid: P3 = [0, 36.6 + think * 0.4, 45];
  const mouthFar: P3 = [10.5, 35.6 - sm, 37.5];
  const farMouthVis = pr(mouthFar).depth > 4;
  const mouth = farMouthVis
    ? `M ${xy(mouthNear)} Q ${xy([-4, 37.4, 43.8])} ${xy(mouthMid)} Q ${xy([4, 37.4, 43.8])} ${xy(mouthFar)}`
    : `M ${xy(mouthNear)} Q ${xy([-4, 37.4, 43.8])} ${xy(mouthMid)}`;
  const lowerLip = `M ${xy([-5, 40.2, 43.5])} Q ${xy([0, 42.4, 45])} ${xy([5, 40.2, 43.5])}`;
  const lipW = Math.abs(X([5, 40, 43.5]) - X([-5, 40, 43.5]));

  const eye = (side: -1 | 1) => {
    const inner: P3 = [side * 8, 0.6, 40];
    const outer: P3 = [side * 31, -0.6, 27.5];
    const ctr = pr([side * 19.5, 0, 36]);
    const vis = clamp01((ctr.depth + 1) / 7);
    if (vis <= 0) return null;
    const ix = X(inner);
    const ox = X(outer);
    const w = Math.abs(ix - ox);
    const dir = Math.sign(ix - ox) || 1;
    const cy = 0.5;
    const open = clamp01(1 - blink);
    const hu = 5.9 * (0.12 + 0.88 * open);
    const hl = 3.6;
    const yo = -0.6;
    const yi = 0.6;
    const upper = `M ${n2(ox)} ${yo} C ${n2(ox + dir * w * 0.22)} ${n2(cy - hu * 1.32)} ${n2(ix - dir * w * 0.28)} ${n2(cy - hu * 1.25)} ${n2(ix)} ${yi}`;
    const lowerC = `C ${n2(ix - dir * w * 0.25)} ${n2(cy + hl * 1.25)} ${n2(ox + dir * w * 0.3)} ${n2(cy + hl * 1.15)} ${n2(ox)} ${yo}`;
    const almond = `${upper} ${lowerC} Z`;
    const ball = pr([side * 19.5, 0.5, 27]);
    const g = gazeAng * deg;
    const irisX = ball.x + 9.2 * Math.sin(g);
    const fs = Math.max(0.42, Math.abs(Math.cos(g)));
    const irx = 4.5 * fs;
    const iry = 4.9;
    const iy = cy + 0.4 + gazeY;
    const flick = `M ${n2(ox + dir * 1.2)} ${n2(yo - 0.4)} Q ${n2(ox - dir * 2.2)} ${n2(yo - 1.2)} ${n2(ox - dir * 4.2)} ${n2(yo - 3.4)}`;
    const crease = `M ${n2(ox + dir * w * 0.18)} ${n2(cy - hu * 1.05 - 2.6)} Q ${n2((ox + ix) / 2)} ${n2(cy - hu * 1.3 - 3.2)} ${n2(ix - dir * w * 0.2)} ${n2(cy - hu * 0.95 - 2.4)}`;
    const cid = `${id}-eye${side}`;
    return (
      <g opacity={vis}>
        <clipPath id={cid}>
          <path d={almond} />
        </clipPath>
        {open > 0.12 ? (
          <>
            <path d={almond} fill={SCLERA} />
            <g clipPath={`url(#${cid})`}>
              <ellipse cx={irisX} cy={iy} rx={irx} ry={iry} fill={IRIS} />
              <ellipse cx={irisX} cy={iy + 1.9} rx={irx * 0.72} ry={iry * 0.5} fill={IRIS_LIGHT} opacity={0.75} />
              <ellipse cx={irisX} cy={iy + 0.2} rx={irx * 0.48} ry={iry * 0.5} fill="#120D12" />
              <path d={`${upper} L ${n2(ix)} ${n2(cy - 12)} L ${n2(ox)} ${n2(cy - 12)} Z`} fill="#000" opacity={0.18} transform="translate(0 1.6)" />
              <circle cx={irisX + 1.6 * fs + 0.4} cy={iy - 1.8} r={1.35} fill="#FFFFFF" />
              <circle cx={irisX - 1.4 * fs} cy={iy + 2} r={0.6} fill="#CDEBFF" opacity={0.85} />
            </g>
            <path d={`M ${n2(ix)} ${yi} ${lowerC}`} stroke={P.skinShadow} strokeWidth={0.9} fill="none" opacity={0.75} />
            <path d={crease} stroke={P.skinShadow} strokeWidth={1} fill="none" strokeLinecap="round" opacity={0.7 * open} />
          </>
        ) : null}
        <path d={upper} stroke={LASH} strokeWidth={2.3} fill="none" strokeLinecap="round" />
        <path d={flick} stroke={LASH} strokeWidth={1.5} fill="none" strokeLinecap="round" />
      </g>
    );
  };

  const brow = (side: -1 | 1) => {
    const lift = side === -1 ? think * 2.2 : -think * 0.6;
    const a: P3 = [side * 6.5, -10.5 + (side === 1 ? think * 0.6 : 0), 43];
    const b: P3 = [side * 18, -14.4 - lift, 40];
    const c: P3 = [side * 31, -11.4 - lift * 0.6, 30];
    const vis = clamp01((pr([side * 18, 0, 40]).depth + 2) / 8);
    if (vis <= 0) return null;
    const th = (p: P3, k: number) => `${X(p)} ${n2(p[1] - k)}`;
    const d = `M ${th(a, 1.7)} Q ${th(b, 1.5)} ${th(c, 0.6)} L ${th(c, -0.5)} Q ${th(b, -1.1)} ${th(a, -1.5)} Z`;
    return <path d={d} fill={mixHex(P.hair, P.hairLight, 0.25)} opacity={vis} />;
  };

  const cheek = pr([-22, 18, 30]);

  return (
    <g>
      <path d={back} fill={HAIR_BACK} />
      <path d={far} fill={mixHex(HAIR_BACK, P.hair, 0.5)} opacity={farOp} />
      <defs>
        <linearGradient id={`${id}-facegrad`} gradientUnits="userSpaceOnUse" x1={-50} y1={0} x2={50} y2={0}>
          <stop offset={0} stopColor={P.skinShadow} stopOpacity={0.45} />
          <stop offset={0.45} stopColor={P.skinShadow} stopOpacity={0} />
          <stop offset={1} stopColor={P.ice} stopOpacity={0.12} />
        </linearGradient>
      </defs>
      <Lit id={`${id}-face`} d={head} fill={P.skin} rim={{c: SKIN_RIM, dx: -2.4, dy: 0.6, op: 0.9}}>
        <rect x={-70} y={-70} width={140} height={140} fill={`url(#${id}-facegrad)`} />
        <path d={cap} fill={P.skinShadow} opacity={0.45} transform="translate(1.5 4.5)" />
        <path d={mixPath(S.JAW_P, S.JAW_Q, t)} fill={P.skinShadow} opacity={0.35} />
      </Lit>
      <path d={earD} fill={mixHex(P.skin, P.skinShadow, 0.35)} />
      <path d={earIn} stroke={mixHex(P.skinShadow, '#7A4A3E', 0.35)} strokeWidth={1.6} fill="none" strokeLinecap="round" />
      <ellipse cx={cheek.x} cy={cheek.y} rx={8.5 * Math.max(0.6, sa * 0.9 + 0.1)} ry={5} fill="#E58C7E" opacity={0.22} />
      <Lit id={`${id}-nose`} d={nose} fill={P.skin} rim={{c: SKIN_RIM, dx: -1.8, dy: 0.8, op: 0.9 * (1 - t)}} />
      <path d={noseSide} stroke={P.skinShadow} strokeWidth={1.4} fill="none" strokeLinecap="round" opacity={0.75 * t} />
      <path d={nostril} stroke={mixHex(P.skinShadow, '#7A4A3E', 0.4)} strokeWidth={1.3} fill="none" strokeLinecap="round" />
      <path d={lowerLip} stroke={LIP} strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.45 * clamp01((lipW - 2) / 5)} />
      <path d={mouth} stroke={mixHex(LIP, '#5A2E2E', 0.35)} strokeWidth={1.7} fill="none" strokeLinecap="round" />
      {eye(1)}
      {eye(-1)}
      {brow(1)}
      {brow(-1)}
      <Lit id={`${id}-cap`} d={cap} fill={P.hair} rim={{c: HAIR_RIM, dx: -0.8, dy: 2.8, op: 0.8}}>
        <path d={mixPath(S.LOCK_P, S.LOCK_Q, t)} fill={P.hair} />
        <path d={mixPath(S.SHEEN_P, S.SHEEN_Q, t)} fill={P.hairLight} opacity={0.9} />
        {S.PART_P.map((d, i) => (
          <path key={'p' + i} d={mixPath(d, S.PART_Q[i], t)} stroke={HAIR_BACK} strokeWidth={1.6} fill="none" strokeLinecap="round" />
        ))}
        {S.STR_P.map((d, i) => (
          <path key={'s' + i} d={mixPath(d, S.STR_Q[i], t)} stroke={P.hairLight} strokeWidth={1.3} fill="none" strokeLinecap="round" opacity={0.7} />
        ))}
      </Lit>
    </g>
  );
};
