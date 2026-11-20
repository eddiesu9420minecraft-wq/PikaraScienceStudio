// Lin pose review entry:
//   node scripts/stills.mjs 0,150,300,450 LinPoses src/entries/lin.tsx
//   node scripts/stills.mjs 0,150,300,450 LinClose src/entries/lin.tsx   (2.5x close-up)
import React from 'react';
import {AbsoluteFill, Composition, registerRoot, useCurrentFrame} from 'remotion';
import {palette as P} from '../theme/palette';
import {Lin} from '../characters/Lin';
import {smooth} from '../characters/lin/util';

// pose timeline: typing (0) -> headTurn (150) -> think (300) -> mouse (450)
const win = (f: number, a: number, b: number, c: number, d: number) => smooth((f - a) / (b - a)) * (1 - smooth((f - c) / (d - c)));
export const linPosesAt = (f: number) => {
  const headTurn = win(f, 95, 130, 205, 240);
  const think = win(f, 245, 285, 365, 400);
  const mouse = win(f, 395, 430, 9999, 10000);
  const typing = Math.max(0, 1 - headTurn * 1.2 - think * 1.5 - mouse);
  return {typing, headTurn, think, mouse, lookUp: 0.6 + think * 0.4, lean: 0.5};
};

const Desk: React.FC = () => (
  <g>
    <rect x={-800} y={968} width={3600} height={800} fill={P.floor} />
    <rect x={-800} y={952} width={3600} height={16} fill="#1A2238" />
    {/* chair */}
    <path d="M 604 488 C 586 556 588 664 618 744 L 646 744 C 622 664 620 560 636 494 C 630 482 612 480 604 488 Z" fill="#232A3C" />
    <path d="M 590 778 C 590 766 600 760 612 760 L 770 760 C 784 760 790 770 788 782 L 784 796 L 594 796 Z" fill="#2A3246" />
    <rect x={676} y={800} width={16} height={112} fill="#454E66" />
    <path d="M 684 906 L 584 944 L 590 952 L 684 920 L 784 952 L 790 944 Z" fill="#323A50" />
    {/* desk */}
    <rect x={1010} y={664} width={22} height={304} fill="#2E2321" />
    <rect x={790} y={640} width={950} height={14} fill={P.woodTop} />
    <rect x={790} y={654} width={950} height={12} fill={P.woodEdge} />
  </g>
);
const Keyboard: React.FC = () => (
  <g>
    <path d="M 816 640 L 822 630 L 968 630 L 974 640 Z" fill="#1B2030" />
    <path d="M 824 630 L 966 630 L 966 628 L 826 628 Z" fill="#3A4560" />
    <path d="M 990 640 C 990 628 1012 626 1016 636 L 1018 640 Z" fill="#2A3144" />
    <path d="M 1066 560 L 1090 560 L 1094 638 L 1062 638 Z" fill="#2B3246" />
  </g>
);

const Scene: React.FC<{zoom: number; cx: number; cy: number}> = ({zoom, cx, cy}) => {
  const frame = useCurrentFrame();
  const p = linPosesAt(frame);
  return (
    <AbsoluteFill style={{background: P.wall}}>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080">
        <g transform={`translate(960 540) scale(${zoom}) translate(${-cx} ${-cy})`}>
          <Desk />
          <Lin frame={frame} {...p} />
          <Keyboard />
        </g>
      </svg>
    </AbsoluteFill>
  );
};

const Poses: React.FC = () => <Scene zoom={1.4} cx={820} cy={660} />;
const Close: React.FC = () => <Scene zoom={3.2} cx={800} cy={520} />;

registerRoot(() => (
  <>
    <Composition id="LinPoses" component={Poses} durationInFrames={600} fps={60} width={1920} height={1080} />
    <Composition id="LinClose" component={Close} durationInFrames={600} fps={60} width={1920} height={1080} />
  </>
));
