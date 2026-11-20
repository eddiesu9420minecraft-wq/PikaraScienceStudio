import React from 'react';
import {palette as P} from '../theme/palette';
import {fontStack, type} from '../theme/fonts';
import {ease, progress, tween} from '../lib/anim';

/**
 * Pikara Science 品牌動畫（原創標誌）。
 * 標誌：四道細長稜形組成的「閃光」（pika＝閃耀），右下一枚冰藍色方點代表「資料」。
 * frame 為本元件的本地影格（0 起算）。
 */
const KITE = 'M 0 -96 L 13 -16 L 0 0 L -13 -16 Z';

export const PikaraMark: React.FC<{t: number; size?: number}> = ({t, size = 1}) => (
  <svg width={240 * size} height={240 * size} viewBox="-120 -120 240 240" style={{overflow: 'visible'}}>
    {[0, 90, 180, 270].map((rot, i) => {
      const k = ease.out(progress(t, i * 0.08, 0.5 + i * 0.08));
      const long = i % 2 === 0 ? 1 : 0.72;
      return (
        <g key={rot} transform={`rotate(${rot + (1 - k) * -40}) scale(${k * 0.98 + 0.02} ${(k * 0.98 + 0.02) * long})`}>
          <path d={KITE} fill={P.amber} />
          <path d="M 0 -96 L 13 -16 L 0 0 Z" fill={P.amberDeep} opacity={0.55} />
        </g>
      );
    })}
    <rect
      x={-9}
      y={-9}
      width={18}
      height={18}
      fill={P.ice}
      transform={`translate(${tween(t, 0.45, 0.85, 0, 58, ease.out)} ${tween(t, 0.45, 0.85, 0, 58, ease.out)}) rotate(45) scale(${ease.out(progress(t, 0.45, 0.7))})`}
    />
  </svg>
);

const Reveal: React.FC<{t: number; children: React.ReactNode; delay?: number}> = ({t, children, delay = 0}) => {
  const k = ease.out(progress(t, delay, delay + 0.35));
  return (
    <div style={{overflow: 'hidden', paddingBottom: 6}}>
      <div style={{transform: `translateY(${(1 - k) * 110}%)`, opacity: k}}>{children}</div>
    </div>
  );
};

export const BrandCard: React.FC<{frame: number; duration: number; episode: string; title: string; subtitle: string}> = ({
  frame,
  duration,
  episode,
  title,
  subtitle,
}) => {
  const t = frame / duration;
  const markT = progress(frame, 0, 70);
  const lineK = ease.inOut(progress(frame, 40, 90));
  const textT = progress(frame, 50, 150);
  // 標誌先置中出現，再向左移讓出文字空間
  const shift = tween(frame, 46, 96, 0, 1, ease.camera);
  return (
    <div style={{position: 'absolute', inset: 0, fontFamily: fontStack, opacity: 1 - progress(t, 0.985, 1)}}>
      <div
        style={{
          position: 'absolute',
          left: 960 - 120 - shift * 430,
          top: 540 - 120 - shift * 30,
          transform: `scale(${1 - shift * 0.08})`,
          transformOrigin: '120px 120px',
        }}
      >
        <PikaraMark t={markT} />
      </div>
      <div style={{position: "absolute", left: 760, top: 312, width: 1120}}>
        <Reveal t={textT} delay={0}>
          <div style={{...type.label, fontSize: 26, color: P.mist, letterSpacing: '0.42em'}}>
            PIKARA <span style={{color: P.paper, fontWeight: 700}}>SCIENCE</span>
          </div>
        </Reveal>
        <div style={{height: 2, width: 520 * lineK, background: P.line, margin: '22px 0 30px'}} />
        <Reveal t={textT} delay={0.12}>
          <div style={{...type.mono, fontSize: 30, color: P.amber, letterSpacing: '0.2em'}}>{episode}</div>
        </Reveal>
        <Reveal t={textT} delay={0.2}>
          <div style={{...type.display, fontSize: 64, color: P.paper, lineHeight: 1.25, whiteSpace: "nowrap", marginTop: 14}}>{title}</div>
        </Reveal>
        <Reveal t={textT} delay={0.32}>
          <div style={{...type.label, fontSize: 32, color: P.mist, marginTop: 22, letterSpacing: '0.12em'}}>{subtitle}</div>
        </Reveal>
      </div>
    </div>
  );
};
