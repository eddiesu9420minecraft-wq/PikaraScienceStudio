import * as THREE from 'three';
import {ease, rng, tween} from '../../lib/anim';
import {buildCamera, makeRig} from '../../lib/camera3d';
import {SHOT} from './shots';

/**
 * 顯示卡場景的共用幾何與運動定義（純資料、純函式）。
 * 3D 渲染（GpuWorld）與 2D 標籤（GpuLabels）共用這裡，確保標籤永遠貼合物件。
 *
 * 單位：1 = 10 cm。卡長 3.0（30 cm）、PCB 寬 1.15、雙槽厚度約 0.5。
 * 卡片本地座標：PCB 在 y=0 平面，散熱器/外殼在 +y 側，PCIe 金手指在 +z 邊。
 */
export const DIE_POS = new THREE.Vector3(-0.32, 0.0, -0.02); // 晶片封裝中心（PCB 上）
export const DIE_TOP = 0.066; // 晶片頂面高度（矩陣格放在這個平面）
export const GRID_N = 24;
export const GRID_PITCH = 0.0104;

export const VRAM_OFFSETS: [number, number][] = [
  [-0.46, -0.27], [-0.46, 0.02], [-0.46, 0.31],
  [0.46, -0.27], [0.46, 0.02], [0.46, 0.31],
  [-0.15, -0.44], [0.15, -0.44],
];

// 卡片姿態：裝機狀態（風扇朝下、外側邊緣面向側透玻璃）→ 旋轉成 3/4 展示角度
export const cardRotation = (f: number) => {
  const rx = tween(f, 250, SHOT.xrayStart, Math.PI, THREE.MathUtils.degToRad(64), ease.camera);
  const ry = tween(f, 250, SHOT.xrayStart, 0, THREE.MathUtils.degToRad(-26), ease.camera);
  return {rx, ry};
};

export const cardMatrix = (f: number) => {
  const {rx, ry} = cardRotation(f);
  const m = new THREE.Matrix4().makeRotationY(ry);
  m.multiply(new THREE.Matrix4().makeRotationX(rx));
  return m;
};

const FINAL = cardMatrix(SHOT.xrayStart + 1);
/** 晶片本地座標（以晶片頂面中心為原點，軸向與卡片相同）→ 世界座標（使用最終姿態） */
export const dieLocal = (x: number, y: number, z: number) =>
  new THREE.Vector3(DIE_POS.x + x, DIE_TOP + y, DIE_POS.z + z).applyMatrix4(FINAL);

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const rig = makeRig([
  {f: SHOT.gpuStart - 30, pos: V(0, 0, 8.6), target: V(0, 0, 0), fov: 30},
  {f: SHOT.gpuStart, pos: V(0, 0, 7.6), target: V(0, 0, 0), fov: 30},
  {f: 250, pos: V(0, 0.05, 5.9), target: V(0, 0, 0), fov: 30},
  {f: 330, pos: V(1.2, 0.9, 5.1), target: V(0, 0.08, 0), fov: 30},
  {f: SHOT.xrayStart, pos: V(2.3, 2.5, 5.4), target: V(-0.1, 0, 0), fov: 30},
  {f: 470, pos: dieLocal(0.85, 1.75, 2.1), target: dieLocal(0.05, 0, 0.05), fov: 30},
  {f: SHOT.diveStart, pos: dieLocal(0.24, 0.72, 0.82), target: dieLocal(0, 0, 0), fov: 30},
  {f: SHOT.matrixStart, pos: dieLocal(0.05, 0.45, 0.56), target: dieLocal(0.01, 0, 0.03), fov: 31},
  {f: 700, pos: dieLocal(-0.22, 0.4, 0.52), target: dieLocal(0.015, 0, 0.028), fov: 32},
  {f: SHOT.pullStart + 10, pos: dieLocal(-0.28, 0.45, 0.58), target: dieLocal(0.012, 0, 0.024), fov: 32},
  {f: SHOT.gpuEnd, pos: dieLocal(-0.55, 1.9, 1.5), target: dieLocal(0.1, 0, 0), fov: 34},
  {f: SHOT.gpuEnd + 30, pos: dieLocal(-0.6, 2.3, 1.8), target: dieLocal(0.1, 0, 0), fov: 34},
]);

export const cameraAt = (f: number) => buildCamera(rig(f));

// ---- 矩陣資料（固定種子，逐幀可重現） ----
const r = rng(20261119);
export const W_MAT: number[][] = Array.from({length: GRID_N}, (_, i) =>
  Array.from({length: GRID_N}, (_, j) => {
    const structured = Math.sin(i * 0.55 + j * 0.31) * 0.55 + Math.cos(i * 0.21 - j * 0.47) * 0.35;
    return THREE.MathUtils.clamp(structured + (r() - 0.5) * 0.7, -1, 1);
  }),
);
export const X_VEC: number[] = Array.from({length: GRID_N}, (_, j) => THREE.MathUtils.clamp(Math.sin(j * 0.8 + 1.3) * 0.8 + (r() - 0.5) * 0.4, -1, 1));
const Y_FULL = W_MAT.map((row) => row.reduce((s, w, j) => s + w * X_VEC[j], 0));
export const Y_MAX = Math.max(...Y_FULL.map(Math.abs));

/** 波前位置（0..GRID_N）：所有列同時沿 j 方向累加乘積 —— 列與列之間是平行的。 */
export const waveAt = (f: number) => tween(f, SHOT.waveStart, SHOT.waveEnd, 0, GRID_N, ease.inOutSoft);
export const partialY = (i: number, wave: number) => {
  let s = 0;
  for (let j = 0; j < GRID_N; j++) {
    const k = THREE.MathUtils.clamp(wave - j, 0, 1);
    s += W_MAT[i][j] * X_VEC[j] * k;
  }
  return s;
};
