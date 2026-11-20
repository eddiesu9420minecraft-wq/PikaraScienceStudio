import React from 'react';
import * as THREE from 'three';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {project} from '../../lib/camera3d';
import type {A5} from './timing';
import {MONO, Rect, rectLerp, Schematic, win} from './ui';
import {
  BOARD,
  BoardRig,
  boardTimes,
  camAt,
  CPU_POS,
  CPU_STACK,
  CPU_SUB,
  DIMM_SIZE,
  DIMMS,
  GDDR,
  GDDR_SIZE,
  GPU_POS,
  GPU_STACK,
  GPU_SUB,
  N_CPU,
  N_GPU,
  SLAB,
  SSD_POS,
  SSD_SIZE,
} from './board';

/**
 * 段落 C：3D 俯視 → 2D 示意圖（位置由同一台攝影機投影而來，交叉溶接時重合），
 * 再整理成「RAM ─ CPU」與「GPU ═ VRAM」兩組：平行運算、記憶體頻寬、每個 token 讀完全部權重、瓶頸、類比。
 */
export const LAYOUT = {
  dimmA: {x: 160, y: 270, w: 112, h: 440} as Rect,
  dimmB: {x: 288, y: 270, w: 112, h: 440} as Rect,
  cpu: {x: 700, y: 390, w: 200, h: 200} as Rect,
  gpu: {x: 1090, y: 360, w: 260, h: 260} as Rect,
  vram: [0, 1, 2].map((k) => ({x: 1450, y: 270 + k * 150, w: 240, h: 140}) as Rect),
};
export const VRAM_BOX: Rect = {x: 1450, y: 270, w: 240, h: 440};
export const vramBar = (k: number): Rect => ({x: 1466, y: 700 - (k + 1) * 21 + 4, w: 208, h: 15});
const ramBar = (i: number): Rect => ({x: 176, y: 700 - (i + 1) * 21 + 4, w: 208, h: 15});
const TOKENS = ['天空', '之所以', '是', '藍色', '的', '，'];

const projRect = (cam: THREE.PerspectiveCamera, x: number, z: number, w: number, d: number, y: number): Rect => {
  const a = project(cam, new THREE.Vector3(x - w / 2, y, z - d / 2));
  const b = project(cam, new THREE.Vector3(x + w / 2, y, z + d / 2));
  return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)};
};

export const flowTimes = (a: A5) => {
  const T = boardTimes(a);
  return {
    start: T.xfadeOut,
    morph: a.why + 84,
    morphEnd: a.why + 180,
    cycStart: a.readall - 50,
    cycEnd: a.fast - 20,
    period: 150,
    exit: a.kv - 104,
    exitEnd: a.kv - 58,
  };
};

export const FlowScene: React.FC<{f: number; a: A5; rig: BoardRig}> = ({f, a, rig}) => {
  const FT = flowTimes(a);
  const T = boardTimes(a);
  if (f < FT.start - 1 || f > FT.exitEnd) return null;
  const cam = camAt(rig, T.topDown + 60);
  const inO = progress(f, T.xfadeOut, T.xfadeOutEnd);
  const mph = (d = 0) => ease.camera(progress(f, FT.morph + d, FT.morph + 90 + d));
  const m0 = mph();
  const exitT = ease.inOut(progress(f, FT.exit, FT.exitEnd));

  // 投影後的初始位置
  const pDimm = DIMMS.map((d) => projRect(cam, d.x, d.z, DIMM_SIZE[0], DIMM_SIZE[2], 0.05));
  const pCpu = projRect(cam, CPU_POS.x, CPU_POS.z, CPU_SUB[0], CPU_SUB[2], 0.03);
  const pGpu = projRect(cam, GPU_POS.x, GPU_POS.z, GPU_SUB[0], GPU_SUB[2], 0.03);
  const pGddr = GDDR.map((g, i) => (i === 0 ? projRect(cam, g.x, g.z, GDDR_SIZE[0], GDDR_SIZE[2], 0.02) : projRect(cam, g.x, g.z, GDDR_SIZE[2], GDDR_SIZE[0], 0.02)));
  const pBoard = projRect(cam, 0, 0, BOARD.w, BOARD.d, 0);
  const pSsd = projRect(cam, SSD_POS.x, SSD_POS.z, SSD_SIZE[0], SSD_SIZE[2], 0.03);
  const pGStack = projRect(cam, GPU_STACK.x, GPU_STACK.z, SLAB[0], SLAB[2], GPU_STACK.y + (N_GPU - 1) * 0.026);
  const pCStack = projRect(cam, CPU_STACK.x, CPU_STACK.z, SLAB[0], SLAB[2], CPU_STACK.y + (N_CPU - 1) * 0.026);

  const dimmA = rectLerp(pDimm[0], LAYOUT.dimmA, m0);
  const dimmB = rectLerp(pDimm[1], LAYOUT.dimmB, m0);
  const cpu = rectLerp(pCpu, LAYOUT.cpu, mph(6));
  const gpu = rectLerp(pGpu, LAYOUT.gpu, mph(6));
  const vram = pGddr.map((r, k) => rectLerp(r, LAYOUT.vram[k], mph(10 + k * 6)));
  const boardO = 1 - progress(f, FT.morph, FT.morph + 50);

  // 事件
  const parT = win(f, a.parallel - 30, a.parallel + 10, a.bandwidth - 10, a.bandwidth + 20);
  const flowOn = progress(f, a.bandwidth - 24, a.bandwidth + 20);
  const bwTitle = win(f, a.bandwidth - 10, a.bandwidth + 24, a.readall - 90, a.readall - 56);
  const readCap = win(f, a.readall - 10, a.readall + 20, a.bottleneck - 30, a.bottleneck - 5);
  const bn = win(f, a.bottleneck - 18, a.bottleneck + 16, a.fast - 30, a.fast);
  const fastT = win(f, a.fast - 20, a.fast + 20, FT.exit - 10, FT.exit + 20);
  const an = progress(f, a.analogy - 36, a.analogy + 50);

  // token 週期
  const inCyc = f >= FT.cycStart && f < FT.cycEnd + FT.period;
  const cyc = (f - FT.cycStart) / FT.period;
  const ci = Math.floor(cyc);
  const u = cyc - ci;
  const cycActive = inCyc && f < FT.cycEnd + 0 && cyc >= 0;
  const cycO = progress(f, FT.cycStart, FT.cycStart + 20) * (1 - progress(f, FT.cycEnd - 20, FT.cycEnd + 10));
  const tokensDone = clamp(Math.floor(cyc + 0.08), 0, TOKENS.length);
  const ramPhase = cycActive && u < 0.56 ? 1 : 0;
  const vramPhase = cycActive && u > 0.6 && u < 0.9 ? 1 : 0;

  const ramActive = (i: number) => (cycActive ? Math.max(0, 1 - Math.abs(u - (0.05 + i * 0.042)) / 0.045) : 0);
  const vramActive = (k: number) => (cycActive ? Math.max(0, 1 - Math.abs(u - (0.62 + k * 0.0135)) / 0.02) : 0);

  const leftShift = -exitT * 520;
  const leftO = 1 - exitT;

  return (
    <div style={{position: 'absolute', inset: 0, opacity: inO}}>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <radialGradient id="a5flow-bg" cx="0.5" cy="0.45" r="0.6">
            <stop offset="0" stopColor="#1C2740" stopOpacity={0.5} />
            <stop offset="1" stopColor="#090D18" stopOpacity={0} />
          </radialGradient>
        </defs>
        <rect width={1920} height={1080} fill={P.ink} />
        <rect width={1920} height={1080} fill="url(#a5flow-bg)" />
        {/* 主機板（俯視投影，逐漸淡出） */}
        {boardO > 0 ? (
          <g opacity={boardO}>
            <rect {...rr(pBoard)} rx={14} fill="#163A30" />
            <rect {...rr(pSsd)} rx={4} fill="#1A2A3E" />
          </g>
        ) : null}

        {/* 類比：建築輪廓 */}
        {an > 0 ? <Buildings an={an} leftShift={leftShift} leftO={leftO} /> : null}

        {/* 左側：RAM + CPU */}
        <g transform={`translate(${leftShift} 0)`} opacity={leftO}>
          <Dimm r={dimmA} />
          <Dimm r={dimmB} />
          {/* RAM → CPU 細長管道 */}
          <Pipe x0={LAYOUT.dimmB.x + LAYOUT.dimmB.w} x1={LAYOUT.cpu.x} y={490} h={10} lanes={1} f={f} on={flowOn * m0} hot={ramPhase} bn={bn} dir={1} gap={64} />
          <Chip r={cpu} kind="cpu" f={f} par={parT} work={ramPhase} dim={bn} />
          {/* RAM 中的 12 層 */}
          {Array.from({length: N_CPU}).map((_, i) => {
            const r = rectLerp(pCStack, ramBar(i), mph(14 + i * 3));
            const act = ramActive(i);
            return <rect key={i} {...rr(r)} rx={3} fill={act > 0 ? mixHex(P.amberDeep, '#FFF2D6', act) : P.amberDeep} opacity={0.95} />;
          })}
        </g>

        {/* 右側：GPU + VRAM */}
        {vram.map((r, k) => (
          <rect key={k} {...rr(r)} rx={6} fill="#14171F" stroke={P.ice} strokeOpacity={0.45 * m0} strokeWidth={2} />
        ))}
        <Pipe x0={LAYOUT.gpu.x + LAYOUT.gpu.w} x1={LAYOUT.vram[0].x} y={490} h={220} lanes={11} f={f} on={flowOn * m0} hot={vramPhase} bn={bn} dir={-1} gap={22} fast={fastT} />
        <Chip r={gpu} kind="gpu" f={f} par={parT} work={vramPhase} dim={bn} />
        {Array.from({length: N_GPU}).map((_, k) => {
          const r = rectLerp(pGStack, vramBar(k), mph(14 + k * 2));
          const act = vramActive(k);
          return <rect key={k} {...rr(r)} rx={3} fill={act > 0 ? mixHex(P.amberDeep, '#FFF2D6', act) : P.amberDeep} opacity={0.95} />;
        })}

        {/* 激活值：CPU → GPU */}
        {cycActive && u > 0.54 && u < 0.64 ? (
          (() => {
            const t = ease.inOut(progress(u, 0.55, 0.62));
            const x = lerp(LAYOUT.cpu.x + LAYOUT.cpu.w, LAYOUT.gpu.x, t);
            const y = 490 - Math.sin(t * Math.PI) * 120;
            return <circle cx={x} cy={y} r={9} fill={P.ice} opacity={0.95} />;
          })()
        ) : null}
        {/* 新 token 從 GPU 飛到上方的列 */}
        {cycActive && u > 0.88 ? (
          (() => {
            const t = ease.out(progress(u, 0.88, 1));
            const slot = tokenSlot(ci);
            const x = lerp(LAYOUT.gpu.x + LAYOUT.gpu.w / 2, slot.x, t);
            const y = lerp(LAYOUT.gpu.y, slot.y, t);
            return <circle cx={x} cy={y} r={10 * (1 - t) + 2} fill={P.paper} />;
          })()
        ) : null}
      </svg>

      {/* 標籤（HTML 文字） */}
      <Label x={(LAYOUT.dimmA.x + LAYOUT.dimmB.x + LAYOUT.dimmB.w) / 2 + leftShift} y={LAYOUT.dimmA.y - 50} text="RAM" color={P.amber} o={progress(f, FT.morph + 60, FT.morph + 100) * leftO} />
      <Label x={LAYOUT.cpu.x + LAYOUT.cpu.w / 2 + leftShift} y={LAYOUT.cpu.y - 50} text="CPU" color={P.amber} o={progress(f, FT.morph + 60, FT.morph + 100) * leftO} />
      <Label x={LAYOUT.gpu.x + LAYOUT.gpu.w / 2} y={LAYOUT.gpu.y - 50} text="GPU" color={P.ice} o={progress(f, FT.morph + 60, FT.morph + 100)} />
      <Label x={LAYOUT.vram[0].x + 120} y={LAYOUT.vram[0].y - 50} text="VRAM" color={P.ice} o={progress(f, FT.morph + 60, FT.morph + 100)} />
      <Caption x={LAYOUT.cpu.x + LAYOUT.cpu.w / 2} y={LAYOUT.cpu.y + LAYOUT.cpu.h + 26} text="少數強大核心" o={parT} />
      <Caption x={LAYOUT.gpu.x + LAYOUT.gpu.w / 2} y={LAYOUT.gpu.y + LAYOUT.gpu.h + 26} text="大量核心同時乘加" o={parT} />

      {bwTitle > 0 ? (
        <div style={{position: 'absolute', left: 0, width: 1920, top: 118, textAlign: 'center', opacity: bwTitle, transform: `translateY(${(1 - bwTitle) * 10}px)`}}>
          <div style={{...type.title, fontSize: 52, color: P.paper}}>記憶體頻寬</div>
          <div style={{...type.label, fontSize: 24, color: P.mist, marginTop: 8}}>記憶體和處理器之間，每秒能搬多少資料</div>
        </div>
      ) : null}

      {/* token 列 */}
      {cycO > 0 || tokensDone > 0
        ? TOKENS.map((tk, i) => {
            const slot = tokenSlot(i);
            const o = i < tokensDone ? 1 : 0;
            const glow = i === tokensDone - 1 ? 1 - progress(f, FT.cycStart + (i + 1) * FT.period - 10, FT.cycStart + (i + 1) * FT.period + 40) : 0;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: slot.x - 60,
                  top: slot.y - 26,
                  width: 120,
                  height: 52,
                  textAlign: 'center',
                  lineHeight: '50px',
                  ...type.title,
                  fontSize: 30,
                  color: P.paper,
                  borderBottom: `2px solid ${glow > 0.05 ? P.ice : P.line}`,
                  opacity: o * (1 - progress(f, a.analogy - 50, a.analogy - 20)) * progress(f, FT.cycStart, FT.cycStart + 10),
                }}
              >
                {tk}
              </div>
            );
          })
        : null}
      <Caption x={960} y={790} text="每生成一個 token，所有層的權重都要讀一遍" o={readCap} size={30} color={P.paper} />
      <Caption x={960} y={790} text="瓶頸在「搬」，不在「算」" o={bn} size={34} color={P.amber} />
      {an > 0 ? (
        <>
          <Caption x={1400} y={632} text="隔壁" o={progress(an, 0.5, 1) * (1 - exitT)} size={30} color={P.ice} />
          <Caption x={550 + leftShift} y={540} text="另一棟樓" o={progress(an, 0.5, 1) * leftO} size={30} color={P.amber} />
        </>
      ) : null}
      <Schematic o={progress(f, FT.morph + 40, FT.morph + 80)} />
    </div>
  );
};

export const tokenSlot = (i: number) => ({x: 960 + (i - (TOKENS.length - 1) / 2) * 136, y: 132});

const rr = (r: Rect) => ({x: r.x, y: r.y, width: Math.max(0, r.w), height: Math.max(0, r.h)});

const mixHex = (a: string, b: string, t: number) => {
  const c = new THREE.Color(a).lerp(new THREE.Color(b), clamp(t));
  return '#' + c.getHexString();
};

const Label: React.FC<{x: number; y: number; text: string; color: string; o: number}> = ({x, y, text, color, o}) =>
  o > 0.001 ? (
    <div style={{position: 'absolute', left: x - 150, width: 300, top: y - 10, textAlign: 'center', fontFamily: MONO, fontWeight: 700, fontSize: 30, color, opacity: o}}>{text}</div>
  ) : null;

export const Caption: React.FC<{x: number; y: number; text: string; o: number; size?: number; color?: string}> = ({x, y, text, o, size = 24, color = P.mist}) =>
  o > 0.001 ? (
    <div
      style={{
        position: 'absolute',
        left: x - 500,
        width: 1000,
        top: y,
        textAlign: 'center',
        ...type.label,
        fontFamily: fontStack,
        fontSize: size,
        color,
        opacity: o,
        transform: `translateY(${(1 - o) * 8}px)`,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  ) : null;

const Dimm: React.FC<{r: Rect}> = ({r}) => (
  <g>
    <rect {...rr(r)} rx={5} fill="#1C5442" />
    {[0, 1, 2, 3].map((k) => {
      // 顆粒沿長邊排列（投影時長邊為水平，排版後為垂直）
      const vertical = r.h > r.w;
      const cw = vertical ? r.w * 0.62 : r.w * 0.17;
      const ch = vertical ? r.h * 0.17 : r.h * 0.4;
      const x = vertical ? r.x + (r.w - cw) / 2 : r.x + r.w * (0.1 + k * 0.215);
      const y = vertical ? r.y + r.h * (0.06 + k * 0.235) : r.y + r.h * 0.4;
      return <rect key={k} x={x} y={y} width={cw} height={ch} rx={2} fill="#17191F" opacity={0.85} />;
    })}
  </g>
);

const Chip: React.FC<{r: Rect; kind: 'cpu' | 'gpu'; f: number; par: number; work: number; dim: number}> = ({r, kind, f, par, work, dim}) => {
  const color = kind === 'cpu' ? P.amber : P.ice;
  const inset = r.w * 0.14;
  const die = {x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2};
  const cols = kind === 'cpu' ? 4 : 12;
  const rows = kind === 'cpu' ? 2 : 12;
  const gap = kind === 'cpu' ? 8 : 3;
  const cw = (die.w - gap * (cols + 1)) / cols;
  const ch = (die.h - gap * (rows + 1)) / rows;
  const cells = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      let lit = 0;
      if (kind === 'cpu') {
        const k = i * cols + j;
        lit = par * Math.max(0, Math.sin(f * 0.09 - k * 0.8)) ** 3 + work * 0.6 * Math.max(0, Math.sin(f * 0.3 + k));
      } else {
        const wave = Math.sin(f * 0.12 - (i + j) * 0.18);
        lit = par * (0.45 + 0.55 * Math.max(0, wave)) + work * 0.75;
      }
      lit *= 1 - 0.65 * dim;
      cells.push(
        <rect
          key={i * cols + j}
          x={die.x + gap + j * (cw + gap)}
          y={die.y + gap + i * (ch + gap)}
          width={Math.max(0, cw)}
          height={Math.max(0, ch)}
          rx={kind === 'cpu' ? 4 : 1}
          fill={color}
          opacity={0.14 + 0.8 * clamp(lit)}
        />,
      );
    }
  return (
    <g>
      <rect {...rr(r)} rx={8} fill="#24463A" stroke={color} strokeOpacity={0.5} strokeWidth={2} />
      <rect {...rr(die)} rx={4} fill="#28324A" />
      {cells}
    </g>
  );
};

/** 管道：lanes 條平行車道；資料塊以固定速度流動（寬管道＝同時搬更多） */
const Pipe: React.FC<{x0: number; x1: number; y: number; h: number; lanes: number; f: number; on: number; hot: number; bn: number; dir: 1 | -1; gap: number; fast?: number}> = ({
  x0,
  x1,
  y,
  h,
  lanes,
  f,
  on,
  hot,
  bn,
  dir,
  gap,
  fast = 0,
}) => {
  if (on <= 0.001) return null;
  const L = x1 - x0;
  const lanesEls = [];
  const speed = 2.2;
  for (let l = 0; l < lanes; l++) {
    const ly = lanes === 1 ? y : y - h / 2 + (h / lanes) * (l + 0.5);
    const n = Math.ceil(L / gap) + 1;
    for (let k = 0; k < n; k++) {
      let px = ((k * gap + f * speed + l * 7) % (n * gap)) - gap;
      if (px < 0 || px > L - 10) continue;
      if (dir < 0) px = L - px - 10;
      lanesEls.push(<rect key={l * 1000 + k} x={x0 + px} y={ly - 3} width={10} height={6} rx={2} fill={P.amber} opacity={on * (0.45 + 0.5 * hot)} />);
    }
  }
  const pulse = 0.5 + 0.5 * Math.sin(f * 0.18);
  return (
    <g>
      <rect x={x0} y={y - h / 2 - 6} width={L} height={h + 12} rx={Math.min(8, h / 2 + 6)} fill="#1A2236" opacity={on} />
      {lanesEls}
      {bn > 0 ? <rect x={x0 - 4} y={y - h / 2 - 10} width={L + 8} height={h + 20} rx={10} fill="none" stroke={P.amber} strokeWidth={3} opacity={bn * (0.5 + 0.5 * pulse)} /> : null}
      {fast > 0 ? <rect x={x0 - 4} y={y - h / 2 - 10} width={L + 8} height={h + 20} rx={10} fill="none" stroke={P.ice} strokeWidth={3} opacity={fast * 0.8} /> : null}
    </g>
  );
};

/** 類比：GPU 與 VRAM 在同一棟樓的隔壁房；CPU 與 RAM 分在兩棟樓 */
const Buildings: React.FC<{an: number; leftShift: number; leftO: number}> = ({an, leftShift, leftO}) => {
  const house = (x: number, y: number, w: number, h: number, roof: number) =>
    `M ${x} ${y + h} L ${x} ${y} L ${x + w / 2} ${y - roof} L ${x + w} ${y} L ${x + w} ${y + h} Z`;
  const draw = (len: number) => ({strokeDasharray: `${len * an} ${len}`});
  return (
    <g fill="none" strokeWidth={2.5} strokeLinejoin="round">
      <g transform={`translate(${leftShift} 0)`} opacity={leftO}>
        <path d={house(130, 236, 300, 500, 70)} stroke={P.amber} strokeOpacity={0.7} style={draw(1800)} />
        <path d={house(664, 360, 272, 270, 60)} stroke={P.amber} strokeOpacity={0.7} style={draw(1300)} />
        <line x1={430} y1={530} x2={664} y2={530} stroke={P.mist} strokeOpacity={0.5 * an} strokeDasharray="14 12" />
      </g>
      <path d={house(1060, 236, 660, 500, 96)} stroke={P.ice} strokeOpacity={0.7} style={draw(2800)} />
      <line x1={1400} y1={236} x2={1400} y2={366} stroke={P.ice} strokeOpacity={0.6 * an} />
    </g>
  );
};
