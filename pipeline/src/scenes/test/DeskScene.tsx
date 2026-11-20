import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {Lin} from '../../characters/Lin';
import {Cam2D, cam2dAt, CameraLayer} from '../../lib/camera2d';
import {ease, progress, tween} from '../../lib/anim';
import {SHOT} from './shots';

// 2D 世界攝影機：慢推 → 看向螢幕 → 轉向主機側透 → 穿入玻璃（與 3D 鏡頭速度銜接）
const CAM_KEYS = [
  {f: 0, v: {cx: 1010, cy: 610, zoom: 1.0}},
  {f: 120, v: {cx: 1000, cy: 560, zoom: 1.14}, ease: ease.inOutSoft},
  {f: 150, v: {cx: 1080, cy: 540, zoom: 1.24}, ease: ease.inOutSoft},
  {f: 212, v: {cx: 1480, cy: 520, zoom: 4.7}, ease: ease.camera},
  {f: 252, v: {cx: 1480, cy: 520, zoom: 6.2}, ease: ease.linear},
];

const QUESTION = 'AI 是怎麼在我的電腦上運行的？';
const REPLY = '當你按下 Enter，模型會先把這句話切成 token……';

/** 其他幕可覆寫：攝影機、螢幕文字進度與人物姿勢（皆為 0..1 或字數）。 */
export type DeskOverride = {
  cam?: Cam2D;
  typedChars?: number;
  sent?: boolean;
  reply?: string;
  replyChars?: number;
  typing?: number;
  lookUp?: number;
  lean?: number;
  /** 傳給 Lin 的其他姿勢參數（headTurn、think、mouse…） */
  pose?: Record<string, number>;
  glassSweep?: boolean;
};

export const DeskScene: React.FC<{frame: number; override?: DeskOverride}> = ({frame, override = {}}) => {
  const cam = override.cam ?? cam2dAt(frame, CAM_KEYS);
  const typedChars = override.typedChars ?? Math.floor(tween(frame, 18, 118, 0, QUESTION.length, ease.linear));
  const sent = override.sent ?? frame >= 128;
  const replyText = override.reply ?? REPLY;
  const replyChars = override.replyChars ?? Math.floor(tween(frame, 150, 232, 0, REPLY.length, ease.linear));
  const typing = override.typing ?? (frame < 122 ? 1 : 0);
  const lookUp = override.lookUp ?? progress(frame, 124, 150);
  const lean = override.lean ?? 0.4 + lookUp * 0.6;
  const LinAny = Lin as unknown as React.FC<Record<string, number>>;

  return (
    <div style={{position: 'absolute', inset: 0, background: P.wall, overflow: 'hidden'}}>
      {/* 遠景：牆面與窗（視差 0.75） */}
      <CameraLayer cam={cam} depth={0.75}>
        <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{overflow: 'visible'}}>
          <Room />
        </svg>
      </CameraLayer>

      {/* 主景 */}
      <CameraLayer cam={cam}>
        <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{position: 'absolute', overflow: 'visible'}}>
          <Floor />
          <Chair />
          <Desk />
          <PcTower frame={frame} />
          <Lamp />
          {/* 滑鼠先畫，手才會蓋在滑鼠上 */}
          <path d="M 990 640 C 990 628 1012 626 1016 636 L 1018 640 Z" fill="#2A3144" />
          <LinAny frame={frame} typing={typing} lookUp={lookUp} lean={lean} {...(override.pose ?? {})} />
          <Keyboard frame={frame} />
          <Mug />
          <MonitorStand />
        </svg>
        <Monitor typed={QUESTION.slice(0, typedChars)} sent={sent} reply={replyText.slice(0, replyChars)} frame={frame} />
        {/* 螢幕與檯燈的光池（只用低透明度，避免過度發光） */}
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, mixBlendMode: 'screen', pointerEvents: 'none'}}>
          <defs>
            <radialGradient id="pool-screen" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor={P.ice} stopOpacity={0.16} />
              <stop offset="1" stopColor={P.ice} stopOpacity={0} />
            </radialGradient>
            <radialGradient id="pool-lamp" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor={P.amber} stopOpacity={0.2} />
              <stop offset="1" stopColor={P.amber} stopOpacity={0} />
            </radialGradient>
          </defs>
          <ellipse cx={980} cy={500} rx={420} ry={300} fill="url(#pool-screen)" />
          <ellipse cx={1700} cy={640} rx={260} ry={120} fill="url(#pool-lamp)" />
        </svg>
      </CameraLayer>

      {/* 穿過側透玻璃時的反光掃過 */}
      {override.glassSweep === false ? null : <GlassSweep frame={frame} />}
    </div>
  );
};

// ---------------- 場景元件 ----------------

const Room: React.FC = () => (
  <g>
    <rect x={-800} y={-600} width={3600} height={2400} fill={P.wall} />
    {/* 牆面細分割線（壁板），提供空間尺度 */}
    {Array.from({length: 14}).map((_, i) => (
      <rect key={i} x={-400 + i * 220} y={-200} width={2} height={1170} fill={P.wallLight} opacity={0.55} />
    ))}
    {/* 窗與夜景 */}
    <g>
      <rect x={150} y={170} width={380} height={440} fill="#0A1222" />
      <path
        d="M 150 610 L 150 470 L 190 470 L 190 430 L 232 430 L 232 500 L 262 500 L 262 400 L 312 400 L 312 520 L 350 520 L 350 452 L 398 452 L 398 488 L 440 488 L 440 380 L 482 380 L 482 540 L 530 540 L 530 610 Z"
        fill="#131D33"
      />
      {[
        [204, 452], [248, 470], [290, 420], [296, 456], [326, 540], [372, 470], [458, 404], [462, 440], [470, 500], [420, 510],
      ].map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={6} height={8} fill={i % 3 === 0 ? P.amber : '#7E8DB0'} opacity={0.55} />
      ))}
      <circle cx={440} cy={250} r={16} fill="#D8DDEA" opacity={0.75} />
      <rect x={150} y={170} width={380} height={440} fill="none" stroke="#232E48" strokeWidth={14} />
      <rect x={334} y={170} width={12} height={440} fill="#232E48" />
      <rect x={130} y={610} width={420} height={16} fill="#283453" />
      {/* 窗簾 */}
      <path d="M 104 150 L 160 150 C 150 300 168 460 150 640 L 96 640 C 112 460 92 300 104 150 Z" fill="#26304A" />
      <path d="M 520 150 L 576 150 C 588 300 568 460 584 640 L 530 640 C 548 460 530 300 520 150 Z" fill="#26304A" />
    </g>
    {/* 牆上掛畫：抽象的矩陣格（為後面的矩陣運算埋伏筆） */}
    <g transform="translate(1180 140)">
      <rect x={0} y={0} width={190} height={150} fill="#111829" stroke="#2C3858" strokeWidth={6} />
      {Array.from({length: 6 * 5}).map((_, i) => {
        const cx = i % 6;
        const cy = Math.floor(i / 6);
        const v = Math.sin(i * 12.9898) * 0.5 + 0.5;
        return <rect key={i} x={20 + cx * 26} y={18 + cy * 24} width={18} height={16} fill={v > 0.55 ? P.amber : P.ice} opacity={0.15 + v * 0.35} />;
      })}
    </g>
    {/* 層架 */}
    <rect x={1500} y={250} width={300} height={10} fill={P.woodEdge} />
    <rect x={1520} y={196} width={22} height={54} fill="#3D4A6A" />
    <rect x={1546} y={204} width={18} height={46} fill="#6B4E45" />
    <rect x={1568} y={188} width={26} height={62} fill="#2F3D5C" />
    <rect x={1600} y={210} width={16} height={40} fill="#5E6F94" />
    <path d="M 1700 250 C 1700 220 1720 206 1736 206 C 1752 206 1772 220 1772 250 Z" fill="#2E4A44" />
  </g>
);

const Floor: React.FC = () => (
  <g>
    <rect x={-800} y={968} width={3600} height={800} fill={P.floor} />
    <rect x={-800} y={952} width={3600} height={16} fill="#1A2238" />
  </g>
);

const Chair: React.FC = () => (
  <g>
    {/* 椅背 */}
    <path d="M 604 488 C 586 556 588 664 618 744 L 646 744 C 622 664 620 560 636 494 C 630 482 612 480 604 488 Z" fill="#232A3C" />
    <path d="M 612 500 C 600 560 602 650 624 730" stroke="#38425C" strokeWidth={4} fill="none" strokeLinecap="round" />
    {/* 座墊 */}
    <path d="M 590 778 C 590 766 600 760 612 760 L 770 760 C 784 760 790 770 788 782 L 784 796 L 594 796 Z" fill="#2A3246" />
    <rect x={598} y={792} width={182} height={8} fill="#1C2232" />
    {/* 氣壓桿與五爪腳 */}
    <rect x={676} y={800} width={16} height={112} fill="#454E66" />
    <rect x={679} y={800} width={4} height={112} fill="#69738E" />
    <path d="M 684 906 L 584 944 L 590 952 L 684 920 L 784 952 L 790 944 Z" fill="#323A50" />
    {[588, 684, 786].map((x) => (
      <circle key={x} cx={x} cy={956} r={11} fill="#1B202D" />
    ))}
  </g>
);

const Desk: React.FC = () => (
  <g>
    <rect x={1010} y={664} width={22} height={304} fill="#2E2321" />
    <rect x={1700} y={664} width={22} height={304} fill="#2E2321" />
    <rect x={1032} y={690} width={668} height={10} fill="#2A201E" />
    <rect x={790} y={640} width={950} height={14} fill={P.woodTop} />
    <rect x={790} y={654} width={950} height={12} fill={P.woodEdge} />
    <rect x={790} y={640} width={950} height={2} fill="#7C5E53" />
  </g>
);

const Keyboard: React.FC<{frame: number}> = ({frame}) => (
  <g>
    <path d="M 816 640 L 822 630 L 968 630 L 974 640 Z" fill="#1B2030" />
    <path d="M 824 630 L 966 630 L 966 628 L 826 628 Z" fill="#3A4560" />
    {Array.from({length: 14}).map((_, i) => {
      const pressed = frame < 122 && (Math.floor(frame / 3) + i * 7) % 11 === 0;
      return <rect key={i} x={828 + i * 10} y={pressed ? 631.5 : 630.5} width={7} height={3} fill={pressed ? P.ice : '#55627F'} opacity={pressed ? 0.9 : 0.7} />;
    })}

  </g>
);

const Mug: React.FC = () => (
  <g>
    <path d="M 1290 600 L 1330 600 L 1326 640 L 1294 640 Z" fill="#C9583F" />
    <path d="M 1330 608 C 1346 608 1346 628 1328 628" stroke="#C9583F" strokeWidth={6} fill="none" />
    <rect x={1290} y={600} width={40} height={4} fill="#E47A60" />
  </g>
);

const MonitorStand: React.FC = () => (
  <g>
    <ellipse cx={1078} cy={640} rx={64} ry={5} fill="#1B2030" />
    <path d="M 1066 560 L 1090 560 L 1094 638 L 1062 638 Z" fill="#2B3246" />
    <rect x={1068} y={560} width={4} height={78} fill="#49536E" />
  </g>
);

const Lamp: React.FC = () => (
  <g>
    <ellipse cx={1690} cy={638} rx={44} ry={6} fill="#262D40" />
    <line x1={1690} y1={636} x2={1650} y2={520} stroke="#3A4460" strokeWidth={7} strokeLinecap="round" />
    <line x1={1650} y1={520} x2={1712} y2={470} stroke="#3A4460" strokeWidth={7} strokeLinecap="round" />
    <path d="M 1696 456 L 1748 470 L 1738 504 L 1700 492 Z" fill="#454F6C" />
    <path d="M 1700 492 L 1738 504" stroke={P.amber} strokeWidth={4} strokeLinecap="round" />
    <path d="M 1702 494 L 1740 506 L 1790 640 L 1620 640 Z" fill={P.amber} opacity={0.05} />
  </g>
);

/** 主機：側透玻璃面向鏡頭；顯示卡外殼側面的琥珀色細線與 3D 模型一致，方便鏡頭銜接。 */
const PcTower: React.FC<{frame: number}> = ({frame}) => {
  const fan = frame * 9;
  return (
    <g>
      <rect x={1376} y={316} width={252} height={324} fill="#1A1F2C" />
      <rect x={1380} y={320} width={244} height={316} fill="#232A3B" />
      {/* 玻璃內部 */}
      <rect x={1392} y={334} width={220} height={288} fill="#0E1424" />
      {/* 主機板 */}
      <rect x={1404} y={344} width={160} height={180} fill="#121A2A" />
      <rect x={1404} y={344} width={160} height={180} fill="none" stroke="#1D2840" strokeWidth={2} />
      {/* CPU 散熱器 */}
      <rect x={1428} y={372} width={56} height={56} fill="#252D40" />
      <g transform={`rotate(${fan * 0.6} 1456 400)`}>
        {Array.from({length: 7}).map((_, i) => (
          <path key={i} d="M 1456 400 C 1460 388 1470 382 1478 384 C 1470 392 1464 398 1456 400 Z" fill="#3A4560" transform={`rotate(${(i * 360) / 7} 1456 400)`} />
        ))}
      </g>
      <circle cx={1456} cy={400} r={6} fill="#4A5675" />
      {/* 記憶體條 */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={1502 + i * 10} y={360} width={6} height={74} fill="#2C3650" />
          <rect x={1502 + i * 10} y={360} width={6} height={4} fill={P.ice} opacity={0.6} />
        </g>
      ))}
      {/* 顯示卡（側面） */}
      <g>
        <rect x={1396} y={500} width={172} height={42} fill="#262C3B" />
        <rect x={1396} y={500} width={172} height={4} fill="#3F475D" />
        <rect x={1404} y={520} width={156} height={2.2} fill={P.amber} opacity={0.85} />
        {Array.from({length: 18}).map((_, i) => (
          <rect key={i} x={1408 + i * 8.6} y={527} width={4} height={10} fill="#1A1F2C" />
        ))}
        <rect x={1392} y={496} width={8} height={56} fill="#7D879E" />
      </g>
      {/* 電源倉 */}
      <rect x={1392} y={584} width={220} height={38} fill="#1A2030" />
      {/* 前置風扇（右側） */}
      {[384, 470].map((cy) => (
        <g key={cy}>
          <circle cx={1592} cy={cy} r={16} fill="#161C2A" stroke="#2C3550" strokeWidth={2} />
          <g transform={`rotate(${fan} 1592 ${cy})`}>
            {Array.from({length: 5}).map((_, i) => (
              <path key={i} d={`M 1592 ${cy} C 1596 ${cy - 8} 1602 ${cy - 12} 1606 ${cy - 10} C 1600 ${cy - 4} 1597 ${cy - 1} 1592 ${cy} Z`} fill="#323C56" transform={`rotate(${i * 72} 1592 ${cy})`} />
            ))}
          </g>
        </g>
      ))}
      {/* 玻璃反光 */}
      <path d="M 1430 334 L 1470 334 L 1400 622 L 1392 622 L 1392 480 Z" fill="#FFFFFF" opacity={0.045} />
      <rect x={1392} y={334} width={220} height={288} fill="none" stroke="#3A4460" strokeWidth={2} />
      {/* 腳墊 */}
      <rect x={1392} y={640} width={26} height={4} fill="#111" />
      <rect x={1586} y={640} width={26} height={4} fill="#111" />
    </g>
  );
};

const Monitor: React.FC<{typed: string; sent: boolean; reply: string; frame: number}> = ({typed, sent, reply, frame}) => {
  const cursorOn = Math.floor(frame / 15) % 2 === 0;
  return (
    <div style={{position: 'absolute', left: 880, top: 330, width: 400, height: 240, perspective: 900}}>
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: 'rotateY(-16deg)',
          transformOrigin: '30% 50%',
          background: '#171C29',
          padding: 9,
          boxSizing: 'border-box',
          boxShadow: '0 0 0 2px #262D40',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'linear-gradient(180deg, #0F1A2E 0%, #0C1424 100%)',
            fontFamily: fontStack,
            color: P.paper,
            boxSizing: 'border-box',
            padding: '14px 18px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 11, color: P.mist, ...type.label}}>
            <span>本地模型 · llama.cpp</span>
            <span style={{color: P.amber}}>● 離線</span>
          </div>
          <div style={{height: 1, background: '#22304C', margin: '9px 0 14px'}} />
          <div style={{fontSize: 15, lineHeight: 1.5, borderLeft: `2px solid ${P.amber}`, paddingLeft: 10, minHeight: 23, fontWeight: 500}}>
            {typed}
            {!sent && cursorOn ? <span style={{color: P.amber}}>▍</span> : null}
          </div>
          {sent ? (
            <div style={{marginTop: 14, fontSize: 13.5, lineHeight: 1.6, color: '#BFD4EA', borderLeft: `2px solid ${P.ice}`, paddingLeft: 10, fontWeight: 400}}>
              {reply.length === 0 ? <span style={{color: P.mist}}>正在生成…</span> : reply}
              {reply.length > 0 && cursorOn ? <span style={{color: P.ice}}>▍</span> : null}
            </div>
          ) : null}
          <div style={{position: 'absolute', left: 18, right: 18, bottom: 12, height: 24, border: '1px solid #22304C', fontSize: 10, color: '#56647F', padding: '5px 8px', boxSizing: 'border-box', ...type.label}}>
            輸入訊息…
          </div>
        </div>
      </div>
    </div>
  );
};

const GlassSweep: React.FC<{frame: number}> = ({frame}) => {
  const t = progress(frame, SHOT.deskGlassSweepStart, SHOT.deskGlassSweepStart + 34);
  if (t <= 0 || t >= 1) return null;
  const x = -600 + t * 3100;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `linear-gradient(105deg, transparent ${x - 260}px, rgba(220,235,255,0.10) ${x - 60}px, rgba(220,235,255,0.16) ${x}px, transparent ${x + 120}px)`,
        pointerEvents: 'none',
      }}
    />
  );
};
