import React, {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {palette as P} from '../../theme/palette';
import {ease, progress} from '../../lib/anim';
import type {Anchors} from './common';
import {vis} from './common';
import {ATT_SLAB, EMB_WORDS, Q_TOKENS, SLAB_N, SLAB_Y} from './data';
import {embedRig, embedTimes, qTokenPos} from './embedRig';

const AMBER = new THREE.Color(P.amber);
const ICE = new THREE.Color(P.ice);
const NEUTRAL = new THREE.Color('#C9D1E2');

export const EmbedWorld: React.FC<{frame: number; anchors: Anchors}> = ({frame, anchors}) => (
  <ThreeCanvas
    width={1920}
    height={1080}
    gl={{antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true}}
    style={{position: 'absolute', inset: 0}}
  >
    <SceneSetup />
    <CameraDriver frame={frame} anchors={anchors} />
    <hemisphereLight args={['#9DB4E0', '#0A0E18', 0.5]} />
    <directionalLight position={[3.5, 6, 5]} intensity={2.2} color="#FFF1DE" />
    <directionalLight position={[-5, 2, -4]} intensity={1.8} color={P.ice} />
    <directionalLight position={[0, 2, 8]} intensity={0.8} color="#DDE6FF" />
    <Space frame={frame} anchors={anchors} />
    <Slabs frame={frame} anchors={anchors} />
    <Tokens frame={frame} anchors={anchors} />
  </ThreeCanvas>
);

const SceneSetup: React.FC = () => {
  const {gl, scene} = useThree();
  useLayoutEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.2;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.3;
    scene.background = new THREE.Color(P.ink);
    scene.fog = new THREE.Fog(P.ink, 9, 22);
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
};

const CameraDriver: React.FC<{frame: number; anchors: Anchors}> = ({frame, anchors}) => {
  const {camera, size} = useThree();
  useLayoutEffect(() => {
    const s = embedRig(anchors)(frame);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = s.fov;
    cam.aspect = size.width / size.height;
    cam.near = 0.01;
    cam.far = 60;
    cam.position.copy(s.pos);
    cam.lookAt(s.target);
    cam.updateProjectionMatrix();
  }, [frame, anchors, camera, size]);
  return null;
};

// ---------------- 嵌入空間：座標軸、地面格線、背景詞 ----------------
const Space: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = embedTimes(A);
  const spaceO = vis(f, T.start, T.flyA, T.rowA - 50, T.rowA + 10);
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(9, 18, P.line, P.line);
    const m = g.material as THREE.LineBasicMaterial;
    m.transparent = true;
    return g;
  }, []);
  const axisMat = useMemo(() => new THREE.LineBasicMaterial({color: '#6F7D9C', transparent: true}), []);
  const axes = useMemo(() => {
    const L = 3.4;
    const pts = [
      [-L, 0, 0, L, 0, 0],
      [0, -L * 0.75, 0, 0, L * 0.75, 0],
      [0, 0, -L, 0, 0, L],
    ];
    return pts.map((p) => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p[0], p[1], p[2]), new THREE.Vector3(p[3], p[4], p[5])]));
  }, []);
  const sphere = useMemo(() => new THREE.SphereGeometry(0.085, 32, 20), []);
  const mats = useMemo(() => EMB_WORDS.map(() => new THREE.MeshStandardMaterial({color: NEUTRAL, roughness: 0.35, metalness: 0.1, emissive: NEUTRAL, emissiveIntensity: 0.25, transparent: true})), []);
  (grid.material as THREE.LineBasicMaterial).opacity = 0.35 * spaceO;
  axisMat.opacity = 0.55 * spaceO;
  const clusterT = ease.inOut(progress(f, T.similar - 20, T.similar + 30));
  EMB_WORDS.forEach((w, i) => {
    const o = progress(f, T.start + 10 + i * 4, T.flyA + i * 4) * spaceO;
    const m = mats[i];
    m.opacity = o;
    const c = NEUTRAL.clone().lerp(AMBER, clusterT * 0.85);
    m.color.copy(c);
    m.emissive.copy(c);
    m.emissiveIntensity = 0.25 + 0.25 * clusterT;
  });
  if (spaceO <= 0.001) return null;
  return (
    <group>
      <primitive object={grid} position={[0, -2.4, 0]} />
      {axes.map((g, i) => (
        <lineSegments key={i} geometry={g} material={axisMat} />
      ))}
      {EMB_WORDS.map((w, i) => (
        <mesh key={w.text} geometry={sphere} material={mats[i]} position={w.pos} />
      ))}
    </group>
  );
};

// ---------------- Transformer 層（半透明薄板） ----------------
const Slabs: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = embedTimes(A);
  const geo = useMemo(() => new THREE.BoxGeometry(7.6, 0.07, 2.3), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geo), [geo]);
  const mats = useMemo(
    () =>
      Array.from({length: SLAB_N}, () => ({
        body: new THREE.MeshStandardMaterial({color: '#2A3A5E', roughness: 0.25, metalness: 0.2, transparent: true, depthWrite: false, side: THREE.DoubleSide}),
        edge: new THREE.LineBasicMaterial({color: ICE, transparent: true}),
      })),
    [],
  );
  const groupRef = useRef<THREE.Group>(null);
  // 代表 token 的平均高度（全部 token 一起升起）
  const ty = qTokenPos(A, 0, f).y;
  const slabO = (k: number) => progress(f, T.rowA - 10 + k * 7, T.rowB + 10 + k * 7);
  const anyO = slabO(0);
  for (let k = 0; k < SLAB_N; k++) {
    const o = slabO(k);
    const g = Math.exp(-Math.pow((ty - SLAB_Y(k)) / 0.32, 2));
    const focus = k === ATT_SLAB ? progress(f, T.attention - 40, T.attention + 10) : 0;
    const passed = ty > SLAB_Y(k) + 0.1 ? 0.25 : 0;
    const heat = Math.max(g, focus, passed);
    mats[k].body.opacity = o * (0.16 + 0.16 * heat);
    mats[k].body.color.set('#2A3A5E').lerp(new THREE.Color('#5A4A30'), heat * 0.6);
    mats[k].edge.opacity = o * (0.45 + 0.5 * heat);
    mats[k].edge.color.copy(ICE).lerp(AMBER, heat);
  }
  if (anyO <= 0.001) return null;
  return (
    <group ref={groupRef}>
      {Array.from({length: SLAB_N}, (_, k) => (
        <group key={k} position={[0, SLAB_Y(k), 0]}>
          <mesh geometry={geo} material={mats[k].body} renderOrder={1} />
          <lineSegments geometry={edges} material={mats[k].edge} renderOrder={2} />
        </group>
      ))}
    </group>
  );
};

// ---------------- 問題 token（點 → 向量柱） ----------------
const Tokens: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = embedTimes(A);
  const geo = useMemo(() => new THREE.SphereGeometry(0.1, 32, 20), []);
  const mats = useMemo(() => Q_TOKENS.map(() => new THREE.MeshStandardMaterial({color: ICE, emissive: ICE, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.1, transparent: true})), []);
  const stretch = ease.inOut(progress(f, T.rowA, T.rowB + 20));
  return (
    <group>
      {Q_TOKENS.map((_, i) => {
        const arrive = progress(f, T.flyB + i * 3 - 12, T.flyB + i * 3);
        mats[i].opacity = arrive;
        const p = qTokenPos(A, i, f);
        return arrive > 0.001 ? <mesh key={i} geometry={geo} material={mats[i]} position={p} scale={[1 - 0.2 * stretch, 1 + 1.0 * stretch, 1 - 0.2 * stretch]} /> : null;
      })}
    </group>
  );
};
