import * as THREE from 'three';
import {clamp} from './anim';

/**
 * 3D 攝影機軌道：位置與注視點各自走 Catmull-Rom 曲線，
 * 時間參數 u 先做分段線性映射，再以盒狀濾波平滑，讓關鍵影格之間速度連續（不會每到一點就停頓）。
 * 純函式、逐幀確定性；同一函式同時供 3D 畫面與 2D 標籤投影使用。
 */
export type CamKey = {f: number; pos: THREE.Vector3; target: THREE.Vector3; fov?: number};

export const makeRig = (keys: CamKey[], smoothFrames = 14) => {
  const posCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.pos), false, 'centripetal');
  const tgtCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.target), false, 'centripetal');
  const n = keys.length;
  const rawU = (f: number) => {
    if (f <= keys[0].f) return 0;
    for (let i = 0; i < n - 1; i++) {
      if (f <= keys[i + 1].f) {
        const t = (f - keys[i].f) / (keys[i + 1].f - keys[i].f);
        return (i + t) / (n - 1);
      }
    }
    return 1;
  };
  const fovAt = (f: number) => {
    if (f <= keys[0].f) return keys[0].fov ?? 30;
    for (let i = 0; i < n - 1; i++) {
      if (f <= keys[i + 1].f) {
        const t = (f - keys[i].f) / (keys[i + 1].f - keys[i].f);
        const a = keys[i].fov ?? 30;
        const b = keys[i + 1].fov ?? 30;
        return a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      }
    }
    return keys[n - 1].fov ?? 30;
  };
  const smoothU = (f: number) => {
    let s = 0;
    const N = smoothFrames * 2 + 1;
    for (let i = -smoothFrames; i <= smoothFrames; i++) s += rawU(f + i);
    return clamp(s / N);
  };
  return (frame: number) => {
    const u = smoothU(frame);
    return {pos: posCurve.getPoint(u), target: tgtCurve.getPoint(u), fov: fovAt(frame)};
  };
};

export const buildCamera = (state: {pos: THREE.Vector3; target: THREE.Vector3; fov: number}, aspect = 16 / 9) => {
  const cam = new THREE.PerspectiveCamera(state.fov, aspect, 0.004, 60);
  cam.position.copy(state.pos);
  cam.lookAt(state.target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
};

/** 將世界座標投影到 1920×1080 畫面像素座標。 */
export const project = (cam: THREE.PerspectiveCamera, p: THREE.Vector3, W = 1920, H = 1080) => {
  const v = p.clone().project(cam);
  return {x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, visible: v.z < 1 && v.z > -1};
};
