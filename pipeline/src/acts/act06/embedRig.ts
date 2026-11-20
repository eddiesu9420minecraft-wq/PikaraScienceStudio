import * as THREE from 'three';
import {ease, progress, tween} from '../../lib/anim';
import {makeRig} from '../../lib/camera3d';
import {anchor} from '../actData';
import {ATT_SLAB, Q_EMB, ROW_X, ROW_Y0, SLAB_Y} from './data';
import type {Anchors} from './common';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 3D 段落（Embedding 空間 → Transformer 層 → 進入其中一層）的時間點。 */
export const embedTimes = (A: Anchors) => {
  const similar = anchor(A, 'similar');
  const vector = anchor(A, 'vector');
  const layers = anchor(A, 'layers');
  const attention = anchor(A, 'attention');
  const example = anchor(A, 'example');
  return {
    vector,
    similar,
    layers,
    attention,
    example,
    // 3D 畫布可見範圍
    start: vector + 20,
    end: example + 40,
    // 2D 數字條 → 3D 點的飛行
    flyA: vector + 50,
    flyB: vector + 120,
    // 排成一列、升起
    rowA: layers - 70,
    rowB: layers - 5,
    riseA: layers + 10,
    riseB: attention + 30,
  };
};

const rigCache = new Map<string, ReturnType<typeof makeRig>>();
export const embedRig = (A: Anchors) => {
  const T = embedTimes(A);
  const key = JSON.stringify(T);
  let r = rigCache.get(key);
  if (!r) {
    const sy = SLAB_Y(ATT_SLAB);
    r = makeRig(
      [
        {f: T.start - 30, pos: V(0.2, 0.7, 10.8), target: V(0, 0, 0), fov: 36},
        {f: T.similar + 10, pos: V(2.0, 1.3, 9.9), target: V(0, 0, -0.2), fov: 36},
        {f: T.layers - 40, pos: V(4.6, 2.2, 8.6), target: V(0, -0.1, -0.3), fov: 36},
        {f: T.layers + 70, pos: V(7.6, 2.4, 11.2), target: V(0, -0.35, 0), fov: 34},
        {f: T.attention - 30, pos: V(6.6, 2.4, 10.0), target: V(0, 0.1, 0), fov: 34},
        {f: T.attention + 90, pos: V(2.4, sy + 1.25, 4.6), target: V(0, sy, 0), fov: 34},
        {f: T.example + 10, pos: V(0.5, sy + 0.95, 2.7), target: V(0.1, sy + 0.15, 0), fov: 34},
      ],
      16,
    );
    rigCache.set(key, r);
  }
  return r;
};

/** 問題 token i 在第 frame 幀的 3D 位置（嵌入空間 → 排成一列 → 升起穿過各層）。 */
export const qTokenPos = (A: Anchors, i: number, frame: number) => {
  const T = embedTimes(A);
  const e = Q_EMB[i];
  const rowT = ease.inOut(progress(frame, T.rowA + i * 3, T.rowB + i * 3));
  const x = e[0] + (ROW_X(i) - e[0]) * rowT;
  const z = e[2] + (0 - e[2]) * rowT;
  let y = e[1] + (ROW_Y0 - e[1]) * rowT;
  // 升起：從列的位置一路穿過前面幾層，停在 ATT_SLAB 層
  y += tween(frame, T.riseA, T.riseB, 0, SLAB_Y(ATT_SLAB) + 0.24 - ROW_Y0, ease.inOutSoft);
  // 嵌入空間中的微小漂浮
  const drift = (1 - rowT) * 0.04 * Math.sin(frame / 50 + i * 1.7);
  return V(x, y + drift, z);
};
