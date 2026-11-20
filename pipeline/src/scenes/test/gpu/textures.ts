import * as THREE from 'three';
import {rng} from '../../../lib/anim';
import {DIE_POS, GRID_N, GRID_PITCH} from '../gpuRig';
import {
  BIOS,
  CAPS,
  CHOKES,
  CONTROLLER,
  DIE_SIZE,
  DISPLAY_PORTS,
  MEM_CHOKES,
  MOUNT_HOLES,
  PCB_D,
  PCB_W,
  PCIE,
  POWER_CONN,
  POWER_STAGES,
  SUB_SIZE,
  VRAM,
  VRAM_D,
  VRAM_W,
} from './layout';

/**
 * 程序化貼圖（CanvasTexture），全部以固定種子生成，逐幀一致。
 * 模組層級快取：同一頁面只生成一次。
 */
const cache = new Map<string, unknown>();
const once = <T,>(key: string, make: () => T): T => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
};

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

const tex = (c: HTMLCanvasElement, srgb: boolean, aniso = 8) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
};

// ---------------- PCB ----------------

type Mode = 'albedo' | 'rough' | 'bump' | 'metal';
type Ink = Record<Mode, string>;
const INK = {
  mask: {albedo: '#0E271F', rough: '#7A7A7A', bump: '#000000', metal: '#000000'},
  plane: {albedo: '#112C23', rough: '#747474', bump: '#1A1A1A', metal: '#000000'},
  trace: {albedo: '#163A2D', rough: '#5E5E5E', bump: '#707070', metal: '#000000'},
  traceHi: {albedo: '#1C4637', rough: '#585858', bump: '#808080', metal: '#000000'},
  via: {albedo: '#22493B', rough: '#606060', bump: '#909090', metal: '#000000'},
  gold: {albedo: '#CFA65A', rough: '#3A3A3A', bump: '#6A6A6A', metal: '#FFFFFF'},
  tin: {albedo: '#A9AEB3', rough: '#4A4A4A', bump: '#6A6A6A', metal: '#FFFFFF'},
  silk: {albedo: '#C9D2CE', rough: '#B8B8B8', bump: '#383838', metal: '#000000'},
  hole: {albedo: '#04070A', rough: '#E6E6E6', bump: '#000000', metal: '#000000'},
  label: {albedo: '#E8ECEA', rough: '#D0D0D0', bump: '#202020', metal: '#000000'},
  dark: {albedo: '#16191C', rough: '#909090', bump: '#202020', metal: '#000000'},
} satisfies Record<string, Ink>;

export const PCB_TEX_W = 4096;
export const PCB_TEX_H = Math.round((PCB_TEX_W * PCB_D) / PCB_W);
const S = PCB_TEX_W / PCB_W; // px / unit
const X = (x: number) => (x + PCB_W / 2) * S;
const Z = (z: number) => (z + PCB_D / 2) * S;

const drawPcb = (g: CanvasRenderingContext2D, mode: Mode) => {
  const r = rng(51207);
  const col = (k: keyof typeof INK) => INK[k][mode];
  g.fillStyle = col('mask');
  g.fillRect(0, 0, PCB_TEX_W, PCB_TEX_H);

  // 防焊層的細微色差（大尺度柔和斑）
  if (mode === 'albedo' || mode === 'rough') {
    for (let i = 0; i < 60; i++) {
      const cx = r() * PCB_TEX_W;
      const cy = r() * PCB_TEX_H;
      const rad = 120 + r() * 420;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      const a = 0.05 + r() * 0.05;
      const light = r() > 0.5;
      grd.addColorStop(0, mode === 'albedo' ? (light ? `rgba(40,80,64,${a})` : `rgba(0,0,0,${a})`) : light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
  }

  // 銅箔大面積（電源層，透過防焊層隱約可見）
  g.fillStyle = col('plane');
  const plane = (x0: number, z0: number, x1: number, z1: number) => {
    g.beginPath();
    g.roundRect(X(x0), Z(z0), (x1 - x0) * S, (z1 - z0) * S, 18);
    g.fill();
  };
  plane(0.34, -0.5, 1.42, -0.05);
  plane(0.42, 0.02, 0.9, 0.4);
  plane(-1.46, -0.52, -1.0, 0.52);

  // 一般走線：水平/垂直 + 45° 轉折
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < 520; i++) {
    let x = X((r() - 0.5) * PCB_W * 0.96);
    let y = Z((r() - 0.5) * PCB_D * 0.94);
    const w = r() < 0.15 ? 5 : 2.4;
    g.lineWidth = w;
    g.strokeStyle = col('trace');
    g.beginPath();
    g.moveTo(x, y);
    const segs = 2 + Math.floor(r() * 3);
    let dir = Math.floor(r() * 4) * (Math.PI / 2);
    for (let s = 0; s < segs; s++) {
      const len = 30 + r() * 220;
      x += Math.cos(dir) * len;
      y += Math.sin(dir) * len;
      g.lineTo(x, y);
      dir += (r() < 0.5 ? -1 : 1) * (Math.PI / 4);
    }
    g.stroke();
    // 走線端點的過孔
    g.fillStyle = col('via');
    g.beginPath();
    g.arc(x, y, 5.5, 0, Math.PI * 2);
    g.fill();
  }

  // 平行匯流排：成組的走線（像記憶體/PCIe 匯流排）
  const bus = (x0: number, z0: number, x1: number, z1: number, n: number, pitch: number, hi = false) => {
    const ang = Math.atan2(z1 - z0, x1 - x0);
    const nx = -Math.sin(ang);
    const nz = Math.cos(ang);
    g.strokeStyle = col(hi ? 'traceHi' : 'trace');
    g.lineWidth = 2.6;
    for (let k = 0; k < n; k++) {
      const o = (k - (n - 1) / 2) * pitch;
      g.beginPath();
      g.moveTo(X(x0 + nx * o), Z(z0 + nz * o));
      g.lineTo(X(x1 + nx * o), Z(z1 + nz * o));
      g.stroke();
    }
  };
  // VRAM → GPU（與 3D 資料脈衝同一路徑）
  for (const v of VRAM) {
    const len = Math.hypot(v.dx, v.dz);
    const ux = -v.dx / len;
    const uz = -v.dz / len;
    bus(v.x + ux * 0.05, v.z + uz * 0.05, DIE_POS.x + v.dx * 0.3, DIE_POS.z + v.dz * 0.3, 15, 0.0062);
    bus(v.x + ux * 0.05, v.z + uz * 0.05, DIE_POS.x + v.dx * 0.3, DIE_POS.z + v.dz * 0.3, 3, 0.025, true);
  }
  // PCIe 匯流排：金手指 → GPU
  for (let k = 0; k < 8; k++) {
    const x = PCIE.x0 + 0.08 + k * 0.1;
    g.strokeStyle = col('trace');
    g.lineWidth = 2.4;
    for (let t = 0; t < 4; t++) {
      const xx = X(x + t * 0.008);
      g.beginPath();
      g.moveTo(xx, Z(0.57));
      g.lineTo(xx, Z(0.42 - k * 0.006));
      g.lineTo(X(DIE_POS.x - 0.2 + k * 0.05 + t * 0.008), Z(0.24));
      g.stroke();
    }
  }

  // 過孔散布 + 板邊過孔牆
  g.fillStyle = col('via');
  for (let i = 0; i < 1600; i++) {
    const x = r() * PCB_TEX_W;
    const y = r() * PCB_TEX_H;
    g.beginPath();
    g.arc(x, y, 3.2 + r() * 2.5, 0, Math.PI * 2);
    g.fill();
  }
  for (let x = 40; x < PCB_TEX_W - 40; x += 34) {
    for (const y of [26, PCB_TEX_H - 26]) {
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 封裝下方的過孔陣列（BGA 扇出）
  const half = (SUB_SIZE / 2 + 0.02) * S;
  for (let gx = -half; gx <= half; gx += 16) {
    for (let gy = -half; gy <= half; gy += 16) {
      if (Math.abs(gx) < half - 70 && Math.abs(gy) < half - 70) continue;
      g.beginPath();
      g.arc(X(DIE_POS.x) + gx, Z(DIE_POS.z) + gy, 3.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  // 絲印外框 + 位號
  g.strokeStyle = col('silk');
  g.fillStyle = col('silk');
  g.lineWidth = 3;
  const outline = (x: number, z: number, w: number, d: number, pin1 = true) => {
    g.strokeRect(X(x - w / 2), Z(z - d / 2), w * S, d * S);
    if (pin1) {
      g.beginPath();
      g.arc(X(x - w / 2) - 10, Z(z - d / 2) - 10, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  };
  const label = (s: string, x: number, z: number, size = 22, align: CanvasTextAlign = 'center') => {
    g.font = `600 ${size}px Consolas, "Courier New", monospace`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(s, X(x), Z(z));
  };
  // GPU 封裝外框（角落三角標記）
  const so = SUB_SIZE / 2 + 0.012;
  g.strokeRect(X(DIE_POS.x - so), Z(DIE_POS.z - so), so * 2 * S, so * 2 * S);
  g.beginPath();
  g.moveTo(X(DIE_POS.x - so), Z(DIE_POS.z - so));
  g.lineTo(X(DIE_POS.x - so) + 34, Z(DIE_POS.z - so));
  g.lineTo(X(DIE_POS.x - so), Z(DIE_POS.z - so) + 34);
  g.closePath();
  g.fill();
  label('U1', DIE_POS.x - so + 0.03, DIE_POS.z + so + 0.022);
  VRAM.forEach((v, i) => {
    outline(v.x, v.z, VRAM_W + 0.012, VRAM_D + 0.012);
    label(`M${i + 1}`, v.x + VRAM_W / 2 - 0.012, v.z + VRAM_D / 2 + 0.02, 20);
  });
  POWER_STAGES.forEach((p, i) => {
    outline(p.x, p.z, 0.066, 0.056, false);
    label(`Q${i + 1}`, p.x, p.z - 0.047, 17);
  });
  CHOKES.forEach((p, i) => {
    outline(p.x, p.z, 0.084, 0.084, false);
    if (i % 2 === 0) label(`L${i + 1}`, p.x + 0.045, p.z + 0.058, 17);
  });
  MEM_CHOKES.forEach((p) => outline(p.x, p.z, 0.084, 0.084, false));
  for (const c of CAPS) {
    g.beginPath();
    g.arc(X(c.x), Z(c.z), (c.r + 0.006) * S, 0, Math.PI * 2);
    g.stroke();
    // 極性標記（半圓斜線）
    g.save();
    g.beginPath();
    g.arc(X(c.x), Z(c.z), (c.r + 0.006) * S, Math.PI * 0.5, Math.PI * 1.5);
    g.clip();
    for (let k = -60; k < 60; k += 10) {
      g.beginPath();
      g.moveTo(X(c.x) + k, Z(c.z) - 60);
      g.lineTo(X(c.x) + k - 60, Z(c.z) + 60);
      g.stroke();
    }
    g.restore();
  }
  outline(CONTROLLER.x, CONTROLLER.z, CONTROLLER.w + 0.01, CONTROLLER.d + 0.01);
  outline(BIOS.x, BIOS.z, BIOS.w + 0.01, BIOS.d + 0.01);
  label('BIOS', BIOS.x, BIOS.z + 0.04, 18);
  outline(POWER_CONN.x, POWER_CONN.z + 0.01, POWER_CONN.w + 0.012, POWER_CONN.d + 0.012, false);
  label('12V-2x6', POWER_CONN.x, POWER_CONN.z + 0.09, 20);
  label('PIKARA  GX-01  REV 1.0', 1.12, 0.47, 26);
  label('PCI-E 5.0 x16', -0.56, 0.5, 22);
  label('94V-0', 1.36, -0.08, 18);
  label('E471029', 1.36, -0.05, 16);
  // 被動元件絲印小框（隨機）
  g.lineWidth = 1.6;
  for (let i = 0; i < 220; i++) {
    const x = (r() - 0.5) * PCB_W * 0.94;
    const z = (r() - 0.5) * PCB_D * 0.9;
    const vertical = r() < 0.5;
    const w = vertical ? 0.009 : 0.018;
    const d = vertical ? 0.018 : 0.009;
    g.strokeRect(X(x - w / 2), Z(z - d / 2), w * S, d * S);
    if (r() < 0.25) label(`C${100 + i}`, x, z + 0.016, 13);
  }

  // 散熱器鎖孔（化金環 + 孔）
  for (const [x, z] of MOUNT_HOLES) {
    g.fillStyle = col('gold');
    g.beginPath();
    g.arc(X(x), Z(z), 0.024 * S, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = col('hole');
    g.beginPath();
    g.arc(X(x), Z(z), 0.013 * S, 0, Math.PI * 2);
    g.fill();
  }
  // 定位點 fiducial
  g.fillStyle = col('gold');
  for (const [x, z] of [
    [-1.42, -0.5],
    [1.42, -0.5],
    [1.42, 0.5],
    [DIE_POS.x + 0.27, DIE_POS.z - 0.27],
  ]) {
    g.beginPath();
    g.arc(X(x), Z(z), 0.006 * S, 0, Math.PI * 2);
    g.fill();
  }
  // I/O 端子焊墊
  g.fillStyle = col('tin');
  for (const z of DISPLAY_PORTS) {
    for (let k = 0; k < 10; k++) g.fillRect(X(-1.31), Z(z - 0.07 + k * 0.0145), 0.012 * S, 0.007 * S);
  }
  // 條碼貼紙
  g.fillStyle = col('label');
  g.fillRect(X(0.98), Z(0.33), 0.26 * S, 0.09 * S);
  g.fillStyle = col('dark');
  let bx = X(1.0);
  while (bx < X(1.22)) {
    const bw = 2 + Math.floor(r() * 3) * 2;
    if (r() > 0.4) g.fillRect(bx, Z(0.34), bw, 0.045 * S);
    bx += bw + 2;
  }
  g.font = `500 16px Consolas, monospace`;
  g.textAlign = 'left';
  g.fillText('SN 2611 1904 7731', X(1.0), Z(0.405));
};

export const pcbTextures = () =>
  once('pcb', () => {
    const make = (mode: Mode) => {
      const c = canvas(PCB_TEX_W, PCB_TEX_H);
      drawPcb(c.getContext('2d')!, mode);
      return tex(c, mode === 'albedo');
    };
    return {map: make('albedo'), roughnessMap: make('rough'), bumpMap: make('bump'), metalnessMap: make('metal')};
  });

// ---------------- 矽晶粒 ----------------

export const dieTextures = () =>
  once('die', () => {
    const N = 1024;
    const r = rng(9001);
    const make = (mode: 'albedo' | 'rough') => {
      const c = canvas(N, N);
      const g = c.getContext('2d')!;
      g.fillStyle = mode === 'albedo' ? '#1B2232' : '#4A4A4A';
      g.fillRect(0, 0, N, N);
      // 晶粒背面的研磨紋（極淡的同心弧）
      for (let i = 0; i < 90; i++) {
        g.strokeStyle = mode === 'albedo' ? `rgba(120,140,190,${0.015 + r() * 0.02})` : `rgba(255,255,255,${0.02 + r() * 0.03})`;
        g.lineWidth = 1 + r() * 2;
        g.beginPath();
        g.arc(-N * 0.6, N * 1.4, N * (0.8 + i * 0.016), 0, Math.PI * 2);
        g.stroke();
      }
      // 對齊矩陣格的細網格（與上方示意矩陣同節距，讓矩陣「從晶片長出來」）
      const span = (GRID_N * GRID_PITCH) / DIE_SIZE;
      const p0 = ((1 - span) / 2) * N;
      const step = (GRID_PITCH / DIE_SIZE) * N;
      g.strokeStyle = mode === 'albedo' ? 'rgba(110,130,175,0.10)' : 'rgba(0,0,0,0.12)';
      g.lineWidth = 1.2;
      for (let k = 0; k <= GRID_N; k++) {
        g.beginPath();
        g.moveTo(p0 + k * step, p0);
        g.lineTo(p0 + k * step, N - p0);
        g.stroke();
        g.beginPath();
        g.moveTo(p0, p0 + k * step);
        g.lineTo(N - p0, p0 + k * step);
        g.stroke();
      }
      // 外圈 I/O 環
      g.fillStyle = mode === 'albedo' ? 'rgba(120,140,185,0.07)' : 'rgba(0,0,0,0.1)';
      const ring = p0 * 0.45;
      for (let k = 0; k < 48; k++) {
        const t = ((k + 0.5) / 48) * (N - 2 * ring) + ring - 6;
        g.fillRect(t, ring * 0.55, 12, ring * 0.5);
        g.fillRect(t, N - ring * 1.05, 12, ring * 0.5);
        g.fillRect(ring * 0.55, t, ring * 0.5, 12);
        g.fillRect(N - ring * 1.05, t, ring * 0.5, 12);
      }
      return tex(c, mode === 'albedo', 16);
    };
    return {map: make('albedo'), roughnessMap: make('rough')};
  });

// ---------------- 晶片頂面雷刻字 ----------------

const markingCanvas = (w: number, h: number, lines: {t: string; size: number; y: number; weight?: number}[], base: string, ink: string, logo = true) => {
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  // 環氧樹脂的細顆粒
  const r = rng(w * 31 + h);
  for (let i = 0; i < (w * h) / 30; i++) {
    g.fillStyle = `rgba(255,255,255,${r() * 0.025})`;
    g.fillRect(r() * w, r() * h, 1.5, 1.5);
  }
  g.fillStyle = ink;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  for (const l of lines) {
    g.font = `${l.weight ?? 600} ${l.size}px "Segoe UI", Arial, sans-serif`;
    g.fillText(l.t, w * 0.12, h * l.y);
  }
  if (logo) {
    // pin 1 圓點
    g.beginPath();
    g.arc(w * 0.08, h * 0.12, h * 0.035, 0, Math.PI * 2);
    g.strokeStyle = ink;
    g.lineWidth = 3;
    g.stroke();
  }
  return c;
};

export const vramTexture = () =>
  once('vram', () =>
    tex(
      markingCanvas(
        560,
        480,
        [
          {t: 'PKR', size: 74, y: 0.3, weight: 800},
          {t: 'GDDR7  24Gb', size: 46, y: 0.53},
          {t: 'D8BZF  28G', size: 42, y: 0.7},
          {t: '2611  KR', size: 36, y: 0.86},
        ],
        '#121419',
        '#3E434D',
      ),
      true,
    ),
  );

export const chokeTexture = () =>
  once('choke', () => tex(markingCanvas(160, 160, [{t: 'R22', size: 58, y: 0.55, weight: 700}], '#3B3F47', '#7E848F', false), true));

export const controllerTexture = () =>
  once('ctrl', () =>
    tex(
      markingCanvas(256, 256, [
        {t: 'uP9512', size: 46, y: 0.45},
        {t: 'R4T 26', size: 38, y: 0.68},
      ], '#15171C', '#4A4F59'),
      true,
    ),
  );

// ---------------- 拉絲金屬（粗糙度 + 微弱明暗） ----------------

export const brushedTexture = (key: string, seed: number, base = 0.5, contrast = 0.22) =>
  once('brushed-' + key, () => {
    const W = 1024;
    const H = 1024;
    const r = rng(seed);
    const c = canvas(W, H);
    const g = c.getContext('2d')!;
    const v = Math.round(base * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 2600; i++) {
      const y = r() * H;
      const light = r() > 0.5;
      g.fillStyle = light ? `rgba(255,255,255,${r() * contrast})` : `rgba(0,0,0,${r() * contrast})`;
      g.fillRect(0, y, W, 0.6 + r() * 1.6);
    }
    const t = tex(c, false, 16);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });

// ---------------- 示意矩陣的圓角格 ----------------

export const tileTexture = () =>
  once('tile', () => {
    const N = 128;
    const c = canvas(N, N);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, N, N);
    const rad = 26;
    g.beginPath();
    g.roundRect(3, 3, N - 6, N - 6, rad);
    const grd = g.createLinearGradient(0, 0, N, N);
    grd.addColorStop(0, 'rgb(250,250,250)');
    grd.addColorStop(1, 'rgb(175,175,175)');
    g.fillStyle = grd;
    g.fill();
    // 內側細亮邊（倒角感）
    g.beginPath();
    g.roundRect(9, 9, N - 18, N - 18, rad - 6);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 3;
    g.stroke();
    g.beginPath();
    g.roundRect(13, 13, N - 26, N - 26, rad - 9);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fill();
    const t = tex(c, true, 8);
    return t;
  });
