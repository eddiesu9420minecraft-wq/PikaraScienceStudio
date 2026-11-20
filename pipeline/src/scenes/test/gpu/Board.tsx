import React, {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {palette as P} from '../../../theme/palette';
import {progress} from '../../../lib/anim';
import {SHOT} from '../shots';
import {DIE_POS} from '../gpuRig';
import {
  BIOS,
  CAPS,
  CHOKES,
  CONTROLLER,
  DIE_BASE,
  DIE_H,
  DIE_SIZE,
  DISPLAY_PORTS,
  MEM_CHOKES,
  PASSIVES,
  Passive,
  PCB_D,
  PCB_T,
  PCB_TOP,
  PCB_W,
  PCIE,
  POWER_CONN,
  POWER_STAGES,
  STIFF_IN,
  STIFF_OUT,
  SUB_SIZE,
  SUB_TOP,
  VRAM,
  VRAM_D,
  VRAM_H,
  VRAM_W,
} from './layout';
import {brushedTexture, chokeTexture, controllerTexture, dieTextures, pcbTextures, vramTexture} from './textures';

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);

/** 依名稱產生一次性的材質集合（每次掛載一份）。 */
const useBoardMaterials = () =>
  useMemo(() => {
    const pcbT = pcbTextures();
    const dieT = dieTextures();
    const brushed = brushedTexture('backplate', 4410, 0.55, 0.25);
    brushed.repeat.set(0.6, 3);
    const edge = std({color: '#1F2A23', roughness: 0.75, metalness: 0});
    // Solder mask: very dark albedo, so keep its specular low or broad key-light highlights wash it to grey.
    const pcbTop = new THREE.MeshPhysicalMaterial({
      map: pcbT.map,
      roughnessMap: pcbT.roughnessMap,
      metalnessMap: pcbT.metalnessMap,
      bumpMap: pcbT.bumpMap,
      bumpScale: 0.8,
      roughness: 1.2,
      metalness: 1,
      specularIntensity: 0.16,
      envMapIntensity: 0.5,
    });
    const pcbPlain = std({color: '#0D241D', roughness: 0.55, metalness: 0});
    const dieTop = new THREE.MeshPhysicalMaterial({
      map: dieT.map,
      roughnessMap: dieT.roughnessMap,
      roughness: 0.6,
      metalness: 0.15,
      clearcoat: 0.7,
      clearcoatRoughness: 0.12,
      iridescence: 0.35,
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [240, 420],
      envMapIntensity: 0.38,
    });
    const dieSide = std({color: '#2A3140', roughness: 0.3, metalness: 0.6});
    const vramTop = std({map: vramTexture(), roughness: 0.62, metalness: 0.05});
    const epoxy = std({color: '#121419', roughness: 0.6, metalness: 0.05});
    const chokeTop = std({map: chokeTexture(), roughness: 0.55, metalness: 0.35});
    const choke = std({color: '#3B3F47', roughness: 0.55, metalness: 0.35});
    const ctrlTop = std({map: controllerTexture(), roughness: 0.55, metalness: 0.05});
    return {
      pcb: [edge, edge, pcbTop, pcbPlain, edge, edge],
      pcbPlain,
      edge,
      gold: std({color: P.gold, roughness: 0.22, metalness: 1}),
      steel: new THREE.MeshPhysicalMaterial({color: '#C2C8D2', roughness: 0.32, metalness: 1, roughnessMap: brushed}),
      portShell: std({color: '#A7AEB8', roughness: 0.3, metalness: 1}),
      portInner: std({color: '#0B0D11', roughness: 0.7, metalness: 0}),
      substrate: new THREE.MeshPhysicalMaterial({color: '#1E231B', roughness: 0.6, metalness: 0, specularIntensity: 0.25, envMapIntensity: 0.4}),
      underfill: std({color: '#15161A', roughness: 0.5, metalness: 0}),
      stiffener: std({color: '#454A52', roughness: 0.5, metalness: 1, envMapIntensity: 0.4}),
      die: [dieSide, dieSide, dieTop, dieSide, dieSide, dieSide],
      vram: [epoxy, epoxy, vramTop, epoxy, epoxy, epoxy],
      powerStage: std({color: '#16181D', roughness: 0.45, metalness: 0.1}),
      powerPad: std({color: '#9DA3AC', roughness: 0.3, metalness: 1}),
      choke: [choke, choke, chokeTop, choke, choke, choke],
      ctrl: [epoxy, epoxy, ctrlTop, epoxy, epoxy, epoxy],
      capCan: std({color: '#AEB4BE', roughness: 0.28, metalness: 1}),
      capSleeve: std({color: '#2A2238', roughness: 0.45, metalness: 0.1}),
      capVent: std({color: '#5E646E', roughness: 0.4, metalness: 1}),
      plastic: std({color: '#121317', roughness: 0.62, metalness: 0}),
      backplate: new THREE.MeshPhysicalMaterial({
        color: '#2B313D',
        roughness: 0.62,
        roughnessMap: brushed,
        metalness: 0.85,
        clearcoat: 0.35,
        clearcoatRoughness: 0.25,
      }),
      screw: std({color: '#2E333D', roughness: 0.3, metalness: 1}),
      accent: new THREE.MeshStandardMaterial({color: P.amber, emissive: P.amber, emissiveIntensity: 0.55, roughness: 0.4}),
    };
  }, []);

// ---------------- 被動元件（instanced：本體 + 兩端電極） ----------------

const Passives: React.FC<{items: Passive[]; y: number; scale?: number}> = ({items, y, scale = 1}) => {
  const body = useRef<THREE.InstancedMesh>(null);
  const term = useRef<THREE.InstancedMesh>(null);
  const mats = useMemo(
    () => ({
      body: std({roughness: 0.55, metalness: 0}),
      term: std({color: '#C6CBD2', roughness: 0.25, metalness: 1}),
    }),
    [],
  );
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    items.forEach((p, i) => {
      const h = p.w * 0.75 * scale;
      o.position.set(p.x, y + h / 2, p.z);
      o.rotation.set(0, p.rot, 0);
      o.scale.set(p.l * 0.62 * scale, h * 1.02, p.w * scale);
      o.updateMatrix();
      body.current!.setMatrixAt(i, o.matrix);
      // 陶瓷電容（棕褐）／電阻（黑）
      c.set(p.tone > 0.72 ? '#16171B' : p.tone > 0.36 ? '#8A6C4C' : '#A3865F');
      body.current!.setColorAt(i, c);
      o.scale.set(p.l * scale, h * 0.96, p.w * 0.94 * scale);
      o.updateMatrix();
      term.current!.setMatrixAt(i, o.matrix);
    });
    body.current!.instanceMatrix.needsUpdate = true;
    term.current!.instanceMatrix.needsUpdate = true;
    if (body.current!.instanceColor) body.current!.instanceColor.needsUpdate = true;
  }, [items, y, scale]);
  return (
    <>
      <instancedMesh ref={body} args={[undefined, mats.body, items.length]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={term} args={[undefined, mats.term, items.length]} receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </>
  );
};

// 封裝基板上的去耦電容（晶粒四周兩圈）
const SUBSTRATE_CAPS: Passive[] = (() => {
  const out: Passive[] = [];
  for (const rr of [DIE_SIZE / 2 + 0.017, DIE_SIZE / 2 + 0.034]) {
    for (let k = -9; k <= 9; k++) {
      const t = k * 0.0165;
      if (Math.abs(t) > rr - 0.01) continue;
      out.push({x: DIE_POS.x + t, z: DIE_POS.z - rr, rot: Math.PI / 2, l: 0.01, w: 0.005, tone: 0.5});
      out.push({x: DIE_POS.x + t, z: DIE_POS.z + rr, rot: Math.PI / 2, l: 0.01, w: 0.005, tone: 0.5});
      out.push({x: DIE_POS.x - rr, z: DIE_POS.z + t, rot: 0, l: 0.01, w: 0.005, tone: 0.5});
      out.push({x: DIE_POS.x + rr, z: DIE_POS.z + t, rot: 0, l: 0.01, w: 0.005, tone: 0.5});
    }
  }
  return out;
})();

// ---------------- 金手指 ----------------

const PcieFingers: React.FC<{material: THREE.Material}> = ({material}) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const xs = useMemo(() => {
    const out: number[] = [];
    for (let x = PCIE.x0 + 0.012; x < PCIE.x1 - 0.008; x += 0.01) {
      if (Math.abs(x - PCIE.notchX) < 0.014) continue;
      out.push(x);
    }
    return out;
  }, []);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    let i = 0;
    for (const side of [1, -1]) {
      for (const x of xs) {
        const long = Math.round((x - PCIE.x0) / 0.01) % 4 === 0;
        const len = long ? 0.07 : 0.062;
        o.position.set(x, side * (PCB_T / 2 + 0.0006), PCIE.z1 - 0.008 - len / 2);
        o.scale.set(0.0062, 0.0012, len);
        o.updateMatrix();
        ref.current!.setMatrixAt(i++, o.matrix);
      }
    }
    ref.current!.instanceMatrix.needsUpdate = true;
  }, [xs]);
  return (
    <instancedMesh ref={ref} args={[undefined, material, xs.length * 2]} receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
};

// ---------------- I/O 擋板（不鏽鋼，含端子開孔與散熱孔） ----------------

const useBracketGeometry = () =>
  useMemo(() => {
    const s = new THREE.Shape();
    const z0 = -0.6;
    const z1 = 0.6;
    const y0 = -0.06;
    const y1 = 0.48;
    s.moveTo(z0, y0);
    s.lineTo(z1, y0);
    s.lineTo(z1, y1);
    s.lineTo(z0, y1);
    s.closePath();
    const rr = (cx: number, cy: number, w: number, h: number, r: number) => {
      const p = new THREE.Path();
      p.moveTo(cx - w / 2 + r, cy - h / 2);
      p.lineTo(cx + w / 2 - r, cy - h / 2);
      p.quadraticCurveTo(cx + w / 2, cy - h / 2, cx + w / 2, cy - h / 2 + r);
      p.lineTo(cx + w / 2, cy + h / 2 - r);
      p.quadraticCurveTo(cx + w / 2, cy + h / 2, cx + w / 2 - r, cy + h / 2);
      p.lineTo(cx - w / 2 + r, cy + h / 2);
      p.quadraticCurveTo(cx - w / 2, cy + h / 2, cx - w / 2, cy + h / 2 - r);
      p.lineTo(cx - w / 2, cy - h / 2 + r);
      p.quadraticCurveTo(cx - w / 2, cy - h / 2, cx - w / 2 + r, cy - h / 2);
      s.holes.push(p);
    };
    for (const z of DISPLAY_PORTS) rr(z, 0.05, 0.15, 0.05, 0.008);
    // 散熱孔（長條）
    for (let row = 0; row < 6; row++) {
      for (let k = 0; k < 5; k++) {
        const z = -0.44 + k * 0.22 + (row % 2 ? 0.11 : 0);
        if (z > 0.5) continue;
        rr(z, 0.15 + row * 0.052, 0.17, 0.022, 0.011);
      }
    }
    const g = new THREE.ExtrudeGeometry(s, {depth: 0.008, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1, curveSegments: 6});
    g.rotateY(-Math.PI / 2);
    return g;
  }, []);

// ---------------- 背板 ----------------

const useBackplateGeometry = () =>
  useMemo(() => {
    const w = PCB_W / 2 + 0.01;
    const h = PCB_D / 2 + 0.005;
    const c = 0.05;
    const s = new THREE.Shape();
    s.moveTo(-w, -h);
    s.lineTo(w - c, -h);
    s.lineTo(w, -h + c);
    s.lineTo(w, h);
    s.lineTo(-w, h);
    s.closePath();
    // 尾端穿透式散熱開口（flow-through）
    const hole = new THREE.Path();
    hole.moveTo(0.92, -0.42);
    hole.lineTo(1.36, -0.42);
    hole.lineTo(1.36, 0.38);
    hole.lineTo(0.92, 0.38);
    hole.closePath();
    s.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(s, {depth: 0.006, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 2, curveSegments: 4});
    g.rotateX(Math.PI / 2); // 形狀 y → +z，擠出方向 → -y
    return g;
  }, []);

// ---------------- 資料脈衝（VRAM → GPU，沿高亮走線） ----------------

const streakTexture = (() => {
  let t: THREE.CanvasTexture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 16;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 128, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.8, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 16);
    const v = g.createLinearGradient(0, 0, 0, 16);
    v.addColorStop(0, 'rgba(0,0,0,1)');
    v.addColorStop(0.5, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = v;
    g.fillRect(0, 0, 128, 16);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
})();

const Pulses: React.FC<{frame: number}> = ({frame}) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const COUNT = VRAM.length * 3 * 2;
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({map: streakTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false}),
    [],
  );
  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const on = progress(frame, SHOT.pulseStart, SHOT.pulseStart + 20) * (1 - progress(frame, SHOT.matrixStart + 30, SHOT.matrixStart + 60));
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    const ice = new THREE.Color(P.ice);
    let i = 0;
    VRAM.forEach((v, k) => {
      const dist = Math.hypot(v.dx, v.dz);
      const ux = -v.dx / dist;
      const uz = -v.dz / dist;
      const nx = -uz;
      const nz = ux;
      const len = dist * 0.7 - 0.05;
      const ang = Math.atan2(uz, ux);
      for (let lane = 0; lane < 3; lane++) {
        for (let rep = 0; rep < 2; rep++) {
          const t = ((((frame - SHOT.pulseStart) / 30 + k * 0.137 + lane * 0.29 + rep * 0.5) % 1) + 1) % 1;
          const fade = Math.sin(Math.PI * t);
          const s = 0.045 + 0.02 * fade;
          const d = 0.05 + t * len;
          const off = (lane - 1) * 0.025;
          o.position.set(v.x + ux * d + nx * off, PCB_TOP + 0.0012, v.z + uz * d + nz * off);
          o.rotation.set(0, -ang, 0);
          o.scale.set(s, 1, 0.0075);
          o.updateMatrix();
          ref.current!.setMatrixAt(i, o.matrix);
          c.copy(ice).multiplyScalar(on * fade * 1.6);
          ref.current!.setColorAt(i, c);
          i++;
        }
      }
    });
    ref.current!.instanceMatrix.needsUpdate = true;
    if (ref.current!.instanceColor) ref.current!.instanceColor.needsUpdate = true;
  }, [frame, on]);
  return <instancedMesh ref={ref} args={[geo, material, COUNT]} visible={on > 0.001} renderOrder={5} frustumCulled={false} />;
};

// ---------------- 主機板 ----------------

export const Board: React.FC<{frame: number}> = ({frame}) => {
  const m = useBoardMaterials();
  const bracket = useBracketGeometry();
  const backplate = useBackplateGeometry();
  const rounded = useMemo(
    () => ({
      vram: new RoundedBoxGeometry(VRAM_W, VRAM_H, VRAM_D, 2, 0.002),
      choke: new RoundedBoxGeometry(0.08, 0.055, 0.08, 2, 0.006),
      stage: new RoundedBoxGeometry(0.06, 0.011, 0.05, 1, 0.0015),
    }),
    [],
  );
  const stiffener = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-STIFF_OUT, -STIFF_OUT);
    s.lineTo(STIFF_OUT, -STIFF_OUT);
    s.lineTo(STIFF_OUT, STIFF_OUT);
    s.lineTo(-STIFF_OUT, STIFF_OUT);
    s.closePath();
    const h = new THREE.Path();
    h.moveTo(-STIFF_IN, -STIFF_IN);
    h.lineTo(-STIFF_IN, STIFF_IN);
    h.lineTo(STIFF_IN, STIFF_IN);
    h.lineTo(STIFF_IN, -STIFF_IN);
    h.closePath();
    s.holes.push(h);
    const g = new THREE.ExtrudeGeometry(s, {depth: 0.004, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1});
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  const tabW1 = PCIE.notchX - 0.012 - PCIE.x0;
  const tabW2 = PCIE.x1 - (PCIE.notchX + 0.012);
  const tabD = PCIE.z1 - PCIE.z0;

  return (
    <group>
      {/* PCB 本體 */}
      <mesh material={m.pcb} castShadow receiveShadow>
        <boxGeometry args={[PCB_W, PCB_T, PCB_D]} />
      </mesh>
      {/* PCIe 板舌 + 金手指 */}
      <mesh material={m.pcbPlain} position={[PCIE.x0 + tabW1 / 2, 0, PCIE.z0 + tabD / 2 - 0.001]} receiveShadow>
        <boxGeometry args={[tabW1, PCB_T, tabD]} />
      </mesh>
      <mesh material={m.pcbPlain} position={[PCIE.x1 - tabW2 / 2, 0, PCIE.z0 + tabD / 2 - 0.001]} receiveShadow>
        <boxGeometry args={[tabW2, PCB_T, tabD]} />
      </mesh>
      <mesh material={m.pcbPlain} position={[PCIE.notchX, 0, PCIE.z0 + 0.012]}>
        <boxGeometry args={[0.024, PCB_T, 0.026]} />
      </mesh>
      <PcieFingers material={m.gold} />

      {/* I/O 擋板與輸出端子 */}
      <mesh geometry={bracket} material={m.steel} position={[-1.515, 0, 0]} castShadow receiveShadow />
      {DISPLAY_PORTS.map((z) => (
        <group key={z} position={[-1.43, PCB_TOP + 0.028, z]}>
          <mesh material={m.portShell} castShadow receiveShadow>
            <boxGeometry args={[0.16, 0.052, 0.155]} />
          </mesh>
          <mesh material={m.portInner} position={[-0.0805, 0, 0]}>
            <boxGeometry args={[0.002, 0.036, 0.13]} />
          </mesh>
        </group>
      ))}

      {/* GPU 封裝：基板 → 加強框 → 底填 → 晶粒 */}
      <mesh material={m.substrate} position={[DIE_POS.x, (PCB_TOP + SUB_TOP) / 2, DIE_POS.z]} castShadow receiveShadow>
        <boxGeometry args={[SUB_SIZE, SUB_TOP - PCB_TOP, SUB_SIZE]} />
      </mesh>
      <mesh geometry={stiffener} material={m.stiffener} position={[DIE_POS.x, SUB_TOP, DIE_POS.z]} castShadow receiveShadow />
      <mesh material={m.underfill} position={[DIE_POS.x, SUB_TOP + 0.0015, DIE_POS.z]}>
        <boxGeometry args={[DIE_SIZE + 0.01, 0.003, DIE_SIZE + 0.01]} />
      </mesh>
      <mesh material={m.die} position={[DIE_POS.x, DIE_BASE + DIE_H / 2, DIE_POS.z]} castShadow receiveShadow>
        <boxGeometry args={[DIE_SIZE, DIE_H, DIE_SIZE]} />
      </mesh>
      <Passives items={SUBSTRATE_CAPS} y={SUB_TOP} scale={1} />

      {/* VRAM */}
      {VRAM.map((v, k) => (
        <mesh key={k} geometry={rounded.vram} material={m.vram} position={[v.x, PCB_TOP + VRAM_H / 2, v.z]} castShadow receiveShadow />
      ))}

      {/* 供電：DrMOS、電感、固態電容、控制器 */}
      {POWER_STAGES.map((p, i) => (
        <group key={i} position={[p.x, PCB_TOP, p.z]}>
          <mesh geometry={rounded.stage} material={m.powerStage} position={[0, 0.0055, 0]} castShadow receiveShadow />
          <mesh material={m.powerPad} position={[0, 0.0112, -0.008]}>
            <boxGeometry args={[0.03, 0.0008, 0.02]} />
          </mesh>
        </group>
      ))}
      {[...CHOKES, ...MEM_CHOKES].map((p, i) => (
        <mesh key={i} geometry={rounded.choke} material={m.choke} position={[p.x, PCB_TOP + 0.0275, p.z]} castShadow receiveShadow />
      ))}
      {CAPS.map((c, i) => (
        <group key={i} position={[c.x, PCB_TOP, c.z]}>
          <mesh material={m.capSleeve} position={[0, 0.008, 0]} castShadow>
            <cylinderGeometry args={[c.r * 1.02, c.r * 1.02, 0.016, 32]} />
          </mesh>
          <mesh material={m.capCan} position={[0, c.h / 2 + 0.008, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[c.r, c.r, c.h - 0.016, 32]} />
          </mesh>
          <mesh material={m.capVent} position={[0, c.h + 0.0002, 0]}>
            <boxGeometry args={[c.r * 1.3, 0.001, 0.0035]} />
          </mesh>
          <mesh material={m.capVent} position={[0, c.h + 0.0002, 0]}>
            <boxGeometry args={[0.0035, 0.001, c.r * 1.3]} />
          </mesh>
        </group>
      ))}
      <mesh material={m.ctrl} position={[CONTROLLER.x, PCB_TOP + 0.004, CONTROLLER.z]} castShadow receiveShadow>
        <boxGeometry args={[CONTROLLER.w, 0.008, CONTROLLER.d]} />
      </mesh>
      <mesh material={m.ctrl} position={[BIOS.x, PCB_TOP + 0.005, BIOS.z]} castShadow receiveShadow>
        <boxGeometry args={[BIOS.w, 0.01, BIOS.d]} />
      </mesh>

      {/* 12V-2x6 電源接頭 */}
      <group position={[POWER_CONN.x, PCB_TOP + POWER_CONN.h / 2, POWER_CONN.z]}>
        <mesh material={m.plastic} castShadow receiveShadow>
          <boxGeometry args={[POWER_CONN.w, POWER_CONN.h, POWER_CONN.d]} />
        </mesh>
        {Array.from({length: 12}).map((_, i) => (
          <mesh key={i} material={m.portInner} position={[-0.075 + (i % 6) * 0.03, -0.012 + Math.floor(i / 6) * 0.03, -POWER_CONN.d / 2 - 0.0005]}>
            <boxGeometry args={[0.02, 0.02, 0.002]} />
          </mesh>
        ))}
      </group>

      <Passives items={PASSIVES} y={PCB_TOP} />

      {/* 背板 */}
      <mesh geometry={backplate} material={m.backplate} position={[0, -PCB_T / 2 - 0.004, 0]} castShadow receiveShadow />
      <mesh material={m.accent} position={[0.1, -PCB_T / 2 - 0.0135, PCB_D / 2 - 0.03]}>
        <boxGeometry args={[2.2, 0.0012, 0.004]} />
      </mesh>
      {[
        [DIE_POS.x - 0.29, DIE_POS.z - 0.29],
        [DIE_POS.x + 0.29, DIE_POS.z - 0.29],
        [DIE_POS.x - 0.29, DIE_POS.z + 0.29],
        [DIE_POS.x + 0.29, DIE_POS.z + 0.29],
        [-1.3, -0.48],
        [-1.3, 0.48],
        [0.6, -0.5],
        [0.6, 0.5],
      ].map(([x, z], i) => (
        <mesh key={i} material={m.screw} position={[x, -PCB_T / 2 - 0.016, z]}>
          <cylinderGeometry args={[0.018, 0.018, 0.006, 24]} />
        </mesh>
      ))}

      <Pulses frame={frame} />
    </group>
  );
};
