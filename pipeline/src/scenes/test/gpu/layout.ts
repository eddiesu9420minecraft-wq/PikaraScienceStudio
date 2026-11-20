import {rng} from '../../../lib/anim';
import {DIE_POS, DIE_TOP, VRAM_OFFSETS} from '../gpuRig';

/**
 * 顯示卡元件佈局（卡片本地座標，單位 1 = 10 cm）。
 * PCB 貼圖（絲印外框、走線）與 3D 元件共用同一份資料，確保兩者對齊。
 */
export const PCB_W = 3.0;
export const PCB_D = 1.15;
export const PCB_T = 0.04; // PCB 盒高（y: -0.02..0.02）
export const PCB_TOP = PCB_T / 2;

// GPU 封裝
export const SUB_SIZE = 0.48; // 有機基板
export const SUB_TOP = 0.041;
export const DIE_SIZE = 0.31; // 晶粒（矩陣格 + x 列 + y 行都在晶粒範圍內）
export const DIE_BASE = SUB_TOP;
export const DIE_H = DIE_TOP - DIE_BASE;
export const STIFF_IN = 0.205; // 加強框（半寬）
export const STIFF_OUT = 0.235;

// VRAM（GDDR 14×12 mm）
export const VRAM_W = 0.14;
export const VRAM_D = 0.12;
export const VRAM_H = 0.012;
export const VRAM = VRAM_OFFSETS.map(([dx, dz]) => ({x: DIE_POS.x + dx, z: DIE_POS.z + dz, dx, dz}));

// 散熱器鎖孔（GPU 四周）
export const MOUNT_HOLES: [number, number][] = [
  [DIE_POS.x - 0.29, DIE_POS.z - 0.29],
  [DIE_POS.x + 0.29, DIE_POS.z - 0.29],
  [DIE_POS.x - 0.29, DIE_POS.z + 0.29],
  [DIE_POS.x + 0.29, DIE_POS.z + 0.29],
];

// 供電：Power stage（DrMOS）、電感、固態電容
export const POWER_STAGES = Array.from({length: 10}, (_, i) => ({x: 0.42 + i * 0.095, z: -0.4}));
export const CHOKES = Array.from({length: 10}, (_, i) => ({x: 0.42 + i * 0.095, z: -0.27}));
export const CAPS = [
  ...Array.from({length: 7}, (_, i) => ({x: 0.46 + i * 0.13, z: -0.11, r: 0.032, h: 0.07})),
  ...Array.from({length: 3}, (_, i) => ({x: 0.62 + i * 0.12, z: 0.32, r: 0.032, h: 0.07})),
];
export const MEM_CHOKES = [
  {x: 0.5, z: 0.1},
  {x: 0.6, z: 0.1},
  {x: 0.5, z: 0.2},
];
export const CONTROLLER = {x: 0.78, z: 0.12, w: 0.07, d: 0.07}; // PWM 控制器（QFN）
export const BIOS = {x: 1.05, z: 0.18, w: 0.06, d: 0.035};
export const POWER_CONN = {x: 1.18, z: -0.5, w: 0.2, d: 0.1, h: 0.085}; // 12V-2x6 電源接頭
export const DISPLAY_PORTS = [-0.36, -0.12, 0.12, 0.36]; // I/O 端子（z 位置）

// PCIe 金手指（+z 邊外突的板舌）
export const PCIE = {x0: -1.08, x1: -0.04, z0: PCB_D / 2, z1: PCB_D / 2 + 0.09, notchX: -0.86};

type Rect = [number, number, number, number]; // x0,z0,x1,z1
const keepOut: Rect[] = [
  [DIE_POS.x - 0.27, DIE_POS.z - 0.27, DIE_POS.x + 0.27, DIE_POS.z + 0.27],
  ...VRAM.map((v): Rect => [v.x - 0.09, v.z - 0.075, v.x + 0.09, v.z + 0.075]),
  [0.35, -0.47, 1.4, -0.06],
  [0.43, 0.04, 0.85, 0.37],
  [-1.5, -0.56, -1.3, 0.56],
  [POWER_CONN.x - 0.13, -0.58, POWER_CONN.x + 0.13, -0.42],
  [BIOS.x - 0.05, BIOS.z - 0.04, BIOS.x + 0.05, BIOS.z + 0.04],
  ...MOUNT_HOLES.map(([x, z]): Rect => [x - 0.035, z - 0.035, x + 0.035, z + 0.035]),
];
const free = (x: number, z: number) => !keepOut.some(([a, b, c, d]) => x > a && x < c && z > b && z < d);

/** 表面黏著被動元件（0402/0603）：成群分布在晶片、VRAM 與供電周圍。 */
export type Passive = {x: number; z: number; rot: number; l: number; w: number; tone: number};
export const PASSIVES: Passive[] = (() => {
  const r = rng(77031);
  const out: Passive[] = [];
  const cluster = (cx: number, cz: number, spreadX: number, spreadZ: number, n: number, vertical: boolean) => {
    let tries = 0;
    let made = 0;
    while (made < n && tries < n * 30) {
      tries++;
      const gx = Math.round(((r() - 0.5) * spreadX) / 0.022) * 0.022;
      const gz = Math.round(((r() - 0.5) * spreadZ) / 0.016) * 0.016;
      const x = cx + gx;
      const z = cz + gz;
      if (Math.abs(x) > 1.46 || Math.abs(z) > 0.54 || !free(x, z)) continue;
      if (out.some((p) => Math.abs(p.x - x) < 0.019 && Math.abs(p.z - z) < 0.014)) continue;
      const big = r() < 0.3;
      out.push({x, z, rot: vertical ? Math.PI / 2 : 0, l: big ? 0.016 : 0.011, w: big ? 0.008 : 0.0055, tone: r()});
      made++;
    }
  };
  // 晶片背側去耦電容群（封裝四周）
  cluster(DIE_POS.x, DIE_POS.z - 0.31, 0.5, 0.05, 18, false);
  cluster(DIE_POS.x, DIE_POS.z + 0.31, 0.5, 0.05, 18, false);
  cluster(DIE_POS.x - 0.31, DIE_POS.z, 0.05, 0.5, 16, true);
  cluster(DIE_POS.x + 0.31, DIE_POS.z, 0.05, 0.5, 16, true);
  // VRAM 旁
  for (const v of VRAM) cluster(v.x + Math.sign(v.dx || 1) * 0.11, v.z, 0.04, 0.14, 6, true);
  // 供電區
  cluster(0.88, -0.02, 1.0, 0.07, 30, false);
  cluster(1.18, 0.15, 0.4, 0.5, 34, false);
  cluster(-1.1, 0.0, 0.25, 0.9, 30, true);
  cluster(-0.3, 0.46, 1.4, 0.07, 26, false);
  return out;
})();
