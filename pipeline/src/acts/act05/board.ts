import * as THREE from 'three';
import {clamp, ease, lerp, progress, rng} from '../../lib/anim';
import {buildCamera, makeRig} from '../../lib/camera3d';
import type {A5} from './timing';

/**
 * 3D 筆電主機板場景的共用幾何、時間與攝影機（純資料、純函式）。
 * 3D 渲染（BoardWorld）與 2D 標註（BoardLabels）、後續 2D 示意圖（FlowScene）共用，確保逐幀貼合。
 * 單位：1 = 10 cm。主機板頂面 y = 0；+z 朝向使用者（前緣），-z 為螢幕轉軸側。
 */
export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const BOARD = {w: 3.4, d: 2.0, t: 0.016};
export const CPU_POS = V(-0.45, 0, -0.25);
export const CPU_SUB = [0.26, 0.022, 0.34] as const;
export const CPU_DIE = [0.13, 0.016, 0.14] as const;
export const GPU_POS = V(0.45, 0, -0.25);
export const GPU_SUB = [0.36, 0.02, 0.36] as const;
export const GPU_DIE = [0.16, 0.02, 0.13] as const;
/** GDDR6 顆粒：僅示意「GPU 周圍的顯示記憶體」，不代表特定配置 */
export const GDDR = [V(0.45, 0, 0.13), V(0.84, 0, -0.13), V(0.84, 0, -0.39)];
export const GDDR_SIZE = [0.14, 0.022, 0.12] as const;
export const DIMMS = [V(-0.86, 0, 0.4), V(-0.86, 0, 0.76)];
export const DIMM_SIZE = [0.7, 0.01, 0.3] as const;
export const DIMM_Y = 0.05;
export const SSD_POS = V(0.86, 0, 0.72);
export const SSD_SIZE = [0.8, 0.008, 0.22] as const;
export const SSD_Y = 0.032;
export const FANS = [V(-1.27, 0, -0.42), V(1.3, 0, -0.42)];
export const FAN_R = 0.3;

// 筆電外殼
export const CASE = {w: 3.8, d: 2.5};
export const HINGE = V(0, 0.155, -1.25);
export const LID_OPEN = THREE.MathUtils.degToRad(106);
export const SCREEN = {w: 3.36, h: 1.89, z: 1.2};

/** 螢幕中心與法線（世界座標），用來把開場鏡頭精確對準螢幕 */
export const screenFrame = () => {
  const m = new THREE.Matrix4().makeRotationX(-LID_OPEN);
  const c = V(0, -0.017, SCREEN.z).applyMatrix4(m).add(HINGE);
  const n = V(0, -1, 0).applyMatrix4(m).normalize();
  return {c, n};
};

// ---------------- 模型層（32 層示意） ----------------
export const N_LAYERS = 32;
export const N_GPU = 20;
export const N_CPU = N_LAYERS - N_GPU;
export const SLAB = [0.5, 0.016, 0.34] as const;
const PITCH = 0.026;
export const COLUMN_POS = V(-0.02, 0.36, 0.36);
export const GPU_STACK = V(0.64, 0.24, -0.24);
export const CPU_STACK = V(-0.86, 0.2, 0.58);

export type Times = ReturnType<typeof boardTimes>;
export const boardTimes = (a: A5) => {
  const nglStart = a.offload + 70;
  const nglEnd = a.gpulayers - 36;
  return {
    xfadeIn: a.laptop - 132,
    xfadeInEnd: a.laptop - 104,
    explodeStart: a.laptop + 24,
    explodeEnd: a.ryzen - 24,
    coolOut: a.ssd - 130,
    coolOutEnd: a.ssd - 50,
    streamStart: a.load - 50,
    streamEnd: a.offload + 10,
    slabRise: a.offload - 50,
    nglStart,
    nglEnd,
    cpuMove: a.cpulayers - 70,
    topDown: a.why + 40,
    xfadeOut: a.why + 40,
    xfadeOutEnd: a.why + 72,
  };
};

/** 第 i 層（0 = 最靠近輸入的層）開始被移到 GPU 的時間；i >= N_CPU 才會被移動 */
export const gpuMoveStart = (T: Times, i: number) => lerp(T.nglStart, T.nglEnd, (N_LAYERS - 1 - i) / (N_GPU - 1));
/** 畫面上 -ngl 的數值（已開始移動的層數） */
export const nglValue = (T: Times, f: number) => {
  let n = 0;
  for (let i = N_CPU; i < N_LAYERS; i++) if (f >= gpuMoveStart(T, i)) n++;
  return n;
};

export const slabState = (T: Times, i: number, f: number) => {
  // 由記憶體升起 → 排成一疊
  const rise = ease.out(progress(f, T.slabRise + i * 1.6, T.slabRise + i * 1.6 + 46));
  const ram = DIMMS[0].clone().lerp(DIMMS[1], 0.5).setY(0.08 + i * 0.002);
  const col = COLUMN_POS.clone().setY(COLUMN_POS.y + i * PITCH);
  const p = ram.clone().lerp(col, rise);
  p.y += Math.sin(rise * Math.PI) * 0.25;
  let dest: THREE.Vector3;
  let mv: number;
  if (i >= N_CPU) {
    const t0 = gpuMoveStart(T, i);
    mv = ease.camera(progress(f, t0, t0 + 44));
    dest = GPU_STACK.clone().setY(GPU_STACK.y + (i - N_CPU) * PITCH);
  } else {
    const t0 = T.cpuMove + (N_CPU - 1 - i) * 3;
    mv = ease.camera(progress(f, t0, t0 + 50));
    dest = CPU_STACK.clone().setY(CPU_STACK.y + i * PITCH);
  }
  const out = p.clone().lerp(dest, mv);
  out.y += Math.sin(mv * Math.PI) * 0.22;
  const s = 0.2 + 0.8 * rise;
  return {pos: out, scale: s, visible: rise > 0.001, moved: mv};
};

// ---------------- 資料流：SSD → CPU（記憶體控制器）→ RAM ----------------
export const STREAM_CURVE = new THREE.CatmullRomCurve3(
  [
    V(SSD_POS.x + 0.05, 0.06, SSD_POS.z),
    V(0.35, 0.22, 0.42),
    V(-0.1, 0.24, -0.05),
    V(CPU_POS.x, 0.12, CPU_POS.z),
    V(-0.62, 0.24, 0.12),
    V(DIMMS[0].x + 0.05, 0.12, 0.58),
  ],
  false,
  'centripetal',
);

// ---------------- 攝影機 ----------------
export const makeBoardRig = (a: A5) => {
  const T = boardTimes(a);
  const {c, n} = screenFrame();
  const d = SCREEN.h / 2 / Math.tan(THREE.MathUtils.degToRad(15));
  const s0 = c.clone().addScaledVector(n, d);
  const final = {pos: V(0.0, 6.4, 0.06), target: V(0, 0, 0), fov: 30};
  const base = makeRig(
    [
      {f: T.xfadeInEnd, pos: s0, target: c, fov: 30},
      {f: a.laptop + 10, pos: V(3.7, 4.3, 7.9), target: V(0, 0.5, -0.3), fov: 30},
      {f: a.ryzen - 30, pos: V(1.6, 4.3, 4.4), target: V(-0.15, 0.1, -0.05), fov: 30},
      {f: a.ryzen + 50, pos: V(-0.05, 2.35, 2.1), target: V(-0.5, 0.05, -0.15), fov: 30},
      {f: a.ram + 40, pos: V(-1.1, 2.1, 2.75), target: V(-0.72, 0.05, 0.45), fov: 30},
      {f: a.rtx + 40, pos: V(1.6, 2.3, 1.9), target: V(0.55, 0.05, -0.15), fov: 30},
      {f: a.rtx + 220, pos: V(1.25, 1.55, 1.25), target: V(0.62, 0.04, -0.15), fov: 30},
      {f: a.ssd - 20, pos: V(1.9, 1.9, 2.75), target: V(0.86, 0.03, 0.62), fov: 30},
      {f: a.load + 40, pos: V(0.45, 3.5, 4.0), target: V(-0.05, 0.1, 0.25), fov: 30},
      {f: a.offload + 70, pos: V(0.6, 2.7, 4.3), target: V(0.0, 0.55, 0.05), fov: 30},
      {f: a.gpulayers + 10, pos: V(1.9, 2.5, 3.7), target: V(0.2, 0.45, -0.05), fov: 30},
      {f: a.cpulayers + 10, pos: V(-0.9, 2.7, 4.0), target: V(-0.15, 0.4, 0.15), fov: 30},
      {f: T.topDown, pos: final.pos, target: final.target, fov: 30},
    ],
    16,
  );
  // 起點與終點以權重混合鎖定：交叉溶接時鏡頭精確對準螢幕／精確俯視（Catmull-Rom 平滑本身在端點會漂移）
  return (f: number) => {
    const b = base(f);
    const w0 = 1 - ease.inOut(progress(f, T.xfadeInEnd, T.xfadeInEnd + 50));
    const w1 = ease.inOut(progress(f, T.topDown - 40, T.topDown));
    const pos = b.pos.clone().lerp(s0, w0).lerp(final.pos, w1);
    const target = b.target.clone().lerp(c, w0).lerp(final.target, w1);
    return {pos, target, fov: b.fov};
  };
};

export type BoardRig = ReturnType<typeof makeBoardRig>;
export const camAt = (rig: BoardRig, f: number) => buildCamera(rig(f));

// ---------------- 小元件（固定種子） ----------------
type Box = {x: number; z: number; w: number; d: number};
const KEEP_OUT: Box[] = [
  {x: CPU_POS.x, z: CPU_POS.z, w: 0.34, d: 0.42},
  {x: GPU_POS.x, z: GPU_POS.z, w: 0.44, d: 0.44},
  ...GDDR.map((g) => ({x: g.x, z: g.z, w: 0.2, d: 0.18})),
  ...DIMMS.map((d) => ({x: d.x, z: d.z, w: 0.78, d: 0.36})),
  {x: SSD_POS.x, z: SSD_POS.z, w: 0.88, d: 0.28},
  ...FANS.map((f) => ({x: f.x, z: f.z, w: 0.66, d: 0.66})),
];
const free = (x: number, z: number) => KEEP_OUT.every((b) => Math.abs(x - b.x) > b.w / 2 || Math.abs(z - b.z) > b.d / 2);

export const SMD = (() => {
  const r = rng(505);
  const out: {x: number; z: number; w: number; d: number; dark: boolean}[] = [];
  let guard = 0;
  while (out.length < 260 && guard++ < 6000) {
    // 偏好放在晶片周圍
    const near = r() < 0.6;
    const base = near ? (r() < 0.5 ? CPU_POS : GPU_POS) : V(0, 0, 0);
    const x = near ? base.x + (r() - 0.5) * 0.8 : (r() - 0.5) * (BOARD.w - 0.12);
    const z = near ? base.z + (r() - 0.5) * 0.8 : (r() - 0.5) * (BOARD.d - 0.12);
    if (Math.abs(x) > BOARD.w / 2 - 0.05 || Math.abs(z) > BOARD.d / 2 - 0.05) continue;
    if (!free(x, z)) continue;
    const big = r() < 0.15;
    const rot = r() < 0.5;
    const w = big ? 0.04 : 0.018;
    const d = big ? 0.03 : 0.01;
    out.push({x, z, w: rot ? d : w, d: rot ? w : d, dark: r() < 0.35});
  }
  return out;
})();

/** 走線：以折線＋平行束表示（銅色、細） */
export const TRACES = (() => {
  const segs: {a: THREE.Vector3; b: THREE.Vector3}[] = [];
  const bundle = (pts: [number, number][], n: number, gap: number) => {
    for (let k = 0; k < n; k++) {
      const o = (k - (n - 1) / 2) * gap;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, z0] = pts[i];
        const [x1, z1] = pts[i + 1];
        const horiz = Math.abs(z1 - z0) < 1e-6;
        segs.push({a: V(x0 + (horiz ? 0 : o), 0.001, z0 + (horiz ? o : 0)), b: V(x1 + (horiz ? 0 : o), 0.001, z1 + (horiz ? o : 0))});
      }
    }
  };
  bundle([[-0.45, -0.06], [-0.45, 0.14], [-0.86, 0.14], [-0.86, 0.24]], 9, 0.016); // CPU → RAM
  bundle([[-0.3, -0.25], [0.24, -0.25]], 8, 0.016); // CPU ↔ GPU（PCIe）
  bundle([[0.45, -0.06], [0.45, 0.06]], 8, 0.014); // GPU → GDDR 前
  bundle([[0.64, -0.13], [0.76, -0.13]], 7, 0.014);
  bundle([[0.64, -0.36], [0.76, -0.36]], 7, 0.014);
  bundle([[-0.36, -0.08], [-0.36, 0.3], [0.38, 0.3], [0.38, 0.72], [0.45, 0.72]], 4, 0.016); // CPU → SSD
  return segs;
})();

export const clamp01 = clamp;
