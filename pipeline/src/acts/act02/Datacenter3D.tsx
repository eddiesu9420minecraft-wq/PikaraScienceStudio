import React, {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {palette as P} from '../../theme/palette';
import {clamp, ease, lerp, progress, rng} from '../../lib/anim';
import {makeRig} from '../../lib/camera3d';
import type {Act2Times} from './shared';

/**
 * 資料中心內部（Three.js）。單位：1 = 1 公尺。
 * 冷通道沿 z 軸；每條冷通道兩側各一排機櫃，機櫃正面朝向冷通道。
 */
export const AISLES = [-3, -2, -1, 0, 1, 2, 3];
export const AISLE_PITCH = 5.4;
export const RACKS_PER_ROW = 24;
export const RACK_PITCH = 0.62;
const RACK_D = 1.2;
const RACK_H = 2.2;
const RACK_W = 0.6;
const FRONT_X = 0.9; // 冷通道中心到機櫃正面的距離
export const TARGET = {aisle: 0, side: 1, index: 6};
export const targetFront = () => new THREE.Vector3(AISLES.indexOf(0) >= 0 ? FRONT_X : 0, 1.25, -TARGET.index * RACK_PITCH);

type Rack = {x: number; z: number; side: -1 | 1; aisle: number; index: number};
const RACKS: Rack[] = (() => {
  const out: Rack[] = [];
  for (const a of AISLES) {
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < RACKS_PER_ROW; i++) {
        out.push({x: a * AISLE_PITCH + side * (FRONT_X + RACK_D / 2), z: -i * RACK_PITCH, side, aisle: a, index: i});
      }
    }
  }
  return out;
})();
const TARGET_IDX = RACKS.findIndex((r) => r.aisle === TARGET.aisle && r.side === TARGET.side && r.index === TARGET.index);

// LED：每台伺服器 2 顆（8 台），在機櫃正面右側
const UNITS = 8;
const LEDS_PER_RACK = UNITS * 2;
const unitY = (u: number) => {
  // 紋理中伺服器區：畫布 y 80..880（共 960，對應 2.16 m 高、底部在 0.02 m）
  const top = 80 + u * 100;
  return (pxY: number) => 0.02 + (1 - (top + pxY) / 960) * 2.16;
};

export const dcRig = (T: Act2Times) =>
  makeRig(
    [
      {f: T.datacenter + 40, pos: new THREE.Vector3(0, 1.62, 8.2), target: new THREE.Vector3(0, 1.45, 0), fov: 52},
      {f: T.datacenter + 150, pos: new THREE.Vector3(0.0, 1.56, 3.0), target: new THREE.Vector3(0.12, 1.4, -3), fov: 50},
      {f: T.servers - 30, pos: new THREE.Vector3(-0.45, 1.5, 0.4), target: new THREE.Vector3(0.9, 1.25, -3.6), fov: 46},
      {f: T.servers + 8, pos: new THREE.Vector3(-0.2, 2.0, 3.2), target: new THREE.Vector3(0.7, 1.2, -3.8), fov: 46},
      {f: T.servers + 70, pos: new THREE.Vector3(-4.6, 6.6, 5.6), target: new THREE.Vector3(0.6, 0.7, -5.6), fov: 46},
      {f: T.ret, pos: new THREE.Vector3(-3.4, 9.2, 2.0), target: new THREE.Vector3(0.8, 0.4, -4.6), fov: 46},
      {f: T.ret + 45, pos: new THREE.Vector3(0.7, 19, -2.6), target: new THREE.Vector3(0.9, 0, -3.8), fov: 46},
    ],
    16,
  );

/** 進入的請求封包與離開的回覆封包（3D 世界座標）。 */
export const packetPos3D = (T: Act2Times, frame: number, i: number) => {
  const f = frame - i * 2.4;
  const tgt = new THREE.Vector3(FRONT_X - 0.02, 1.25 + ((i % 3) - 1) * 0.16, -TARGET.index * RACK_PITCH + (Math.floor(i / 3) - 1) * 0.12);
  const a = new THREE.Vector3(((i % 3) - 1) * 0.3, 1.45 + ((i * 7) % 5) * 0.06, 4.2 - Math.floor(i / 3) * 0.35);
  const b = new THREE.Vector3(0.1 + ((i % 3) - 1) * 0.2, 1.4 + ((i * 7) % 5) * 0.05, -0.6 - Math.floor(i / 3) * 0.3);
  const t = progress(f, T.datacenter + 45, T.servers - 18);
  const k = ease.inOutSoft(t);
  // 兩段：沿通道 → 轉入機櫃
  const p = k < 0.72 ? a.clone().lerp(b, k / 0.72) : b.clone().lerp(tgt, ease.out((k - 0.72) / 0.28));
  const o = progress(f, T.datacenter + 45, T.datacenter + 60) * (1 - progress(f, T.servers - 26, T.servers - 16));
  return {p, o};
};

export const answerPos3D = (T: Act2Times, frame: number, i: number) => {
  const f = frame - i * 2.2;
  const start = new THREE.Vector3(FRONT_X + 0.05, 1.25 + ((i % 3) - 1) * 0.16, -TARGET.index * RACK_PITCH + (Math.floor(i / 3) - 1) * 0.12);
  const t = progress(f, T.ret - 6, T.ret + 46);
  const k = ease.in(t);
  const p = start.clone().add(new THREE.Vector3(-0.4 * k + ((i % 3) - 1) * 0.3 * k, 15 * k * k + 1.2 * k, 0.6 * k));
  const o = progress(f, T.ret - 6, T.ret + 2);
  return {p, o};
};

export const Datacenter3D: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => (
  <ThreeCanvas
    width={1920}
    height={1080}
    gl={{antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true}}
    style={{position: 'absolute', inset: 0}}
  >
    <SceneSetup />
    <CameraDriver frame={frame} T={T} />
    <Lights frame={frame} T={T} />
    <Floor />
    <Racks frame={frame} T={T} />
    <Overhead />
    <Packets frame={frame} T={T} />
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
    scene.environmentIntensity = 0.32;
    scene.background = new THREE.Color('#0B1120');
    scene.fog = new THREE.Fog('#0B1120', 9, 34);
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
};

const CameraDriver: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const {camera} = useThree();
  const rig = useMemo(() => dcRig(T), [T]);
  useLayoutEffect(() => {
    const s = rig(frame);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = s.fov;
    cam.aspect = 1920 / 1080;
    cam.near = 0.05;
    cam.far = 80;
    cam.position.copy(s.pos);
    cam.lookAt(s.target);
    cam.updateProjectionMatrix();
  }, [frame, camera, rig]);
  return null;
};

const Lights: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const glow = progress(frame, T.servers - 24, T.servers + 10) * (1 - 0.5 * progress(frame, T.ret + 10, T.ret + 40));
  const tf = targetFront();
  return (
    <>
      <hemisphereLight args={['#A8BEE6', '#0A0E18', 0.9]} />
      <directionalLight position={[6, 10, 8]} intensity={1.3} color="#FFF1DE" />
      <directionalLight position={[-6, 5, -14]} intensity={1.6} color={P.ice} />
      <directionalLight position={[0, 3, 10]} intensity={0.7} color="#DDE6FF" />
      {[-1, 0, 1].map((a) =>
        [1.5, -3.5, -8.5].map((z) => <pointLight key={`${a}${z}`} position={[a * AISLE_PITCH, 3.0, z]} intensity={9} distance={9} decay={1.6} color="#DCE8FF" />),
      )}
      <pointLight position={[tf.x - 0.5, tf.y, tf.z]} intensity={6 * glow} distance={3.2} decay={1.5} color={P.amber} />
    </>
  );
};

// ---------------- 紋理 ----------------

const makeCanvas = (w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  draw(ctx);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
};

const rackFrontTexture = () =>
  makeCanvas(256, 960, (c) => {
    c.fillStyle = '#10141C';
    c.fillRect(0, 0, 256, 960);
    // 上方交換器
    c.fillStyle = '#1B212D';
    c.fillRect(10, 18, 236, 40);
    for (let i = 0; i < 24; i++) {
      c.fillStyle = '#0A0D13';
      c.fillRect(22 + (i % 12) * 17, 24 + Math.floor(i / 12) * 16, 12, 10);
    }
    // 配線面板
    c.fillStyle = '#232A38';
    c.fillRect(10, 62, 236, 14);
    for (let i = 0; i < 16; i++) {
      c.fillStyle = i % 3 === 0 ? '#2C7FD0' : '#3A4560';
      c.fillRect(20 + i * 14, 66, 8, 6);
    }
    // 8 台 GPU 伺服器
    for (let u = 0; u < UNITS; u++) {
      const top = 80 + u * 100;
      c.fillStyle = '#1A202B';
      c.fillRect(8, top + 3, 240, 94);
      c.fillStyle = '#242C3A';
      c.fillRect(8, top + 3, 240, 3);
      // 進氣格柵
      for (let y = top + 14; y < top + 88; y += 5) {
        c.fillStyle = '#0D1118';
        c.fillRect(30, y, 168, 2.4);
      }
      // 把手
      c.fillStyle = '#6E788E';
      c.fillRect(13, top + 18, 7, 62);
      c.fillRect(236, top + 18, 7, 62);
      // 標籤與狀態窗
      c.fillStyle = '#3A4560';
      c.fillRect(30, top + 6, 46, 5);
      c.fillStyle = '#0A0D13';
      c.fillRect(206, top + 12, 24, 32);
    }
    // 底部擋板
    c.fillStyle = '#161B25';
    c.fillRect(8, 884, 240, 70);
    for (let y = 892; y < 950; y += 6) {
      c.fillStyle = '#0F131B';
      c.fillRect(20, y, 216, 2);
    }
  });

const floorTexture = () =>
  makeCanvas(512, 512, (c) => {
    const r = rng(7);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const v = 40 + Math.floor(r() * 8);
        c.fillStyle = `rgb(${v - 8},${v - 2},${v + 12})`;
        c.fillRect(i * 128, j * 128, 128, 128);
      }
    }
    c.strokeStyle = '#141924';
    c.lineWidth = 4;
    for (let i = 0; i <= 4; i++) {
      c.beginPath();
      c.moveTo(i * 128, 0);
      c.lineTo(i * 128, 512);
      c.stroke();
      c.beginPath();
      c.moveTo(0, i * 128);
      c.lineTo(512, i * 128);
      c.stroke();
    }
  });

const perfTexture = () =>
  makeCanvas(256, 256, (c) => {
    c.fillStyle = '#3B475C';
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = '#1E2533';
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) c.fillRect(8 + i * 15.5, 8 + j * 15.5, 7, 7);
    c.strokeStyle = '#1A202C';
    c.lineWidth = 6;
    c.strokeRect(0, 0, 256, 256);
  });

// ---------------- 地板 ----------------

const Floor: React.FC = () => {
  const tex = useMemo(() => {
    const t = floorTexture();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(60 / 2.4, 60 / 2.4);
    return t;
  }, []);
  const perf = useMemo(() => {
    const t = perfTexture();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 26);
    return t;
  }, []);
  const len = RACKS_PER_ROW * RACK_PITCH + 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -6]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial map={tex} roughness={0.38} metalness={0.35} />
      </mesh>
      {AISLES.map((a) => (
        <mesh key={a} rotation={[-Math.PI / 2, 0, 0]} position={[a * AISLE_PITCH, 0.003, -len / 2 + 1.3]}>
          <planeGeometry args={[1.8, len]} />
          <meshStandardMaterial map={perf} roughness={0.42} metalness={0.4} emissive="#1A2A44" emissiveIntensity={0.35} />
        </mesh>
      ))}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 4.4, -6]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0C111C" roughness={0.9} />
      </mesh>
    </group>
  );
};

// ---------------- 機櫃 ----------------

const Racks: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const bodies = useRef<THREE.InstancedMesh>(null);
  const fronts = useRef<THREE.InstancedMesh>(null);
  const tops = useRef<THREE.InstancedMesh>(null);
  const leds = useRef<THREE.InstancedMesh>(null);
  const tex = useMemo(() => rackFrontTexture(), []);
  const m = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({color: '#1A202C', roughness: 0.42, metalness: 0.7}),
      front: new THREE.MeshStandardMaterial({map: tex, roughness: 0.48, metalness: 0.55, emissive: '#FFFFFF', emissiveMap: tex, emissiveIntensity: 0.12}),
      top: new THREE.MeshStandardMaterial({color: '#262E3E', roughness: 0.5, metalness: 0.6}),
      led: new THREE.MeshBasicMaterial({toneMapped: false}),
    }),
    [tex],
  );

  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    RACKS.forEach((r, i) => {
      o.position.set(r.x, RACK_H / 2, r.z);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      bodies.current!.setMatrixAt(i, o.matrix);
      o.position.set(r.x - r.side * (RACK_D / 2 + 0.004), RACK_H / 2, r.z);
      o.rotation.set(0, r.side === -1 ? Math.PI / 2 : -Math.PI / 2, 0);
      o.updateMatrix();
      fronts.current!.setMatrixAt(i, o.matrix);
      o.rotation.set(0, 0, 0);
      o.position.set(r.x, RACK_H + 0.01, r.z);
      o.updateMatrix();
      tops.current!.setMatrixAt(i, o.matrix);
    });
    for (const ref of [bodies, fronts, tops]) ref.current!.instanceMatrix.needsUpdate = true;
  }, []);

  // LED：確定性閃爍；目標機櫃在運算時轉為琥珀色；「伺服器」一詞時由目標機櫃向外擴散一波亮光
  const compute = progress(frame, T.servers - 22, T.servers + 6) * (1 - progress(frame, T.ret + 20, T.ret + 50));
  const tgt = RACKS[TARGET_IDX];
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    const ice = new THREE.Color(P.ice);
    const mint = new THREE.Color(P.mint);
    const amber = new THREE.Color(P.amber);
    const dim = new THREE.Color('#1D2A3A');
    RACKS.forEach((r, ri) => {
      const dist = Math.hypot(r.x - tgt.x, r.z - tgt.z);
      const wave = Math.exp(-(((frame - T.servers) * 0.22 - dist) ** 2) / 2.2) * progress(frame, T.servers - 10, T.servers);
      for (let u = 0; u < UNITS; u++) {
        for (let k = 0; k < 2; k++) {
          const li = ri * LEDS_PER_RACK + u * 2 + k;
          const y = unitY(u)(k === 0 ? 20 : 34);
          const zOff = 0.218 * 0.58 * 0.5 * 1.55; // 畫布 x≈218 → 相對中心偏右
          const fx = r.x - r.side * (RACK_D / 2 + 0.008);
          o.position.set(fx, y, r.z + (r.side === -1 ? -zOff : zOff));
          o.rotation.set(0, r.side === -1 ? Math.PI / 2 : -Math.PI / 2, 0);
          o.scale.set(1, 1, 1);
          o.updateMatrix();
          leds.current!.setMatrixAt(li, o.matrix);
          const seed = Math.sin(li * 91.7 + 3.1) * 43758.5453;
          const ph = seed - Math.floor(seed);
          const period = 18 + Math.floor(ph * 40);
          const on = ((Math.floor((frame + ph * 200) / period) + li) % 3) !== 0;
          if (ri === TARGET_IDX && compute > 0) {
            const flick = 0.55 + 0.45 * Math.sin(frame * 0.7 + u * 1.3 + k);
            c.copy(dim).lerp(amber, compute * flick);
          } else if (k === 0) {
            c.copy(on ? mint : dim).multiplyScalar(on ? 0.75 : 1);
          } else {
            c.copy(on ? ice : dim).multiplyScalar(on ? 0.85 : 1);
          }
          if (wave > 0.01) c.lerp(ice, clamp(wave) * 0.9).multiplyScalar(1 + wave * 0.6);
          leds.current!.setColorAt(li, c);
        }
      }
    });
    leds.current!.instanceMatrix.needsUpdate = true;
    if (leds.current!.instanceColor) leds.current!.instanceColor.needsUpdate = true;
  }, [frame, T, compute, tgt]);

  return (
    <group>
      <instancedMesh ref={bodies} args={[undefined, undefined, RACKS.length]} material={m.body}>
        <boxGeometry args={[RACK_D, RACK_H, RACK_W]} />
      </instancedMesh>
      <instancedMesh ref={fronts} args={[undefined, undefined, RACKS.length]} material={m.front}>
        <planeGeometry args={[RACK_W - 0.02, RACK_H - 0.04]} />
      </instancedMesh>
      <instancedMesh ref={tops} args={[undefined, undefined, RACKS.length]} material={m.top}>
        <boxGeometry args={[RACK_D - 0.06, 0.02, RACK_W - 0.06]} />
      </instancedMesh>
      <instancedMesh ref={leds} args={[undefined, undefined, RACKS.length * LEDS_PER_RACK]} material={m.led}>
        <boxGeometry args={[0.006, 0.014, 0.022]} />
      </instancedMesh>
      <TargetGlow frame={frame} T={T} compute={compute} />
    </group>
  );
};

const TargetGlow: React.FC<{frame: number; T: Act2Times; compute: number}> = ({frame, compute}) => {
  const tf = targetFront();
  const mat = useMemo(() => new THREE.MeshBasicMaterial({color: P.amber, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false}), []);
  mat.opacity = 0.16 * compute * (0.85 + 0.15 * Math.sin(frame / 4));
  return (
    <mesh position={[tf.x - 0.012, 1.1, tf.z]} rotation={[0, -Math.PI / 2, 0]} material={mat} visible={compute > 0.01}>
      <planeGeometry args={[0.56, 1.8]} />
    </mesh>
  );
};

// ---------------- 天花板：線槽、燈條、冷通道門框 ----------------

const Overhead: React.FC = () => {
  const len = RACKS_PER_ROW * RACK_PITCH + 1.2;
  const zc = -len / 2 + 0.9;
  const m = useMemo(
    () => ({
      tray: new THREE.MeshStandardMaterial({color: '#2A3246', roughness: 0.5, metalness: 0.7}),
      cableA: new THREE.MeshStandardMaterial({color: '#6A5530', roughness: 0.7, metalness: 0.1}),
      cableB: new THREE.MeshStandardMaterial({color: '#25456A', roughness: 0.7, metalness: 0.1}),
      strip: new THREE.MeshBasicMaterial({color: '#EAF2FF'}),
      frame: new THREE.MeshStandardMaterial({color: '#2B3242', roughness: 0.35, metalness: 0.85}),
      glass: new THREE.MeshStandardMaterial({color: '#9FD6FF', roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.07, depthWrite: false}),
      header: new THREE.MeshBasicMaterial({color: P.ice, toneMapped: false}),
    }),
    [],
  );
  return (
    <group>
      {AISLES.map((a) => {
        const ax = a * AISLE_PITCH;
        return (
          <group key={a}>
            {/* 機櫃上方線槽（每排一條） */}
            {[-1, 1].map((side) => (
              <group key={side} position={[ax + side * (FRONT_X + RACK_D / 2), 2.78, zc]}>
                <mesh material={m.tray}>
                  <boxGeometry args={[0.42, 0.02, len]} />
                </mesh>
                {[-0.2, 0.2].map((dx) => (
                  <mesh key={dx} material={m.tray} position={[dx, 0.05, 0]}>
                    <boxGeometry args={[0.02, 0.1, len]} />
                  </mesh>
                ))}
                <mesh material={side === 1 ? m.cableA : m.cableB} position={[-0.06, 0.045, 0]}>
                  <boxGeometry args={[0.16, 0.05, len]} />
                </mesh>
                <mesh material={m.cableB} position={[0.11, 0.035, 0]}>
                  <boxGeometry args={[0.1, 0.035, len]} />
                </mesh>
              </group>
            ))}
            {/* 冷通道燈條 */}
            {[-0.45, 0.45].map((dx) => (
              <mesh key={dx} material={m.strip} position={[ax + dx, 3.4, zc]}>
                <boxGeometry args={[0.07, 0.03, len - 0.6]} />
              </mesh>
            ))}
            {/* 冷通道封閉：頂部玻璃與入口門框 */}
            <mesh material={m.glass} position={[ax, RACK_H + 0.12, zc]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[2 * FRONT_X, len]} />
            </mesh>
            {[-1, 1].map((side) => (
              <mesh key={side} material={m.frame} position={[ax + side * (FRONT_X - 0.03), (RACK_H + 0.14) / 2, 0.62]}>
                <boxGeometry args={[0.06, RACK_H + 0.14, 0.08]} />
              </mesh>
            ))}
            <mesh material={m.frame} position={[ax, RACK_H + 0.14, 0.62]}>
              <boxGeometry args={[2 * FRONT_X, 0.1, 0.1]} />
            </mesh>
            <mesh material={m.header} position={[ax, RACK_H + 0.085, 0.675]}>
              <boxGeometry args={[2 * FRONT_X - 0.3, 0.012, 0.01]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
};

// ---------------- 封包 ----------------

const N_PK = 9;
const Packets: React.FC<{frame: number; T: Act2Times}> = ({frame, T}) => {
  const body = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const m = useMemo(
    () => ({
      body: new THREE.MeshBasicMaterial({toneMapped: false}),
      head: new THREE.MeshBasicMaterial({toneMapped: false}),
    }),
    [],
  );
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    for (let k = 0; k < N_PK * 2; k++) {
      const isAns = k >= N_PK;
      const i = k % N_PK;
      const {p, o: op} = isAns ? answerPos3D(T, frame, i) : packetPos3D(T, frame, i);
      const s = (isAns ? 0.2 + 0.5 * clamp(p.y / 12) : 0.085) * clamp(op);
      o.position.copy(p);
      o.rotation.set(0, isAns ? 0 : 0, 0);
      o.lookAt(p.clone().add(new THREE.Vector3(isAns ? 0 : -0.6, isAns ? -1 : 0, isAns ? 0 : 1)));
      o.scale.set(s + 1e-5, s + 1e-5, 0.02);
      o.updateMatrix();
      body.current!.setMatrixAt(k, o.matrix);
      c.set(isAns ? P.ice : P.amber);
      body.current!.setColorAt(k, c);
      // 標頭條（沿本地 y 上方）
      o.translateY(s * 0.38);
      o.scale.set(s + 1e-5, s * 0.24 + 1e-5, 0.024);
      o.updateMatrix();
      head.current!.setMatrixAt(k, o.matrix);
      c.set(isAns ? P.amber : P.ice);
      head.current!.setColorAt(k, c);
    }
    for (const r of [body, head]) {
      r.current!.instanceMatrix.needsUpdate = true;
      if (r.current!.instanceColor) r.current!.instanceColor.needsUpdate = true;
    }
  }, [frame, T]);
  return (
    <group>
      <instancedMesh ref={body} args={[undefined, undefined, N_PK * 2]} material={m.body}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, N_PK * 2]} material={m.head}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </group>
  );
};

export const lerpV = (a: THREE.Vector3, b: THREE.Vector3, t: number) => new THREE.Vector3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
