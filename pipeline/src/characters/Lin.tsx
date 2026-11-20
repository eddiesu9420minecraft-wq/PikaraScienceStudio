import React from 'react';
import {palette as P} from '../theme/palette';
import {Head} from './lin/Head';
import {Finger, Hand, HandPose} from './lin/Hand';
import {Lit} from './lin/Lit';
import {clamp01, hash, ik, limb, mix, mixHex, mixV, rot, smooth, V} from './lin/util';

/**
 * Lin (林予晴) — Pikara Science original character, seated side view facing right (toward the monitor).
 * World coordinates match DeskScene (1920x1080, floor y=970, desk top y=640, keyboard x 816-974).
 * Proportions: head ~106px, ~7.3 heads standing; seat ~y 770, hands on keyboard x ~820-895 / y ~612-632.
 * Every motion is a pure function of `frame` (deterministic).
 *
 * Pose blends (all 0..1):
 *  typing   - finger-tap intensity on the keyboard (both hands)
 *  lookUp   - 0 = head slightly down (keyboard / lower screen), 1 = level, eyes on the screen
 *  lean     - forward lean of the upper body
 *  headTurn - head turns from the screen toward the camera (profile -> three-quarter view, eyes to camera)
 *  think    - near (left) hand rises to the chin, eyes drift up-left, one brow lifts
 *  mouse    - far (right) hand leaves the keyboard for the mouse and makes small moves/clicks
 *  blinkOffset - shifts the blink schedule (frames) so several shots don't blink in sync
 *  id       - unique prefix for SVG defs when rendering more than one Lin in a document
 */
export type LinPose = {
  frame: number;
  typing: number;
  lookUp: number;
  lean: number;
  headTurn?: number;
  think?: number;
  mouse?: number;
  blinkOffset?: number;
  id?: string;
};

// ---------- rig constants (world space) ----------
const HIP: V = [662, 748];
const SHOULDER_N: V = [714, 530];
const SHOULDER_F: V = [722, 520];
const HEAD_O: V = [737, 433];
const HEAD_SCALE = 0.95;
const L_UP = 140;
const L_FORE = 110;

// ---------- deterministic blink ----------
const blinkAt = (f: number) => {
  const PER = 200;
  const k = Math.floor(f / PER);
  let v = 0;
  for (const kk of [k - 1, k]) {
    const start = kk * PER + 20 + hash(kk * 3.7 + 1) * 140;
    const d = f - start;
    if (d >= 0 && d < 9) v = Math.max(v, Math.sin((d / 9) * Math.PI));
    if (hash(kk * 5.1) > 0.7) {
      const d2 = d - 13;
      if (d2 >= 0 && d2 < 8) v = Math.max(v, Math.sin((d2 / 8) * Math.PI));
    }
  }
  return v;
};

// ---------- typing: one keystroke event per ~13 frames per hand ----------
const typingHand = (f: number, seed: number) => {
  const PER = 13;
  const ff = f + seed * 6.5;
  const k = Math.floor(ff / PER);
  const u = (ff - k * PER) / PER;
  const active = hash(k * 1.7 + seed * 11) > 0.18 ? 1 : 0;
  const r = hash(k * 3.1 + seed * 7);
  const finger = r < 0.34 ? 0 : r < 0.66 ? 1 : r < 0.88 ? 2 : 3;
  // anticipation lift (-1) -> strike (+0.35) -> settle (0)
  const tap = active * (u < 0.32 ? -smooth(u / 0.32) : u < 0.5 ? mix(-1, 0.35, smooth((u - 0.32) / 0.18)) : mix(0.35, 0, smooth((u - 0.5) / 0.5)));
  const tx = (kk: number) => (hash(kk * 1.31 + seed * 3.7) - 0.5) * 12;
  const ty = (kk: number) => (hash(kk * 2.17 + seed * 5.3) - 0.5) * 2.4;
  const s = smooth(u / 0.45);
  return {finger, tap, dx: mix(tx(k - 1), tx(k), s), dy: mix(ty(k - 1), ty(k), s)};
};

type Fingers = HandPose['fingers'];
const TYPE_FINGERS: Fingers = [
  [5, 30, 14],
  [8, 32, 14],
  [11, 34, 15],
  [16, 36, 14],
];
const MOUSE_FINGERS: Fingers = [
  [2, 14, 8],
  [6, 20, 10],
  [10, 26, 12],
  [16, 32, 14],
];
const FIST_FINGERS: Fingers = [
  [48, 80, 40],
  [74, 96, 50],
  [80, 96, 50],
  [84, 92, 46],
];

const mixFingers = (a: Fingers, b: Fingers, t: number): Fingers =>
  a.map((f, i) => [mix(f[0], b[i][0], t), mix(f[1], b[i][1], t), mix(f[2], b[i][2], t)] as Finger) as Fingers;

const tapFingers = (base: Fingers, finger: number, tap: number, amt: number): Fingers =>
  base.map((f, i) => {
    const w = i === finger ? 1 : Math.abs(i - finger) === 1 ? 0.28 : 0.08;
    const v = tap * w * amt;
    return [f[0] + (v < 0 ? v * 26 : v * 10), f[1] + (v < 0 ? v * 10 : v * 4), f[2]] as Finger;
  }) as Fingers;

// ---------- static shapes ----------
const TORSO =
  'M 708 500 C 690 500 668 510 660 530 C 650 556 646 610 646 660 C 646 700 642 732 645 756 C 682 766 732 760 768 734 C 768 716 762 704 760 690 C 758 664 772 628 774 598 C 776 566 768 530 754 508 C 742 500 722 500 708 500 Z';
const HOOD =
  'M 716 497 C 704 480 676 475 663 488 C 650 501 651 530 661 548 C 676 554 693 540 703 525 C 710 515 716 506 716 497 Z';
const HOOD_LINING = 'M 713 499 C 702 489 685 488 676 496 C 682 507 697 511 709 507 Z';
const NECK = 'M 701 456 C 703 476 700 494 694 512 L 760 514 C 752 500 748 488 750 470 Z';
const COLLAR = 'M 697 500 C 714 512 741 514 760 504 L 763 516 C 741 526 711 523 694 511 Z';
const LEG =
  'M 640 724 C 700 711 790 711 852 719 C 882 723 895 747 889 772 C 883 800 875 860 871 918 L 869 938 L 829 940 C 827 900 818 846 824 806 C 826 796 830 788 836 782 C 810 778 790 778 770 779 C 720 781 672 786 642 778 C 626 770 626 736 640 724 Z';
const SHOE =
  'M 828 928 C 842 925 858 927 869 930 C 884 935 903 945 913 955 C 918 961 916 968 907 970 L 822 970 C 815 962 815 940 828 928 Z';
const SOLE = 'M 817 961 L 915 961 C 916 966 913 971 906 971 L 821 971 C 818 968 817 965 817 961 Z';

const HOODIE_RIM = mixHex(P.hoodieLight, P.ice, 0.35);
const HOODIE_DEEP = mixHex(P.hoodieShadow, '#0B1620', 0.35);
const PANTS_RIM = mixHex(P.pants, P.ice, 0.28);
const STRING = '#D7E3E6';

const Leg: React.FC<{id: string; far?: boolean}> = ({id, far}) => {
  const pants = far ? P.pantsShadow : P.pants;
  const shoe = far ? mixHex(P.shoe, '#5B6273', 0.45) : P.shoe;
  const sole = far ? mixHex(P.shoeSole, '#3A4050', 0.45) : P.shoeSole;
  return (
    <g>
      <path d={SHOE} fill={shoe} />
      {!far ? (
        <>
          <path d="M 870 931 C 882 936 896 944 906 952" stroke="#BCC1CC" strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <path d="M 874 936 L 880 931 M 884 941 L 890 936 M 893 946 L 899 941" stroke="#A7ADBA" strokeWidth={2} strokeLinecap="round" />
          <path d="M 823 934 C 821 944 821 952 823 960" stroke="#B2B7C3" strokeWidth={3} fill="none" strokeLinecap="round" />
        </>
      ) : null}
      <path d={SOLE} fill={sole} />
      <Lit
        id={`${id}-leg${far ? 'f' : 'n'}`}
        d={LEG}
        fill={pants}
        shadow={{c: far ? '#14171F' : P.pantsShadow, dx: 0, dy: -11, op: 0.9}}
        rim={far ? undefined : {c: PANTS_RIM, dx: -3, dy: 2.5, op: 0.9}}
      >
        {!far ? (
          <>
            <path d="M 700 718 C 760 714 812 716 850 724" stroke="#3A4258" strokeWidth={3} fill="none" strokeLinecap="round" />
            <path d="M 836 784 C 846 776 858 772 868 774" stroke={P.pantsShadow} strokeWidth={3} fill="none" strokeLinecap="round" />
            <path d="M 840 794 C 850 790 858 790 866 792" stroke={P.pantsShadow} strokeWidth={2.4} fill="none" strokeLinecap="round" />
            <path d="M 862 800 C 858 840 856 880 856 920" stroke={P.pantsShadow} strokeWidth={2.4} fill="none" strokeLinecap="round" opacity={0.7} />
            <path d="M 829 930 C 842 933 856 933 869 930" stroke={P.pantsShadow} strokeWidth={3} fill="none" strokeLinecap="round" />
          </>
        ) : null}
      </Lit>
    </g>
  );
};

const Arm: React.FC<{id: string; s: V; e: V; w: V; hand: HandPose; far?: boolean}> = ({id, s, e, w, hand, far}) => {
  const len = Math.hypot(w[0] - e[0], w[1] - e[1]) || 1;
  const ux = (w[0] - e[0]) / len;
  const uy = (w[1] - e[1]) / len;
  const cuffA: V = [w[0] - ux * 13, w[1] - uy * 13];
  const cuffB: V = [w[0] + ux * 1.5, w[1] + uy * 1.5];
  const base = far ? P.hoodieShadow : P.hoodie;
  const shade = far ? HOODIE_DEEP : P.hoodieShadow;
  const cuff = far ? HOODIE_DEEP : mixHex(P.hoodie, P.hoodieShadow, 0.55);
  // inner elbow crease
  const ex = (s[0] + w[0]) / 2 - e[0];
  const ey = (s[1] + w[1]) / 2 - e[1];
  const el = Math.hypot(ex, ey) || 1;
  const ci: V = [e[0] + (ex / el) * 9, e[1] + (ey / el) * 9];
  return (
    <g>
      <Hand pose={hand} far={far} />
      <Lit id={`${id}-up`} d={limb(s, e, 21, 15.5, 3)} fill={base} shadow={{c: shade, dx: 4, dy: -7, op: 0.9}} rim={far ? undefined : {c: HOODIE_RIM, dx: -2.5, dy: 2.5, op: 0.55}}>
        {!far
          ? [0.62, 0.8].map((k, i) => {
              const L = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1;
              const vx = (e[0] - s[0]) / L;
              const vy = (e[1] - s[1]) / L;
              const c: V = [s[0] + (e[0] - s[0]) * k, s[1] + (e[1] - s[1]) * k];
              const a: V = [c[0] - vy * 14 - vx * 6, c[1] + vx * 14 - vy * 6];
              const b: V = [c[0] + vy * 4 + vx * 4, c[1] - vx * 4 + vy * 4];
              return <path key={i} d={`M ${a[0]} ${a[1]} Q ${c[0]} ${c[1] + 2} ${b[0]} ${b[1]}`} stroke={shade} strokeWidth={2.2} fill="none" strokeLinecap="round" opacity={0.75} />;
            })
          : null}
      </Lit>
      <Lit id={`${id}-fo`} d={limb(e, cuffA, 15.5, 13, 1.5)} fill={base} shadow={{c: shade, dx: 0, dy: -6, op: 0.9}} rim={far ? undefined : {c: HOODIE_RIM, dx: -1.5, dy: 3, op: 0.55}} />
      <path d={limb(cuffA, cuffB, 13, 12.2, 0.5)} fill={cuff} />
      {!far ? (
        <path
          d={`M ${cuffA[0] + ux * 4 - uy * 9} ${cuffA[1] + uy * 4 + ux * 9} L ${cuffA[0] + ux * 4 + uy * 9} ${cuffA[1] + uy * 4 - ux * 9} M ${cuffA[0] + ux * 9 - uy * 9} ${cuffA[1] + uy * 9 + ux * 9} L ${cuffA[0] + ux * 9 + uy * 9} ${cuffA[1] + uy * 9 - ux * 9}`}
          stroke={P.hoodieShadow}
          strokeWidth={1.3}
          opacity={0.6}
        />
      ) : null}
      <path d={`M ${e[0] - 4} ${e[1] - 2} Q ${ci[0]} ${ci[1]} ${ci[0] + (ex / el) * 2 + 6} ${ci[1] - 6}`} stroke={shade} strokeWidth={2.4} fill="none" strokeLinecap="round" opacity={0.8} />
    </g>
  );
};

export const Lin: React.FC<LinPose> = ({frame, typing, lookUp, lean, headTurn = 0, think = 0, mouse = 0, blinkOffset = 0, id = 'lin'}) => {
  const f = frame;
  const th = smooth(think);
  const ms = smooth(mouse);
  const turn = clamp01(headTurn);

  // body
  const breath = Math.sin((f / 170) * Math.PI * 2) * 1.3;
  const leanDeg = lean * 3 + ms * 2.2 + th * 1.2 + Math.sin((f / 260) * Math.PI * 2) * 0.25;
  const body = (p: V): V => {
    const r = rot(p, HIP, leanDeg);
    return [r[0], r[1] - breath];
  };
  const sN = body(SHOULDER_N);
  const sF = body(SHOULDER_F);
  const headPos = body(HEAD_O);

  // head
  const sway = Math.sin((f / 230) * Math.PI * 2) * 0.7 + Math.sin((f / 97) * Math.PI * 2) * 0.25;
  const tilt = (1 - lookUp) * 4.5 - th * 7 - turn * 1.5 + sway - leanDeg * 0.5;
  const headTurnEff = clamp01(turn + th * 0.18);
  const gazeAng = mix(mix(88, 4, smooth(turn)), 90 - 52 * headTurnEff - 42, th);
  const gazeY = mix(mix(2.4 * (1 - lookUp) + 0.4, 0.2, turn), -3.6, th);
  const blink = blinkAt(f + blinkOffset);

  // near (left) hand: typing <-> chin
  const tn = typingHand(f, 0);
  const typeN: HandPose = {
    wrist: [818 + tn.dx * 0.5 * typing, 611 + tn.dy * 0.5 * typing + Math.min(0, tn.tap) * typing * 1.2],
    angle: 3 + tn.tap * typing * 1.2,
    flip: 1,
    fingers: tapFingers(TYPE_FINGERS, tn.finger, tn.tap, typing),
    thumb: [38, 18],
  };
  const chinW: V = [787 + Math.sin(f / 37) * 0.6, 543 + breath * 0.3];
  const wristN: V = mixV(typeN.wrist, chinW, th);
  wristN[1] -= Math.sin(th * Math.PI) * 26;
  const handN: HandPose = {
    wrist: wristN,
    angle: mix(typeN.angle, -84, th),
    flip: Math.cos(th * Math.PI),
    fingers: mixFingers(typeN.fingers, FIST_FINGERS, th),
    thumb: [mix(38, -24, th), mix(18, 30, th)],
  };
  const [eN, wN] = ik(sN, handN.wrist, L_UP, L_FORE, 1);
  handN.wrist = wN;

  // far (right) hand: typing <-> mouse
  const tf = typingHand(f, 1);
  const typeF: HandPose = {
    wrist: [842 + tf.dx * 0.5 * typing, 607 + tf.dy * 0.5 * typing + Math.min(0, tf.tap) * typing * 1.2],
    angle: 3 + tf.tap * typing * 1.2,
    flip: 1,
    fingers: tapFingers(TYPE_FINGERS, tf.finger, tf.tap, typing),
    thumb: [38, 18],
  };
  // mouse micro-motion + a click every ~1.6 s
  const mx = Math.sin(f * 0.045) * 5 + Math.sin(f * 0.11 + 1) * 2.5;
  const my = Math.sin(f * 0.07) * 1.2;
  const cu = (((f % 95) + 95) % 95) / 95;
  const click = cu < 0.06 ? -smooth(cu / 0.06) : cu < 0.1 ? mix(-1, 0.4, (cu - 0.06) / 0.04) : cu < 0.16 ? mix(0.4, 0, (cu - 0.1) / 0.06) : 0;
  const mouseW: V = [938 + mx, 614 + my];
  const wristF: V = mixV(typeF.wrist, mouseW, ms);
  wristF[1] -= Math.sin(ms * Math.PI) * 14;
  const handF: HandPose = {
    wrist: wristF,
    angle: mix(typeF.angle, 8 + mx * 0.15, ms),
    flip: 1,
    fingers: mixFingers(typeF.fingers, tapFingers(MOUSE_FINGERS, 0, click * 0.6, 1), ms),
    thumb: [mix(38, 16, ms), mix(18, 4, ms)],
  };
  const [eF, wF] = ik(sF, handF.wrist, L_UP, L_FORE, 1);
  handF.wrist = wF;

  const torsoT = `rotate(${leanDeg} ${HIP[0]} ${HIP[1]}) translate(0 ${-breath})`;

  return (
    <g>
      <defs>
        <linearGradient id={`${id}-warm`} gradientUnits="userSpaceOnUse" x1={780} y1={760} x2={700} y2={600}>
          <stop offset={0} stopColor={P.amber} stopOpacity={0.14} />
          <stop offset={1} stopColor={P.amber} stopOpacity={0} />
        </linearGradient>
        <linearGradient id={`${id}-screen`} gradientUnits="userSpaceOnUse" x1={780} y1={0} x2={690} y2={0}>
          <stop offset={0} stopColor={P.ice} stopOpacity={0.16} />
          <stop offset={1} stopColor={P.ice} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* far leg + far arm (behind the body) */}
      <g transform="translate(-24 -5)">
        <Leg id={id} far />
      </g>
      <Arm id={`${id}-af`} s={sF} e={eF} w={wF} hand={handF} far />

      {/* near leg */}
      <Leg id={id} />

      {/* torso, hood, neck */}
      <g transform={torsoT}>
        <Lit id={`${id}-hood`} d={HOOD} fill={P.hoodie} shadow={{c: P.hoodieShadow, dx: 6, dy: -6, op: 0.9}} rim={{c: HOODIE_RIM, dx: 0, dy: 2.5, op: 0.7}} />
        <path d={HOOD_LINING} fill={HOODIE_DEEP} />
        <Lit
          id={`${id}-torso`}
          d={TORSO}
          fill={P.hoodie}
          shadow={{c: P.hoodieShadow, dx: 18, dy: 0, op: 0.95}}
          shadow2={{c: P.hoodieShadow, dx: 0, dy: -10, op: 0.6}}
          rim={{c: HOODIE_RIM, dx: -3, dy: 0, op: 0.55}}
        >
          <rect x={600} y={480} width={200} height={300} fill={`url(#${id}-screen)`} />
          <rect x={600} y={480} width={200} height={300} fill={`url(#${id}-warm)`} />
          <path d="M 776 606 C 764 618 758 634 760 652" stroke={P.hoodieShadow} strokeWidth={3} fill="none" strokeLinecap="round" opacity={0.8} />
          <path d="M 690 720 C 712 726 736 722 754 708" stroke={P.hoodieShadow} strokeWidth={2.6} fill="none" strokeLinecap="round" />
          <path d="M 704 740 C 724 744 744 738 760 726" stroke={P.hoodieShadow} strokeWidth={2.6} fill="none" strokeLinecap="round" />
          <path d="M 676 560 C 668 600 666 640 670 690" stroke={P.hoodieShadow} strokeWidth={2.4} fill="none" strokeLinecap="round" opacity={0.6} />
          <path d="M 766 662 C 750 668 738 690 734 724" stroke={HOODIE_DEEP} strokeWidth={2.6} fill="none" strokeLinecap="round" />
          <path d="M 768 667 C 754 673 743 693 739 724" stroke={HOODIE_RIM} strokeWidth={1.2} fill="none" strokeLinecap="round" opacity={0.5} />
          <path d="M 645 756 C 682 766 732 760 768 734" stroke={mixHex(P.hoodie, P.hoodieShadow, 0.55)} strokeWidth={20} fill="none" />
          <path d="M 646 747 C 682 756 728 751 762 728" stroke={P.hoodieShadow} strokeWidth={1.6} fill="none" opacity={0.8} />
        </Lit>
        <Lit id={`${id}-neck`} d={NECK} fill={P.skinShadow} rim={{c: mixHex(P.skin, P.ice, 0.18), dx: -2.5, dy: 0, op: 0.9}}>
          <path d="M 700 470 C 720 486 740 488 760 480 L 760 450 L 700 450 Z" fill={mixHex(P.skinShadow, '#7A4A3E', 0.35)} opacity={0.55} />
        </Lit>
        <Lit id={`${id}-collar`} d={COLLAR} fill={P.hoodie} shadow={{c: P.hoodieShadow, dx: 0, dy: -5, op: 0.9}} rim={{c: HOODIE_RIM, dx: -2, dy: 0, op: 0.8}} />
        <path d="M 745 520 C 747 542 745 562 747 584" stroke={STRING} strokeWidth={2.4} fill="none" strokeLinecap="round" />
        <path d="M 754 518 C 757 538 757 556 760 574" stroke={mixHex(STRING, P.hoodieShadow, 0.35)} strokeWidth={2.2} fill="none" strokeLinecap="round" />
        <path d="M 747 584 L 747.6 592" stroke="#8FA3AA" strokeWidth={3.4} strokeLinecap="round" />
        <path d="M 760 574 L 761 581" stroke="#7C8F96" strokeWidth={3.2} strokeLinecap="round" />
      </g>

      {/* head */}
      <g transform={`translate(${headPos[0]} ${headPos[1]}) scale(${HEAD_SCALE}) rotate(${tilt} -2 44)`}>
        <Head id={`${id}-head`} turn={headTurnEff} gazeAng={gazeAng} gazeY={gazeY} blink={blink} think={th} />
      </g>

      {/* near arm */}
      <Arm id={`${id}-an`} s={sN} e={eN} w={wN} hand={handN} />
    </g>
  );
};
