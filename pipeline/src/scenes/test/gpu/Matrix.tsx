import React, {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {palette as P} from '../../../theme/palette';
import {clamp, ease, progress, tween} from '../../../lib/anim';
import {SHOT} from '../shots';
import {DIE_POS, DIE_TOP, GRID_N, GRID_PITCH, partialY, W_MAT, waveAt, X_VEC, Y_MAX} from '../gpuRig';
import {tileTexture} from './textures';
import {makeGlowStandard} from './materials';

/**
 * Schematic weight matrix drawn flat on the die surface (a diagram, not microstructure):
 * - W: thin rounded tiles; hue = sign (amber +, ice -), brightness = |w|
 * - fine grid + matrix brackets in schematic line style
 * - x: a row of tiles above the matrix with slim value bars
 * - y: a column on the right that fills as the accumulation wave passes (waveAt / partialY)
 * - at the wave front, x_j is fed down column j as a thin glowing line with a travelling dash
 */

const N = GRID_N;
const PITCH = GRID_PITCH;
const HALF = (N - 1) / 2;
const TILE = PITCH * 0.8;
const VEC_OFF = (HALF + 2.2) * PITCH; // same offsets GpuLabels uses
const Y0 = DIE_TOP + 0.0005;

const AMBER = new THREE.Color(P.amber);
const ICE = new THREE.Color(P.ice);
const WHITE = new THREE.Color('#FFFFFF');

const cx = (j: number) => DIE_POS.x + (j - HALF) * PITCH;
const cz = (i: number) => DIE_POS.z + (i - HALF) * PITCH;

/** Flat rectangles (x0,z0,x1,z1) merged into one geometry at height y. */
const strips = (rects: [number, number, number, number][], y: number) => {
  const pos: number[] = [];
  const idx: number[] = [];
  rects.forEach(([x0, z0, x1, z1], k) => {
    pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
    const b = k * 4;
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
};

/** Matrix-bracket glyph ( [ ] ) around a rectangle, as thin flat strips. */
const bracketRects = (x0: number, z0: number, x1: number, z1: number, w: number, arm: number): [number, number, number, number][] => [
  [x0 - w, z0, x0, z1],
  [x0 - w, z0 - w, x0 + arm, z0],
  [x0 - w, z1, x0 + arm, z1 + w],
  [x1, z0, x1 + w, z1],
  [x1 - arm, z0 - w, x1 + w, z0],
  [x1 - arm, z1, x1 + w, z1 + w],
];

export const MatrixGrid: React.FC<{frame: number}> = ({frame}) => {
  const tiles = useRef<THREE.InstancedMesh>(null);
  const xTiles = useRef<THREE.InstancedMesh>(null);
  const yTiles = useRef<THREE.InstancedMesh>(null);
  const xBars = useRef<THREE.InstancedMesh>(null);
  const yBars = useRef<THREE.InstancedMesh>(null);
  const feeds = useRef<THREE.InstancedMesh>(null);
  const dashes = useRef<THREE.InstancedMesh>(null);

  const geo = useMemo(() => {
    const tile = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const bar = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const span = N * PITCH;
    const g0 = DIE_POS.x - span / 2;
    const g1 = DIE_POS.x + span / 2;
    const h0 = DIE_POS.z - span / 2;
    const h1 = DIE_POS.z + span / 2;
    const lw = 0.00028;
    const grid: [number, number, number, number][] = [];
    for (let k = 0; k <= N; k++) {
      const x = g0 + k * PITCH;
      const z = h0 + k * PITCH;
      grid.push([x - lw / 2, h0, x + lw / 2, h1]);
      grid.push([g0, z - lw / 2, g1, z + lw / 2]);
    }
    const bw = 0.0011;
    const pad = PITCH * 0.45;
    const brackets = [
      ...bracketRects(g0 - pad, h0 - pad, g1 + pad, h1 + pad, bw, PITCH * 0.9),
      // x row vector
      ...bracketRects(g0 - pad, DIE_POS.z - VEC_OFF - PITCH * 0.5, g1 + pad, DIE_POS.z - VEC_OFF + PITCH * 0.5, bw, PITCH * 0.7),
      // y column vector
      ...bracketRects(DIE_POS.x + VEC_OFF - PITCH * 0.5, h0 - pad, DIE_POS.x + VEC_OFF + PITCH * 0.5, h1 + pad, bw, PITCH * 0.4),
    ];
    return {
      tile,
      bar,
      grid: strips(grid, DIE_TOP + 0.0002),
      brackets: strips(brackets, DIE_TOP + 0.0003),
    };
  }, []);

  const mat = useMemo(() => {
    const map = tileTexture();
    return {
      tile: new THREE.MeshBasicMaterial({map, alphaTest: 0.5, toneMapped: false}),
      bar: makeGlowStandard(0.55, {roughness: 0.3, metalness: 0.1}),
      grid: new THREE.MeshBasicMaterial({color: '#9FB3D9', transparent: true, depthWrite: false, toneMapped: false}),
      bracket: new THREE.MeshBasicMaterial({color: P.paper, transparent: true, depthWrite: false, toneMapped: false}),
      feed: new THREE.MeshBasicMaterial({transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false}),
    };
  }, []);

  // timeline (template frames)
  const grow = progress(frame, SHOT.matrixStart - 22, SHOT.matrixStart + 38);
  const gridIn = tween(frame, SHOT.matrixStart - 30, SHOT.matrixStart + 10, 0, 1, ease.out);
  const xIn = tween(frame, SHOT.matrixStart + 20, SHOT.waveStart - 4, 0, 1, ease.out);
  const yIn = tween(frame, SHOT.waveStart - 8, SHOT.waveStart + 10, 0, 1, ease.out);
  const wave = waveAt(frame);
  const waveOn = wave > 0 && wave < N ? 1 : 0;
  const settle = progress(frame, SHOT.pullStart, SHOT.pullStart + 50);

  mat.grid.opacity = 0.16 * gridIn;
  mat.bracket.opacity = 0.75 * grow;

  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    // ---- W tiles ----
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const k = i * N + j;
        const w = W_MAT[i][j];
        const delay = ((i + (N - 1 - j)) / (2 * N - 2)) * 0.55;
        const s = ease.out(clamp((grow - delay) / 0.45));
        o.position.set(cx(j), Y0, cz(i));
        o.scale.set(TILE * s + 1e-6, 1, TILE * s + 1e-6);
        o.updateMatrix();
        tiles.current!.setMatrixAt(k, o.matrix);
        const d = wave - j - 0.5;
        const g = waveOn ? Math.exp(-(d * d) / 0.45) : 0;
        const done = clamp(wave - j);
        const base = 0.26 + 0.74 * Math.abs(w);
        c.copy(w >= 0 ? AMBER : ICE)
          .multiplyScalar(base * (0.82 + 0.18 * done) * (0.6 + 0.4 * s))
          .lerp(WHITE, g * 0.55 * (0.35 + 0.65 * Math.abs(w)));
        tiles.current!.setColorAt(k, c);
      }
    }
    // ---- x row + value bars + column feed lines ----
    const zx = DIE_POS.z - VEC_OFF;
    const zEnd = cz(N - 1) + PITCH * 0.5;
    for (let j = 0; j < N; j++) {
      const v = X_VEC[j];
      const s = ease.out(clamp(xIn * 1.6 - (j / N) * 0.6));
      const d = wave - j - 0.5;
      const g = waveOn ? Math.exp(-(d * d) / 0.45) : 0;
      o.position.set(cx(j), Y0, zx);
      o.scale.set(TILE * s + 1e-6, 1, TILE * s + 1e-6);
      o.updateMatrix();
      xTiles.current!.setMatrixAt(j, o.matrix);
      c.copy(v >= 0 ? AMBER : ICE)
        .multiplyScalar(0.3 + 0.7 * Math.abs(v))
        .lerp(WHITE, g * 0.6);
      xTiles.current!.setColorAt(j, c);
      // slim value bar standing on the x tile
      const h = (0.004 + Math.abs(v) * 0.026) * s;
      o.position.set(cx(j), Y0, zx);
      o.scale.set(PITCH * 0.26, h + 1e-6, PITCH * 0.26);
      o.updateMatrix();
      xBars.current!.setMatrixAt(j, o.matrix);
      c.copy(v >= 0 ? AMBER : ICE).lerp(WHITE, g * 0.5);
      xBars.current!.setColorAt(j, c);
      // feed line: x_j flows down column j at the wave front
      o.position.set(cx(j), DIE_TOP + 0.0009, (zx + zEnd) / 2);
      o.scale.set(PITCH * 0.16, 1, zEnd - zx);
      o.updateMatrix();
      feeds.current!.setMatrixAt(j, o.matrix);
      c.copy(v >= 0 ? AMBER : ICE).lerp(WHITE, 0.35).multiplyScalar(g * 0.9);
      feeds.current!.setColorAt(j, c);
      // travelling dash down the column while the wave sits on it
      const phi = clamp(wave - j);
      const on = phi > 0 && phi < 1 ? Math.sin(Math.PI * phi) : 0;
      o.position.set(cx(j), DIE_TOP + 0.001, zx + phi * (zEnd - zx));
      o.scale.set(PITCH * 0.42, 1, PITCH * 2.2);
      o.updateMatrix();
      dashes.current!.setMatrixAt(j, o.matrix);
      c.copy(v >= 0 ? AMBER : ICE).lerp(WHITE, 0.6).multiplyScalar(on * 1.4);
      dashes.current!.setColorAt(j, c);
    }
    // ---- y column (accumulates) ----
    const xy = DIE_POS.x + VEC_OFF;
    for (let i = 0; i < N; i++) {
      const y = partialY(i, wave) / Y_MAX;
      const s = ease.out(clamp(yIn * 1.5 - (i / N) * 0.5));
      o.position.set(xy, Y0, cz(i));
      o.scale.set(TILE * s + 1e-6, 1, TILE * s + 1e-6);
      o.updateMatrix();
      yTiles.current!.setMatrixAt(i, o.matrix);
      c.copy(y >= 0 ? AMBER : ICE)
        .multiplyScalar(0.12 + 0.88 * Math.min(1, Math.abs(y)))
        .lerp(WHITE, settle * 0.12);
      yTiles.current!.setColorAt(i, c);
      const h = (0.0015 + Math.min(1, Math.abs(y)) * 0.03) * s;
      o.position.set(xy, Y0, cz(i));
      o.scale.set(PITCH * 0.26, h + 1e-6, PITCH * 0.26);
      o.updateMatrix();
      yBars.current!.setMatrixAt(i, o.matrix);
      c.copy(y >= 0 ? AMBER : ICE);
      yBars.current!.setColorAt(i, c);
    }
    for (const r of [tiles, xTiles, yTiles, xBars, yBars, feeds, dashes]) {
      r.current!.instanceMatrix.needsUpdate = true;
      if (r.current!.instanceColor) r.current!.instanceColor.needsUpdate = true;
    }
  }, [frame, grow, xIn, yIn, wave, waveOn, settle]);

  const visible = gridIn > 0.001;
  return (
    <group visible={visible}>
      <mesh geometry={geo.grid} material={mat.grid} renderOrder={2} />
      <mesh geometry={geo.brackets} material={mat.bracket} renderOrder={2} />
      <instancedMesh ref={tiles} args={[geo.tile, mat.tile, N * N]} renderOrder={3} frustumCulled={false} />
      <instancedMesh ref={xTiles} args={[geo.tile, mat.tile, N]} renderOrder={3} frustumCulled={false} />
      <instancedMesh ref={yTiles} args={[geo.tile, mat.tile, N]} renderOrder={3} frustumCulled={false} />
      <instancedMesh ref={xBars} args={[geo.bar, mat.bar, N]} frustumCulled={false} />
      <instancedMesh ref={yBars} args={[geo.bar, mat.bar, N]} frustumCulled={false} />
      <instancedMesh ref={feeds} args={[geo.tile, mat.feed, N]} renderOrder={4} frustumCulled={false} />
      <instancedMesh ref={dashes} args={[geo.tile, mat.feed, N]} renderOrder={4} frustumCulled={false} />
    </group>
  );
};
