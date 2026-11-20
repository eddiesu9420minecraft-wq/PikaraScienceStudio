import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {ModelFile} from './Laptop';
import {fade, PacketTile, type Act2Times} from './shared';

/**
 * 取捨：左邊雲端（機櫃群），右邊本地（筆電，由房間圖層繪製在 LAPTOP_SCREEN 位置）。
 * 中央脊線上四個面向，旁白念到時才亮起，並向兩側伸出細線連到各自的小圖示。
 */
export const LAPTOP_SCREEN = {x: 1480, y: 560, zoom: 1.15};
const SPINE_X = 960;
const ROWS_Y = [404, 516, 628, 740];
const CLOUD_X = 742;
const LOCAL_X = 1176;
const RACK_X = 470;

export const Compare: React.FC<{frame: number; T: Act2Times; o: number}> = ({frame, T, o}) => {
  if (o <= 0.001) return null;
  const inT = progress(frame, T.compare - 30, T.compare + 40);
  const rows = [
    {label: '硬體需求', c: T.cloudcol + 20, l: T.hw},
    {label: '資料傳輸', c: T.net, l: T.offline},
    {label: '隱私', c: T.privacy, l: T.keep},
    {label: '使用成本', c: T.cost, l: T.power},
  ];
  const cloudHead = progress(frame, T.compare - 10, T.compare + 30);
  const localHead = progress(frame, T.compare + 10, T.compare + 50);
  const cloudFocus = 0.55 + 0.45 * fade(frame, T.cloudcol - 20, T.cloudcol, T.localcol - 10, T.localcol + 10);
  const localFocus = 0.55 + 0.45 * progress(frame, T.localcol - 10, T.localcol + 10);
  const netT = progress(frame, T.net - 14, T.net + 16);
  const offT = progress(frame, T.offline - 10, T.offline + 20);
  return (
    <div style={{position: 'absolute', inset: 0, opacity: o}}>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        {/* 機櫃群（雲端） */}
        <g opacity={ease.out(inT)} transform={`translate(${(1 - ease.out(inT)) * -80} 0)`}>
          <RackStack frame={frame} T={T} />
        </g>
        {/* 雲端 ↔ 筆電 的網路連線 */}
        <NetArc frame={frame} T={T} t={netT} off={offT} />
        {/* 脊線 */}
        <line x1={SPINE_X} y1={ROWS_Y[0] - 40} x2={SPINE_X} y2={lerp(ROWS_Y[0] - 40, ROWS_Y[3] + 40, ease.out(inT))} stroke={P.line} strokeWidth={2} />
        {rows.map((r, i) => {
          const tc = progress(frame, r.c - 12, r.c + 14);
          const tl = progress(frame, r.l - 12, r.l + 14);
          const y = ROWS_Y[i];
          return (
            <g key={i}>
              <rect x={SPINE_X - 5} y={y - 5} width={10} height={10} transform={`rotate(45 ${SPINE_X} ${y})`} fill={tc > 0 || tl > 0 ? P.paper : P.line} />
              {tc > 0 ? <line x1={SPINE_X - 82} y1={y} x2={lerp(SPINE_X - 82, CLOUD_X + 62, ease.out(tc))} y2={y} stroke={P.ice} strokeWidth={1.4} opacity={0.7} /> : null}
              {tl > 0 ? <line x1={SPINE_X + 82} y1={y} x2={lerp(SPINE_X + 82, LOCAL_X - 62, ease.out(tl))} y2={y} stroke={P.amber} strokeWidth={1.4} opacity={0.7} /> : null}
              <g transform={`translate(${CLOUD_X} ${y})`} opacity={ease.out(tc)}>
                {i === 0 ? <ModelGrid cols={7} rows={5} cell={9} color={P.amber} frame={frame} /> : null}
                {i === 1 ? <Wifi color={P.ice} slash={false} /> : null}
                {i === 2 ? <SendAway frame={frame} t={tc} /> : null}
                {i === 3 ? <Meter frame={frame} start={r.c} /> : null}
              </g>
              <g transform={`translate(${LOCAL_X} ${y})`} opacity={ease.out(tl)}>
                {i === 0 ? <ModelGrid cols={3} rows={2} cell={9} color={P.amber} frame={frame} /> : null}
                {i === 1 ? <Wifi color={P.amber} slash /> : null}
                {i === 2 ? <Shield t={tl} /> : null}
                {i === 3 ? <Plug t={tl} /> : null}
              </g>
            </g>
          );
        })}
      </svg>
      {/* 文字 */}
      <Head x={RACK_X} y={96} text="雲端" color={P.ice} t={cloudHead} focus={cloudFocus} />
      <Head x={LAPTOP_SCREEN.x} y={96} text="本地" color={P.amber} t={localHead} focus={localFocus} />
      {rows.map((r, i) => {
        const tc = progress(frame, r.c - 12, r.c + 14);
        const tl = progress(frame, r.l - 12, r.l + 14);
        const active = Math.max(tc, tl);
        const current = Math.max(fade(frame, r.c - 12, r.c + 4, r.c + 90, r.c + 110), fade(frame, r.l - 12, r.l + 4, r.l + 90, r.l + 110));
        const y = ROWS_Y[i];
        return (
          <React.Fragment key={i}>
            <div
              style={{
                position: 'absolute',
                left: SPINE_X - 200,
                top: y - 46,
                width: 400,
                textAlign: 'center',
                
                ...type.title,
                fontSize: 26,
                color: active > 0 ? P.paper : P.mist,
                opacity: progress(frame, T.compare + 10 + i * 6, T.compare + 40 + i * 6) * (0.45 + 0.55 * Math.max(active * 0.7, current)),
              }}
            >
              {r.label}
            </div>
            <Caption x={CLOUD_X} y={y + 34} t={tc} color={P.ice} text={['更大、更強的模型', '需要連上網路', '傳到別人的伺服器', '用量大要付費'][i]} />
            <Caption x={LOCAL_X} y={y + 34} t={tl} color={P.amber} text={['受限於自己的硬體', '可以離線使用', '留在自己手上', '只有電費'][i]} />
          </React.Fragment>
        );
      })}
    </div>
  );
};

const Head: React.FC<{x: number; y: number; text: string; color: string; t: number; focus: number}> = ({x, y, text, color, t, focus}) =>
  t > 0.001 ? (
    <div style={{position: 'absolute', left: x - 200, top: y, width: 400, textAlign: 'center', fontFamily: fontStack, opacity: t * focus}}>
      <div style={{...type.display, fontSize: 52, color, transform: `translateY(${(1 - ease.out(t)) * 20}px)`}}>{text}</div>
      <div style={{height: 2, width: 80 * ease.out(t), background: color, margin: '8px auto 0', opacity: 0.7}} />
    </div>
  ) : null;

const Caption: React.FC<{x: number; y: number; t: number; color: string; text: string}> = ({x, y, t, color, text}) =>
  t > 0.001 ? (
    <div
      style={{
        position: 'absolute',
        left: x - 160,
        top: y,
        width: 320,
        textAlign: 'center',
        
        ...type.label,
        fontSize: 21,
        color,
        opacity: progress(t, 0.3, 1),
        whiteSpace: 'nowrap',
        letterSpacing: '0.04em',
      }}
    >
      {text}
    </div>
  ) : null;

// ---------------- 圖示 ----------------

const RackStack: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const busy = progress(frame, T.cloudcol - 10, T.cloudcol + 20);
  const rack = (x: number, y: number, w: number, h: number, shade: number, seed: number) => {
    const units = 11;
    const uh = (h - 30) / units;
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} fill={shade ? '#141A26' : '#1B2231'} stroke="#2E3850" strokeWidth={2} />
        <rect x={x} y={y} width={w} height={6} fill="#2E3850" />
        {Array.from({length: units}).map((_, u) => {
          const uy = y + 16 + u * uh;
          const on = ((Math.floor((frame + seed * 13 + u * 7) / (14 + ((u + seed) % 5) * 4)) + u) % 3) !== 0;
          return (
            <g key={u}>
              <rect x={x + 8} y={uy} width={w - 16} height={uh - 4} fill={shade ? '#171D29' : '#202838'} />
              {Array.from({length: 5}).map((__, g) => (
                <rect key={g} x={x + 18} y={uy + 4 + g * ((uh - 10) / 5)} width={w * 0.5} height={1.4} fill="#0E121A" />
              ))}
              <circle cx={x + w - 18} cy={uy + uh / 2 - 2} r={2.4} fill={on ? (u % 4 === 0 ? P.mint : P.ice) : '#24324A'} opacity={shade ? 0.5 : 0.6 + 0.4 * busy} />
              <circle cx={x + w - 28} cy={uy + uh / 2 - 2} r={2.4} fill={busy > 0.5 && (u + Math.floor(frame / 6)) % 3 === 0 ? P.amber : '#24324A'} opacity={shade ? 0.5 : 1} />
            </g>
          );
        })}
      </g>
    );
  };
  return (
    <g>
      {/* 雲的輪廓：用細線暗示「遠端」 */}
      <path
        d="M 300 300 C 290 250 340 220 380 236 C 400 196 470 186 500 226 C 540 200 600 220 600 262 C 650 266 664 320 630 340"
        fill="none"
        stroke={P.ice}
        strokeWidth={2}
        opacity={0.35}
      />
      {rack(268, 318, 112, 430, 1, 3)}
      {rack(560, 318, 112, 430, 1, 7)}
      {rack(394, 288, 152, 474, 0, 1)}
      <ellipse cx={RACK_X} cy={772} rx={230} ry={14} fill="#05070D" opacity={0.6} />
    </g>
  );
};

const NetArc: React.FC<{frame: number; T: Act2Times; t: number; off: number}> = ({frame, T, t, off}) => {
  if (t <= 0.001) return null;
  const a = {x: LAPTOP_SCREEN.x - 60, y: 372};
  const c = {x: 960, y: 150};
  const b = {x: RACK_X + 60, y: 286};
  const q = (k: number) => ({
    x: (1 - k) * (1 - k) * a.x + 2 * (1 - k) * k * c.x + k * k * b.x,
    y: (1 - k) * (1 - k) * a.y + 2 * (1 - k) * k * c.y + k * k * b.y,
  });
  const draw = ease.out(t);
  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const p = q((i / 60) * draw);
    pts.push(`${i ? 'L' : 'M'} ${p.x} ${p.y}`);
  }
  const mid = q(0.5);
  const priv = progress(frame, T.privacy - 10, T.privacy + 10) * (1 - progress(frame, T.localcol - 10, T.localcol + 10));
  return (
    <g opacity={1 - 0.7 * off}>
      <path d={pts.join(' ')} fill="none" stroke={P.ice} strokeWidth={2} strokeDasharray="7 7" strokeDashoffset={-frame * 0.8} opacity={0.75} />
      {draw > 0.98
        ? Array.from({length: 6}).map((_, i) => {
            const raw = (((frame - T.net) / 70 + i / 6) % 1 + 1) % 1;
            const toCloud = i % 2 === 0;
            const k = toCloud ? raw : 1 - raw;
            const p = q(k);
            const env = Math.sin(raw * Math.PI);
            return <PacketTile key={i} x={p.x} y={p.y} size={16} o={clamp(env * 2) * (1 - off)} answer={!toCloud} rot={0} />;
          })
        : null}
      {/* 隱私：對話內容（文件）沿線送往雲端 */}
      {priv > 0.01
        ? (() => {
            const k = (((frame - T.privacy) / 90) % 1 + 1) % 1;
            const p = q(k);
            return (
              <g transform={`translate(${p.x} ${p.y})`} opacity={priv * Math.sin(k * Math.PI)}>
                <path d="M -11 -14 L 5 -14 L 11 -8 L 11 14 L -11 14 Z" fill="#1B2A44" stroke={P.paper} strokeWidth={1.6} />
                <rect x={-6} y={-6} width={12} height={2} fill={P.paper} />
                <rect x={-6} y={0} width={12} height={2} fill={P.paper} />
                <rect x={-6} y={6} width={8} height={2} fill={P.paper} />
              </g>
            );
          })()
        : null}
      <circle cx={mid.x} cy={mid.y} r={0} />
    </g>
  );
};

const ModelGrid: React.FC<{cols: number; rows: number; cell: number; color: string; frame: number}> = ({cols, rows, cell, frame}) => {
  const w = cols * cell;
  const h = rows * cell;
  return (
    <g transform={`translate(${-w / 2} ${-h / 2 - 8})`}>
      {Array.from({length: cols * rows}).map((_, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const v = Math.sin(i * 12.9898 + 1.3) * 0.5 + 0.5;
        return <rect key={i} x={c * cell + 1} y={r * cell + 1} width={cell - 2} height={cell - 2} fill={v > 0.45 ? P.amber : P.ice} opacity={0.35 + 0.5 * v + 0.15 * Math.sin(frame / 8 + i)} />;
      })}
    </g>
  );
};

const Wifi: React.FC<{color: string; slash: boolean}> = ({color, slash}) => (
  <g transform="translate(0 -6)">
    {[22, 15, 8].map((r, i) => (
      <path key={i} d={`M ${-r} ${-r * 0.35 + 6} A ${r} ${r} 0 0 1 ${r} ${-r * 0.35 + 6}`} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" opacity={slash ? 0.45 : 1} transform={`translate(0 ${i * 0})`} />
    ))}
    <circle cx={0} cy={10} r={3.2} fill={color} />
    {slash ? <line x1={-20} y1={-16} x2={20} y2={16} stroke={color} strokeWidth={3.4} strokeLinecap="round" /> : null}
  </g>
);

const SendAway: React.FC<{frame: number; t: number}> = ({frame}) => {
  const k = ((frame / 40) % 1 + 1) % 1;
  return (
    <g transform="translate(0 -8)">
      <path d="M -40 -14 L -26 -14 L -20 -8 L -20 14 L -40 14 Z" fill="#1B2A44" stroke={P.paper} strokeWidth={1.6} />
      <rect x={-35} y={-5} width={10} height={2} fill={P.paper} />
      <rect x={-35} y={1} width={10} height={2} fill={P.paper} />
      <line x1={-12} y1={0} x2={14} y2={0} stroke={P.ice} strokeWidth={2} strokeDasharray="4 4" strokeDashoffset={-k * 16} />
      <path d="M 12 -5 L 19 0 L 12 5" fill="none" stroke={P.ice} strokeWidth={2} />
      <rect x={24} y={-16} width={22} height={32} fill="#1B2231" stroke={P.ice} strokeWidth={1.6} />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={28} y={-11 + i * 9} width={14} height={5} fill="#2E3850" />
      ))}
    </g>
  );
};

const Meter: React.FC<{frame: number; start: number}> = ({frame, start}) => {
  const n = Math.max(0, Math.floor((frame - start) / 16));
  const digits = String(n + 1).padStart(4, '0');
  const tick = ((frame - start) % 16) / 16;
  return (
    <g transform="translate(0 -8)">
      <rect x={-48} y={-17} width={96} height={34} fill="#0E1626" stroke={P.ice} strokeWidth={1.6} />
      {digits.split('').map((d, i) => (
        <text key={i} x={-33 + i * 22} y={8} fontSize={22} textAnchor="middle" fill={i === 3 ? P.ice : P.paper} fontFamily='"Cascadia Mono", Consolas, monospace' fontWeight={600} opacity={i === 3 ? 0.6 + 0.4 * (1 - tick) : 0.9}>
          {d}
        </text>
      ))}
      <circle cx={56} cy={0} r={4} fill={P.ice} opacity={1 - tick} />
    </g>
  );
};

const Shield: React.FC<{t: number}> = ({t}) => (
  <g transform="translate(0 -8)">
    <path d="M 0 -22 L 20 -14 L 20 2 C 20 14 10 20 0 24 C -10 20 -20 14 -20 2 L -20 -14 Z" fill="#1E2536" stroke={P.amber} strokeWidth={2.2} />
    <rect x={-7} y={-2} width={14} height={11} fill={P.amber} />
    <path d={`M -4.5 -2 L -4.5 ${-7 + (1 - ease.out(t)) * -4} A 4.5 4.5 0 0 1 4.5 ${-7 + (1 - ease.out(t)) * -4} L 4.5 -2`} fill="none" stroke={P.amber} strokeWidth={2.2} />
  </g>
);

const Plug: React.FC<{t: number}> = ({t}) => {
  const k = ease.out(t);
  return (
    <g transform="translate(0 -8)">
      <rect x={6} y={-16} width={24} height={32} fill="#1E2536" stroke={P.amber} strokeWidth={1.8} />
      <circle cx={18} cy={-4} r={2.4} fill="#0A0D14" />
      <circle cx={18} cy={6} r={2.4} fill="#0A0D14" />
      <g transform={`translate(${-14 * (1 - k)} 0)`}>
        <rect x={-26} y={-10} width={22} height={20} fill={P.amber} />
        <rect x={-4} y={-6} width={8} height={3} fill={P.paper} />
        <rect x={-4} y={4} width={8} height={3} fill={P.paper} />
        <path d="M -26 0 C -40 0 -40 14 -54 14" fill="none" stroke={P.amber} strokeWidth={3} />
      </g>
    </g>
  );
};

export {ModelFile};
