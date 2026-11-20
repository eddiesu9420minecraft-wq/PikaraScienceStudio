import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {ActProps} from './types';
import {palette as P} from '../theme/palette';
import {fontStack, type} from '../theme/fonts';
import {clamp, ease, lerp, progress, tween} from '../lib/anim';
import {camTransform} from '../lib/camera2d';
import {DeskScene} from '../scenes/test/DeskScene';
import {BrandCard} from '../components/PikaraBrand';
import {Vignette} from '../components/Vignette';

/**
 * 第七幕：總結。
 * A. 回顧管線：一顆資料點沿著「權重 → 量化 → GGUF → 載入記憶體 → token → 向量 → GPU 矩陣運算 → 機率 → 文字」前進，
 *    每一站在旁白念到時點亮（連續橫移鏡頭，不是投影片）。
 * B. 最後一站「文字」推進成螢幕 → 接回第一幕的房間，鏡頭拉遠；念到「做數學」時人物轉頭看向觀眾。
 * C. 品牌片尾。
 */
type Station = {key: string; label: string; sub: string; icon: (on: number) => React.ReactNode};

const GAP = 400;
const X0 = 320;
const Y0 = 540;
const sx = (i: number) => X0 + i * GAP;
const sy = (i: number) => Y0 + Math.sin(i * 0.9) * 46;

const stroke = (c: string, on: number) => ({stroke: c, strokeWidth: 3, fill: 'none', opacity: 0.35 + 0.65 * on, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const});

const STATIONS: Station[] = [
  {
    key: 'weights', label: '訓練好的權重', sub: '一張張矩陣',
    icon: (on) => (
      <g>
        {Array.from({length: 16}).map((_, i) => (
          <rect key={i} x={-46 + (i % 4) * 24} y={-46 + Math.floor(i / 4) * 24} width={20} height={20} fill={(i * 7) % 3 ? P.amber : P.ice} opacity={(0.25 + 0.6 * on) * (0.5 + 0.5 * ((i * 5) % 4) / 3)} />
        ))}
      </g>
    ),
  },
  {
    key: 'quant', label: '量化', sub: '用更少位元近似',
    icon: (on) => (
      <g>
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={-50} y={-36 + i * 20} width={lerp(100, 46, on * (i % 2 ? 1 : 0.8))} height={12} fill={P.amber} opacity={0.35 + 0.6 * on} />
        ))}
      </g>
    ),
  },
  {
    key: 'gguf', label: 'GGUF 檔案', sub: '檔頭＋中繼資料＋張量',
    icon: (on) => (
      <g>
        <path d="M -36 -52 L 20 -52 L 40 -32 L 40 52 L -36 52 Z" {...stroke(P.paper, on)} />
        <path d="M 20 -52 L 20 -32 L 40 -32" {...stroke(P.paper, on)} />
        <rect x={-26} y={-20} width={56} height={8} fill={P.ice} opacity={0.3 + 0.6 * on} />
        <rect x={-26} y={-4} width={56} height={8} fill={P.mint} opacity={0.3 + 0.6 * on} />
        <rect x={-26} y={12} width={56} height={30} fill={P.amber} opacity={0.3 + 0.6 * on} />
      </g>
    ),
  },
  {
    key: 'load', label: 'SSD → RAM → VRAM', sub: 'llama.cpp 載入權重',
    icon: (on) => (
      <g>
        <rect x={-58} y={-14} width={30} height={28} {...stroke(P.mist, on)} />
        <rect x={-14} y={-20} width={30} height={40} {...stroke(P.ice, on)} />
        <rect x={30} y={-28} width={30} height={56} {...stroke(P.amber, on)} />
        <path d="M -26 0 L -16 0 M 18 0 L 28 0" {...stroke(P.paper, on)} />
      </g>
    ),
  },
  {
    key: 'tokens', label: '切成 token', sub: '文字 → 編號',
    icon: (on) => (
      <g>
        {[-48, -14, 20].map((x, i) => (
          <g key={x} transform={`translate(${x + i * 4 * on} 0)`}>
            <rect x={0} y={-18} width={30} height={36} {...stroke(P.ice, on)} />
            <text x={15} y={6} textAnchor="middle" fontSize={14} fill={P.ice} opacity={0.4 + 0.6 * on} fontFamily="Consolas, monospace">
              {['42', '7', '913'][i]}
            </text>
          </g>
        ))}
      </g>
    ),
  },
  {
    key: 'vector', label: '變成向量', sub: '一長串數字',
    icon: (on) => (
      <g>
        {Array.from({length: 7}).map((_, i) => (
          <rect key={i} x={-12} y={-56 + i * 16} width={lerp(14, 24 + ((i * 13) % 5) * 9, on)} height={11} fill={i % 3 ? P.ice : P.amber} opacity={0.35 + 0.6 * on} />
        ))}
      </g>
    ),
  },
  {
    key: 'gpu', label: 'GPU 矩陣運算', sub: '一層又一層',
    icon: (on) => (
      <g>
        {[0, 1, 2].map((i) => (
          <path key={i} d={`M ${-50 + i * 10} ${30 - i * 22} L ${10 + i * 10} ${30 - i * 22} L ${50 + i * 10 - 10} ${8 - i * 22} L ${-10 + i * 10 - 10} ${8 - i * 22} Z`} fill={P.amber} opacity={(0.18 + 0.4 * on) * (1 - i * 0.2)} stroke={P.amber} strokeWidth={1.5} />
        ))}
      </g>
    ),
  },
  {
    key: 'prob', label: '下一個 token 的機率', sub: 'logits → 取樣',
    icon: (on) => (
      <g>
        {[0.35, 0.9, 0.5, 0.2, 0.12].map((h, i) => (
          <rect key={i} x={-50 + i * 21} y={40 - h * 80 * (0.4 + 0.6 * on)} width={15} height={h * 80 * (0.4 + 0.6 * on)} fill={i === 1 ? P.amber : P.ice} opacity={0.4 + 0.5 * on} />
        ))}
        <line x1={-56} y1={41} x2={56} y2={41} stroke={P.mist} strokeWidth={2} />
      </g>
    ),
  },
  {
    key: 'text', label: '變回文字', sub: '一個接一個',
    icon: (on) => (
      <g>
        <rect x={-62} y={-40} width={124} height={80} {...stroke(P.paper, on)} />
        {[0, 1, 2].map((i) => (
          <rect key={i} x={-48} y={-22 + i * 18} width={[80, 66, 40][i] * clamp(on * 3 - i)} height={8} fill={P.paper} opacity={0.75} />
        ))}
      </g>
    ),
  },
];

export const Act07: React.FC<ActProps> = ({frame, durationInFrames, anchors}) => {
  const A = (k: string, fb: number) => anchors[k] ?? fb;
  const tWeights = A('weights', 260);
  const tGguf = A('gguf', 420);
  const tLoad = A('load', 560);
  const tTokens = A('tokens', 760);
  const tGpu = A('gpu', 900);
  const tProb = A('prob', 1080);
  const tText = A('text', 1240);
  const tMath = A('math', 1500);
  const tBrand = A('brand', 1800);
  // 每一站的點亮時間（量化在「權重」和「GGUF」之間；向量在 token 和 GPU 之間）
  const on = [tWeights, (tWeights + tGguf) / 2, tGguf, tLoad, tTokens, (tTokens + tGpu) / 2, tGpu, tProb, tText];
  const stationOn = (i: number) => ease.out(progress(frame, on[i] - 8, on[i] + 22));

  // 資料點沿路徑前進（位置 = 已點亮的站，平滑插值）
  let pos = 0;
  for (let i = 0; i < on.length; i++) pos += ease.inOut(progress(frame, on[i] - 26, on[i] + 4)) * (i === 0 ? 0 : 1);
  const dotX = lerp(sx(Math.floor(pos)), sx(Math.min(8, Math.floor(pos) + 1)), pos - Math.floor(pos));
  const dotY = lerp(sy(Math.floor(pos)), sy(Math.min(8, Math.floor(pos) + 1)), pos - Math.floor(pos));

  // 攝影機：先總覽整條管線（「回到一開始的問題」），再跟著資料點；最後推進「文字」站的螢幕
  const overview = {cx: (sx(0) + sx(8)) / 2, cy: Y0 + 20, zoom: 0.54};
  const follow = {cx: dotX + 120, cy: Y0, zoom: 1.12};
  const k = ease.camera(progress(frame, tWeights - 70, tWeights + 10));
  const pushIn = ease.in(progress(frame, tText + 40, tText + 92));
  const cam = {
    cx: lerp(lerp(overview.cx, follow.cx, k), sx(8), pushIn),
    cy: lerp(overview.cy, follow.cy, k),
    zoom: lerp(overview.zoom, follow.zoom, k) * Math.exp(pushIn * Math.log(4.2)),
  };
  const intro = ease.out(progress(frame, 0, 60));

  // B 段：房間
  const deskStart = tText + 78;
  const deskT = frame - deskStart;
  const deskOpacity = progress(frame, deskStart, deskStart + 18);
  const pull = ease.camera(progress(deskT, 0, 200));
  const deskCam = {cx: lerp(1062, 1000, pull), cy: lerp(462, 590, pull), zoom: Math.exp(lerp(Math.log(3.6), Math.log(1.02), pull))};
  const headTurn = ease.inOut(progress(frame, tMath - 70, tMath - 10));
  const replyText = '文字 → token → 向量 → 一層層矩陣運算 → 下一個 token。就這樣一個接一個，直到回答完成。';

  // C 段：品牌
  const brandFrom = tBrand - 12;
  const scrim = progress(frame, brandFrom - 24, brandFrom + 8);

  return (
    <AbsoluteFill style={{background: P.ink, overflow: 'hidden', fontFamily: fontStack}}>
      {frame < deskStart + 20 ? (
        <div style={{position: 'absolute', inset: 0, opacity: intro}}>
          {/* 背景：細網格，隨鏡頭視差移動 */}
          <div style={{position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transformOrigin: '0 0', transform: camTransform(cam, 0.35)}}>
            <svg width={1920} height={1080} style={{overflow: 'visible'}}>
              {Array.from({length: 60}).map((_, i) => (
                <line key={`v${i}`} x1={-1500 + i * 120} y1={-1200} x2={-1500 + i * 120} y2={2300} stroke={P.line} strokeWidth={1} opacity={0.35} />
              ))}
              {Array.from({length: 30}).map((_, i) => (
                <line key={`h${i}`} x1={-1500} y1={-1200 + i * 120} x2={5700} y2={-1200 + i * 120} stroke={P.line} strokeWidth={1} opacity={0.35} />
              ))}
            </svg>
          </div>
          <div style={{position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transformOrigin: '0 0', transform: camTransform(cam)}}>
            <svg width={1920} height={1080} style={{overflow: 'visible'}}>
              {/* 路徑 */}
              <path
                d={STATIONS.map((_, i) => `${i ? 'L' : 'M'} ${sx(i)} ${sy(i)}`).join(' ')}
                stroke={P.line}
                strokeWidth={3}
                fill="none"
              />
              <path
                d={STATIONS.map((_, i) => `${i ? 'L' : 'M'} ${sx(i)} ${sy(i)}`).join(' ')}
                stroke={P.amber}
                strokeWidth={3}
                fill="none"
                strokeDasharray={`${pos * GAP * 1.01} 99999`}
                opacity={0.85}
              />
              {STATIONS.map((s, i) => {
                const o = stationOn(i);
                return (
                  <g key={s.key} transform={`translate(${sx(i)} ${sy(i)})`}>
                    <circle r={86} fill={P.night} stroke={o > 0.01 ? P.amber : P.line} strokeWidth={2} opacity={0.95} />
                    <circle r={86} fill="none" stroke={P.amber} strokeWidth={2} opacity={o * 0.9} strokeDasharray={`${o * 541} 541`} transform="rotate(-90)" />
                    <g transform={`scale(${0.9 + 0.1 * o})`}>{s.icon(o)}</g>
                    <text y={128} textAnchor="middle" fontSize={30} fontWeight={700} fill={P.paper} opacity={0.3 + 0.7 * o} style={{fontFamily: fontStack}}>
                      {s.label}
                    </text>
                    <text y={164} textAnchor="middle" fontSize={21} fill={P.mist} opacity={0.2 + 0.8 * o} style={{fontFamily: fontStack, letterSpacing: '0.06em'}}>
                      {s.sub}
                    </text>
                  </g>
                );
              })}
              {/* 資料點 */}
              <g transform={`translate(${dotX} ${dotY}) rotate(45)`}>
                <rect x={-9} y={-9} width={18} height={18} fill={P.amber} />
              </g>
            </svg>
          </div>
          <div style={{position: 'absolute', left: 120, top: 84, ...type.label, fontSize: 24, color: P.mist, opacity: intro * (1 - k * 0.6)}}>
            回顧：從你按下 Enter，到看見回答
          </div>
        </div>
      ) : null}

      {frame >= deskStart ? (
        <div style={{position: 'absolute', inset: 0, opacity: deskOpacity}}>
          <DeskScene
            frame={deskT + 300}
            override={{
              cam: deskCam,
              typedChars: 99,
              sent: true,
              reply: replyText,
              replyChars: Math.floor(tween(deskT, 10, 230, 8, replyText.length, ease.linear)),
              typing: 0,
              lookUp: 1 - headTurn * 0.6,
              lean: 0.7,
              pose: {headTurn},
              glassSweep: false,
            }}
          />
        </div>
      ) : null}

      <div style={{position: 'absolute', inset: 0, background: P.ink, opacity: scrim, pointerEvents: 'none'}} />
      {frame >= brandFrom ? (
        <BrandCard
          frame={frame - brandFrom}
          duration={Math.max(60, durationInFrames - brandFrom)}
          episode="EP01"
          title="AI 是怎麼在你的電腦上運行的？"
          subtitle="深入理解 llama.cpp"
        />
      ) : null}
      <Vignette />
    </AbsoluteFill>
  );
};
