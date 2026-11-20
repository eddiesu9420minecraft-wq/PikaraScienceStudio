import React, {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {palette as P} from '../../theme/palette';
import {ease, progress, tween} from '../../lib/anim';
import type {A5} from './timing';
import {CMD_PARTS, TERM, TERM_BAR, TERM_BAR_BG, TERM_BG, TERM_FONT, TERM_PAD} from './term';
import {
  BOARD,
  BoardRig,
  boardTimes,
  CASE,
  CPU_DIE,
  CPU_POS,
  CPU_SUB,
  DIMM_SIZE,
  DIMM_Y,
  DIMMS,
  FAN_R,
  FANS,
  GDDR,
  GDDR_SIZE,
  GPU_DIE,
  GPU_POS,
  GPU_SUB,
  HINGE,
  LID_OPEN,
  N_CPU,
  N_LAYERS,
  SCREEN,
  slabState,
  SLAB,
  SMD,
  SSD_POS,
  SSD_SIZE,
  SSD_Y,
  STREAM_CURVE,
  Times,
  TRACES,
  V,
} from './board';

const mat = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
const fade = (ms: THREE.Material[], o: number) => {
  for (const m of ms) {
    m.transparent = o < 0.999;
    m.opacity = o;
    m.depthWrite = o > 0.95;
  }
};

export const BoardWorld: React.FC<{f: number; a: A5; rig: BoardRig}> = ({f, a, rig}) => {
  const T = useMemo(() => boardTimes(a), [a]);
  return (
    <ThreeCanvas
      width={1920}
      height={1080}
      shadows
      gl={{antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: true}}
      style={{position: 'absolute', inset: 0}}
    >
      <SceneSetup />
      <CameraDriver f={f} rig={rig} />
      <Lights />
      <Laptop f={f} T={T} />
      <Mainboard f={f} a={a} T={T} />
      <Cooling f={f} T={T} />
      <Stream f={f} T={T} />
      <Slabs f={f} a={a} T={T} />
    </ThreeCanvas>
  );
};

const SceneSetup: React.FC = () => {
  const {gl, scene} = useThree();
  useLayoutEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.2;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.5;
    scene.background = new THREE.Color(P.ink);
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
};

const CameraDriver: React.FC<{f: number; rig: BoardRig}> = ({f, rig}) => {
  const {camera, size} = useThree();
  useLayoutEffect(() => {
    const s = rig(f);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = s.fov;
    cam.aspect = size.width / size.height;
    cam.near = 0.01;
    cam.far = 80;
    cam.position.copy(s.pos);
    cam.lookAt(s.target);
    cam.updateProjectionMatrix();
  }, [f, camera, size, rig]);
  return null;
};

const Lights: React.FC = () => (
  <>
    <hemisphereLight args={['#B8C8EA', '#1A2133', 0.55]} />
    <directionalLight
      position={[3.2, 6.5, 4.2]}
      intensity={2.6}
      color="#FFF1DE"
      castShadow
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-camera-left={-3}
      shadow-camera-right={3}
      shadow-camera-top={3}
      shadow-camera-bottom={-3}
      shadow-camera-near={0.5}
      shadow-camera-far={20}
      shadow-bias={-0.0004}
    />
    <directionalLight position={[-5, 2.5, -4]} intensity={2.0} color={P.ice} />
    <directionalLight position={[0, 4, 7]} intensity={0.8} color="#DDE6FF" />
    <pointLight position={[0, 1.6, 1.2]} intensity={1.2} distance={6} color="#FFC98A" />
  </>
);

// ---------------- 筆電外殼 ----------------

const drawTerminal = (ctx: CanvasRenderingContext2D, W: number) => {
  const s = W / 1920;
  const H = 1080 * s;
  ctx.fillStyle = P.ink;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, W * 0.55);
  g.addColorStop(0, 'rgba(28,39,64,0.55)');
  g.addColorStop(1, 'rgba(9,13,24,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const x = TERM.x * s;
  const y = TERM.y * s;
  const w = TERM.w * s;
  const h = TERM.h * s;
  const r = 14 * s;
  const rr = () => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  rr();
  ctx.fillStyle = TERM_BG;
  ctx.fill();
  ctx.save();
  rr();
  ctx.clip();
  ctx.fillStyle = TERM_BAR_BG;
  ctx.fillRect(x, y, w, TERM_BAR * s);
  ctx.restore();
  rr();
  ctx.strokeStyle = P.line;
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x + (26 + i * 24) * s, y + (TERM_BAR / 2) * s, 6 * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(138,151,180,0.45)';
    ctx.fill();
  }
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${18 * s}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = P.mist;
  ctx.textAlign = 'center';
  ctx.fillText('terminal', x + w / 2, y + (TERM_BAR / 2 + 6) * s);
  ctx.textAlign = 'left';
  ctx.font = `500 ${TERM_FONT * s}px "Cascadia Mono", Consolas, monospace`;
  let tx = x + TERM_PAD * s;
  const ty = y + (TERM_BAR + 64) * s;
  ctx.fillStyle = P.mist;
  ctx.fillText('$ ', tx, ty);
  tx += ctx.measureText('$ ').width;
  for (const p of CMD_PARTS) {
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, tx, ty);
    tx += ctx.measureText(p.text).width;
  }
  ctx.fillStyle = P.mist;
  ctx.fillText('> ', x + TERM_PAD * s, ty + 64 * s);
  ctx.fillStyle = P.paper;
  ctx.fillRect(x + TERM_PAD * s + ctx.measureText('> ').width, ty + 64 * s - 28 * s, 18 * s, 36 * s);
};

const Laptop: React.FC<{f: number; T: Times}> = ({f, T}) => {
  const e = ease.inOut(progress(f, T.explodeStart, T.explodeEnd));
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    drawTerminal(c.getContext('2d')!, 1920);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, []);
  const m = useMemo(
    () => ({
      alu: mat({color: '#8E96A6', roughness: 0.36, metalness: 0.85}),
      aluTop: mat({color: '#8E96A6', roughness: 0.36, metalness: 0.85}),
      aluLid: mat({color: '#8A92A2', roughness: 0.34, metalness: 0.85}),
      key: mat({color: '#1A1E28', roughness: 0.6, metalness: 0.1}),
      pad: mat({color: '#7D8596', roughness: 0.22, metalness: 0.7}),
      bezel: mat({color: '#0B0E15', roughness: 0.3, metalness: 0.2}),
      screen: new THREE.MeshBasicMaterial({map: tex, toneMapped: false}),
      inner: mat({color: '#2A303D', roughness: 0.6, metalness: 0.5}),
    }),
    [tex],
  );
  const deckO = 1 - e;
  fade([m.aluTop, m.key, m.pad], deckO);
  fade([m.aluLid, m.bezel, m.screen], 1 - ease.inOut(progress(f, T.explodeStart, T.explodeStart + 50)));
  const keysRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    let k = 0;
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 15; c++) {
        o.position.set(-1.47 + c * 0.21, 0.165, -0.95 + r * 0.2);
        o.scale.set(r === 5 && c > 4 && c < 10 ? (c === 7 ? 1 : 1) : 1, 1, 1);
        o.updateMatrix();
        keysRef.current!.setMatrixAt(k++, o.matrix);
      }
    keysRef.current!.instanceMatrix.needsUpdate = true;
  }, []);
  const lidAngle = LID_OPEN;
  return (
    <group>
      {/* 底殼（托盤） */}
      <mesh material={m.alu} position={[0, -0.16, 0]} receiveShadow castShadow>
        <boxGeometry args={[CASE.w, 0.02, CASE.d]} />
      </mesh>
      <mesh material={m.inner} position={[0, -0.148, 0]} receiveShadow>
        <boxGeometry args={[CASE.w - 0.1, 0.004, CASE.d - 0.1]} />
      </mesh>
      {[
        [0, CASE.d / 2 - 0.015, CASE.w, 0.03],
        [0, -CASE.d / 2 + 0.015, CASE.w, 0.03],
      ].map(([x, z, w, d], i) => (
        <mesh key={i} material={m.alu} position={[x, -0.02, z]} castShadow receiveShadow>
          <boxGeometry args={[w, 0.29, d]} />
        </mesh>
      ))}
      {[CASE.w / 2 - 0.015, -CASE.w / 2 + 0.015].map((x) => (
        <mesh key={x} material={m.alu} position={[x, -0.02, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.03, 0.29, CASE.d]} />
        </mesh>
      ))}
      {/* 鍵盤面 */}
      <group position={[0, e * 1.6, e * -0.2]} visible={deckO > 0.01}>
        <mesh material={m.aluTop} position={[0, 0.14, 0]} castShadow receiveShadow>
          <boxGeometry args={[CASE.w, 0.03, CASE.d]} />
        </mesh>
        <instancedMesh ref={keysRef} args={[undefined, undefined, 90]} material={m.key} castShadow>
          <boxGeometry args={[0.18, 0.02, 0.17]} />
        </instancedMesh>
        <mesh material={m.pad} position={[0, 0.157, 0.78]}>
          <boxGeometry args={[1.2, 0.004, 0.62]} />
        </mesh>
      </group>
      {/* 螢幕 */}
      <group position={[HINGE.x, HINGE.y + e * 2.2, HINGE.z - e * 0.6]} rotation={[-lidAngle, 0, 0]} visible={m.screen.opacity > 0.01}>
        <mesh material={m.aluLid} position={[0, 0, 1.225]} castShadow>
          <boxGeometry args={[CASE.w, 0.03, 2.45]} />
        </mesh>
        <mesh material={m.bezel} position={[0, -0.0162, 1.225]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[CASE.w - 0.08, 2.38]} />
        </mesh>
        <mesh material={m.screen} position={[0, -0.0172, SCREEN.z]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[SCREEN.w, SCREEN.h]} />
        </mesh>
      </group>
    </group>
  );
};

// ---------------- 主機板 ----------------

const Mainboard: React.FC<{f: number; a: A5; T: Times}> = ({f, a, T}) => {
  const m = useMemo(
    () => ({
      pcb: mat({color: '#163A30', roughness: 0.62, metalness: 0.08}),
      pcbEdge: mat({color: '#0F241E', roughness: 0.7, metalness: 0.05}),
      sub: mat({color: '#24463A', roughness: 0.5, metalness: 0.2}),
      cpuDie: mat({color: '#323C55', roughness: 0.22, metalness: 0.6, emissive: P.amber, emissiveIntensity: 0}),
      gpuDie: mat({color: '#323C55', roughness: 0.22, metalness: 0.6, emissive: P.amber, emissiveIntensity: 0}),
      chip: mat({color: '#17191F', roughness: 0.42, metalness: 0.3}),
      gddr: mat({color: '#17191F', roughness: 0.42, metalness: 0.3, emissive: P.amber, emissiveIntensity: 0}),
      dram: mat({color: '#17191F', roughness: 0.42, metalness: 0.3, emissive: P.amber, emissiveIntensity: 0}),
      nand: mat({color: '#17191F', roughness: 0.42, metalness: 0.3, emissive: P.amber, emissiveIntensity: 0}),
      ctrl: mat({color: '#3A4152', roughness: 0.3, metalness: 0.75}),
      dimm: mat({color: '#1C5442', roughness: 0.55, metalness: 0.1}),
      ssd: mat({color: '#1A2A3E', roughness: 0.55, metalness: 0.1}),
      gold: mat({color: P.gold, roughness: 0.22, metalness: 1}),
      socket: mat({color: '#1A1C22', roughness: 0.55, metalness: 0.1}),
      steel: mat({color: '#B4BBC8', roughness: 0.28, metalness: 0.9}),
      choke: mat({color: '#545B6A', roughness: 0.42, metalness: 0.55}),
      smdLight: mat({color: '#B49A70', roughness: 0.5, metalness: 0.3}),
      smdDark: mat({color: '#22252D', roughness: 0.5, metalness: 0.3}),
      trace: mat({color: P.copper, roughness: 0.35, metalness: 0.85, transparent: true, opacity: 0.6}),
      cap: mat({color: '#8C93A3', roughness: 0.3, metalness: 0.8}),
    }),
    [],
  );
  // 狀態光
  const cpuGlow = progress(f, a.cpulayers - 12, a.cpulayers + 20) * (1 - progress(f, a.why + 10, a.why + 50));
  const gpuGlow = progress(f, a.gpulayers - 12, a.gpulayers + 20) * (1 - progress(f, a.why + 10, a.why + 50));
  m.cpuDie.emissiveIntensity = cpuGlow * (0.55 + 0.25 * Math.sin(f * 0.25));
  m.gpuDie.emissiveIntensity = gpuGlow * (0.6 + 0.25 * Math.sin(f * 0.3));
  m.nand.emissiveIntensity = progress(f, a.ssd - 10, a.ssd + 20) * (1 - progress(f, T.streamEnd - 30, T.streamEnd)) * (0.35 + 0.25 * Math.max(0, Math.sin(f * 0.4)));
  m.dram.emissiveIntensity = 0.38 * progress(f, a.load - 10, a.load + 90) * (1 - 0.6 * progress(f, a.offload - 40, a.offload + 40));
  m.gddr.emissiveIntensity = 0.32 * progress(f, T.nglStart + 30, T.nglEnd + 40) * (1 - progress(f, a.why + 10, a.why + 50));

  const boardGeo = useMemo(() => {
    const s = new THREE.Shape();
    const w = BOARD.w / 2;
    const d = BOARD.d / 2;
    const c = 0.06;
    s.moveTo(-w + c, -d);
    s.lineTo(w - c, -d);
    s.quadraticCurveTo(w, -d, w, -d + c);
    s.lineTo(w, d - c);
    s.quadraticCurveTo(w, d, w - c, d);
    s.lineTo(0.55, d);
    s.lineTo(0.5, d - 0.06);
    s.lineTo(0.2, d - 0.06);
    s.lineTo(0.15, d);
    s.lineTo(-w + c, d);
    s.quadraticCurveTo(-w, d, -w, d - c);
    s.lineTo(-w, -d + c);
    s.quadraticCurveTo(-w, -d, -w + c, -d);
    const g = new THREE.ExtrudeGeometry(s, {depth: BOARD.t, bevelEnabled: false, curveSegments: 10});
    g.rotateX(Math.PI / 2); // 形狀 y → z，擠出方向 → -y
    return g;
  }, []);

  const smdLight = useRef<THREE.InstancedMesh>(null);
  const smdDark = useRef<THREE.InstancedMesh>(null);
  const traces = useRef<THREE.InstancedMesh>(null);
  const light = SMD.filter((s) => !s.dark);
  const dark = SMD.filter((s) => s.dark);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const put = (ref: React.RefObject<THREE.InstancedMesh | null>, list: typeof SMD) => {
      list.forEach((s, i) => {
        o.position.set(s.x, 0.005, s.z);
        o.rotation.set(0, 0, 0);
        o.scale.set(s.w, 0.01, s.d);
        o.updateMatrix();
        ref.current!.setMatrixAt(i, o.matrix);
      });
      ref.current!.instanceMatrix.needsUpdate = true;
    };
    put(smdLight, light);
    put(smdDark, dark);
    TRACES.forEach((t, i) => {
      const mid = t.a.clone().add(t.b).multiplyScalar(0.5);
      const len = t.a.distanceTo(t.b) + 0.006;
      const ang = Math.atan2(t.b.z - t.a.z, t.b.x - t.a.x);
      o.position.copy(mid);
      o.rotation.set(0, -ang, 0);
      o.scale.set(len, 0.002, 0.006);
      o.updateMatrix();
      traces.current!.setMatrixAt(i, o.matrix);
    });
    traces.current!.instanceMatrix.needsUpdate = true;
  }, [light, dark]);

  const pkg = (pos: THREE.Vector3, sub: readonly number[], die: readonly number[], dieMat: THREE.Material) => (
    <group position={[pos.x, 0, pos.z]}>
      <mesh material={m.sub} position={[0, sub[1] / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[sub[0], sub[1], sub[2]]} />
      </mesh>
      <mesh material={dieMat} position={[0, sub[1] + die[1] / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[die[0], die[1], die[2]]} />
      </mesh>
      {Array.from({length: 20}).map((_, i) => {
        const side = i % 4;
        const k = Math.floor(i / 4) - 2;
        const x = side < 2 ? k * 0.035 : (side === 2 ? 1 : -1) * (die[0] / 2 + 0.03);
        const z = side < 2 ? (side === 0 ? 1 : -1) * (die[2] / 2 + 0.03) : k * 0.035;
        return (
          <mesh key={i} material={m.cap} position={[x, sub[1] + 0.004, z]}>
            <boxGeometry args={[0.014, 0.008, 0.008]} />
          </mesh>
        );
      })}
    </group>
  );

  return (
    <group>
      <mesh geometry={boardGeo} material={m.pcb} castShadow receiveShadow />
      {/* CPU / GPU 封裝 */}
      {pkg(CPU_POS, CPU_SUB, CPU_DIE, m.cpuDie)}
      {pkg(GPU_POS, GPU_SUB, GPU_DIE, m.gpuDie)}
      {/* GDDR6 */}
      {GDDR.map((g, i) => (
        <mesh key={i} material={m.gddr} position={[g.x, GDDR_SIZE[1] / 2, g.z]} rotation={[0, i === 0 ? 0 : Math.PI / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[GDDR_SIZE[0], GDDR_SIZE[1], GDDR_SIZE[2]]} />
        </mesh>
      ))}
      {/* 供電電感 */}
      {Array.from({length: 5}).map((_, i) => (
        <mesh key={'c' + i} material={m.choke} position={[-0.76, 0.024, -0.5 + i * 0.1]} castShadow>
          <boxGeometry args={[0.07, 0.048, 0.07]} />
        </mesh>
      ))}
      {Array.from({length: 5}).map((_, i) => (
        <mesh key={'g' + i} material={m.choke} position={[0.2 + i * 0.1, 0.024, -0.62]} castShadow>
          <boxGeometry args={[0.07, 0.048, 0.07]} />
        </mesh>
      ))}
      {/* SO-DIMM ×2 */}
      {DIMMS.map((d, k) => (
        <group key={k} position={[d.x, 0, d.z]}>
          <mesh material={m.socket} position={[0, 0.025, -DIMM_SIZE[2] / 2 - 0.01]} castShadow receiveShadow>
            <boxGeometry args={[DIMM_SIZE[0] + 0.06, 0.05, 0.06]} />
          </mesh>
          {[-1, 1].map((sx) => (
            <mesh key={sx} material={m.steel} position={[sx * (DIMM_SIZE[0] / 2 + 0.02), 0.03, 0.02]} castShadow>
              <boxGeometry args={[0.02, 0.05, 0.22]} />
            </mesh>
          ))}
          <mesh material={m.dimm} position={[0, DIMM_Y, 0]} castShadow receiveShadow>
            <boxGeometry args={[DIMM_SIZE[0], DIMM_SIZE[1], DIMM_SIZE[2]]} />
          </mesh>
          <mesh material={m.gold} position={[0, DIMM_Y + 0.006, -DIMM_SIZE[2] / 2 + 0.02]}>
            <boxGeometry args={[DIMM_SIZE[0] - 0.04, 0.002, 0.03]} />
          </mesh>
          {[-0.24, -0.08, 0.08, 0.24].map((x) => (
            <mesh key={x} material={m.dram} position={[x, DIMM_Y + 0.012, 0.035]} castShadow>
              <boxGeometry args={[0.12, 0.014, 0.1]} />
            </mesh>
          ))}
          <mesh material={m.chip} position={[0.31, DIMM_Y + 0.009, -0.06]}>
            <boxGeometry args={[0.04, 0.008, 0.04]} />
          </mesh>
        </group>
      ))}
      {/* M.2 SSD */}
      <group position={[SSD_POS.x, 0, SSD_POS.z]}>
        <mesh material={m.socket} position={[-SSD_SIZE[0] / 2 - 0.02, 0.02, 0]} castShadow>
          <boxGeometry args={[0.05, 0.04, SSD_SIZE[2] + 0.02]} />
        </mesh>
        <mesh material={m.ssd} position={[0, SSD_Y, 0]} castShadow receiveShadow>
          <boxGeometry args={[SSD_SIZE[0], SSD_SIZE[1], SSD_SIZE[2]]} />
        </mesh>
        <mesh material={m.gold} position={[-SSD_SIZE[0] / 2 + 0.015, SSD_Y + 0.005, 0]}>
          <boxGeometry args={[0.03, 0.002, SSD_SIZE[2] - 0.03]} />
        </mesh>
        <mesh material={m.ctrl} position={[-0.24, SSD_Y + 0.01, 0]} castShadow>
          <boxGeometry args={[0.1, 0.012, 0.1]} />
        </mesh>
        <mesh material={m.chip} position={[-0.11, SSD_Y + 0.008, 0.05]}>
          <boxGeometry args={[0.06, 0.008, 0.05]} />
        </mesh>
        {[0.03, 0.21].map((x) => (
          <mesh key={x} material={m.nand} position={[x, SSD_Y + 0.011, 0]} castShadow>
            <boxGeometry args={[0.14, 0.014, 0.13]} />
          </mesh>
        ))}
        <mesh material={m.steel} position={[SSD_SIZE[0] / 2 + 0.02, 0.03, 0]}>
          <cylinderGeometry args={[0.022, 0.022, 0.03, 20]} />
        </mesh>
      </group>
      {/* 連接埠與鎖孔 */}
      {[-0.1, 0.12].map((z) => (
        <mesh key={z} material={m.steel} position={[-BOARD.w / 2 + 0.04, 0.018, z]} castShadow>
          <boxGeometry args={[0.08, 0.034, 0.09]} />
        </mesh>
      ))}
      {[0.0, 0.24].map((z) => (
        <mesh key={z} material={m.steel} position={[BOARD.w / 2 - 0.05, 0.024, z]} castShadow>
          <boxGeometry args={[0.1, 0.046, 0.16]} />
        </mesh>
      ))}
      {[
        [-1.6, -0.9],
        [1.6, -0.9],
        [-1.6, 0.9],
        [1.6, 0.9],
        [0, -0.62],
        [-0.05, 0.62],
      ].map(([x, z], i) => (
        <mesh key={i} material={m.gold} position={[x, 0.001, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.022, 0.04, 24]} />
        </mesh>
      ))}
      <instancedMesh ref={smdLight} args={[undefined, undefined, light.length]} material={m.smdLight} castShadow>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={smdDark} args={[undefined, undefined, dark.length]} material={m.smdDark} castShadow>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={traces} args={[undefined, undefined, TRACES.length]} material={m.trace}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </group>
  );
};

// ---------------- 散熱模組（爆炸圖時升起，之後移出畫面） ----------------

const PIPES: THREE.Vector3[][] = [
  [V(-0.36, 0.075, -0.3), V(-0.62, 0.075, -0.33), V(-0.95, 0.08, -0.74), V(-1.27, 0.08, -0.9), V(-1.6, 0.08, -0.9)],
  [V(-0.36, 0.075, -0.2), V(-0.68, 0.075, -0.24), V(-1.02, 0.08, -0.7), V(-1.27, 0.08, -0.84), V(-1.6, 0.08, -0.84)],
  [V(0.34, 0.075, -0.3), V(0.62, 0.075, -0.33), V(0.98, 0.08, -0.74), V(1.3, 0.08, -0.9), V(1.62, 0.08, -0.9)],
  [V(0.34, 0.075, -0.2), V(0.68, 0.075, -0.24), V(1.04, 0.08, -0.7), V(1.3, 0.08, -0.84), V(1.62, 0.08, -0.84)],
  [V(-0.55, 0.078, -0.14), V(-0.1, 0.082, -0.12), V(0.55, 0.078, -0.14)],
];

const Cooling: React.FC<{f: number; T: Times}> = ({f, T}) => {
  const lift = tween(f, T.explodeStart + 10, T.explodeEnd + 10, 0, 0.62, ease.camera) + tween(f, T.coolOut, T.coolOutEnd, 0, 2.6, ease.in);
  const o = 1 - progress(f, T.coolOut + 20, T.coolOutEnd);
  const m = useMemo(
    () => ({
      copper: mat({color: P.copper, roughness: 0.26, metalness: 1}),
      fin: mat({color: '#B8BFCC', roughness: 0.3, metalness: 0.9}),
      housing: mat({color: '#252B38', roughness: 0.45, metalness: 0.4, side: THREE.DoubleSide}),
      blade: mat({color: '#1A1E27', roughness: 0.55, metalness: 0.1}),
      hub: mat({color: '#3A4253', roughness: 0.3, metalness: 0.7}),
    }),
    [],
  );
  fade(Object.values(m), o);
  const pipes = useMemo(
    () =>
      PIPES.map((pts) => {
        const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 64, 0.022, 12, false);
        g.scale(1, 0.62, 1);
        return g;
      }),
    [],
  );
  const finsRef = useRef<THREE.InstancedMesh>(null);
  const bladesRef = useRef<THREE.InstancedMesh>(null);
  const FINS = 34;
  const BLADES = 31;
  useLayoutEffect(() => {
    const ob = new THREE.Object3D();
    let k = 0;
    for (const fan of FANS)
      for (let i = 0; i < FINS; i++) {
        ob.position.set(fan.x - 0.3 + (i / (FINS - 1)) * 0.6, 0.075, -0.87);
        ob.updateMatrix();
        finsRef.current!.setMatrixAt(k++, ob.matrix);
      }
    finsRef.current!.instanceMatrix.needsUpdate = true;
  }, []);
  useLayoutEffect(() => {
    const ob = new THREE.Object3D();
    let k = 0;
    FANS.forEach((fan, fi) => {
      const rot = f * 0.21 + fi * 0.5;
      for (let i = 0; i < BLADES; i++) {
        const ang = rot + (i / BLADES) * Math.PI * 2;
        ob.position.set(fan.x + Math.cos(ang) * 0.17, 0.07, fan.z + Math.sin(ang) * 0.17);
        ob.rotation.set(0, -ang + 0.5, 0);
        ob.updateMatrix();
        bladesRef.current!.setMatrixAt(k++, ob.matrix);
      }
    });
    bladesRef.current!.instanceMatrix.needsUpdate = true;
  }, [f]);
  return (
    <group position={[0, lift - 0.02, 0]} visible={o > 0.01}>
      <mesh material={m.copper} position={[CPU_POS.x, 0.05, CPU_POS.z]} castShadow receiveShadow>
        <boxGeometry args={[0.3, 0.02, 0.36]} />
      </mesh>
      <mesh material={m.copper} position={[GPU_POS.x + 0.05, 0.05, GPU_POS.z]} castShadow receiveShadow>
        <boxGeometry args={[0.46, 0.02, 0.42]} />
      </mesh>
      {pipes.map((g, i) => (
        <mesh key={i} geometry={g} material={m.copper} castShadow receiveShadow />
      ))}
      <instancedMesh ref={finsRef} args={[undefined, undefined, FINS * 2]} material={m.fin} castShadow>
        <boxGeometry args={[0.006, 0.11, 0.14]} />
      </instancedMesh>
      {FANS.map((fan, i) => (
        <group key={i} position={[fan.x, 0, fan.z]}>
          <mesh material={m.housing} position={[0, 0.07, 0]} castShadow>
            <cylinderGeometry args={[FAN_R, FAN_R, 0.11, 48, 1, true]} />
          </mesh>
          <mesh material={m.housing} position={[0, 0.126, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow>
            <ringGeometry args={[0.215, FAN_R, 48]} />
          </mesh>
          <mesh material={m.housing} position={[0, 0.016, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[FAN_R, 48]} />
          </mesh>
          <mesh material={m.hub} position={[0, 0.07, 0]} castShadow>
            <cylinderGeometry args={[0.07, 0.07, 0.09, 32]} />
          </mesh>
        </group>
      ))}
      <instancedMesh ref={bladesRef} args={[undefined, undefined, BLADES * 2]} material={m.blade} castShadow>
        <boxGeometry args={[0.11, 0.08, 0.006]} />
      </instancedMesh>
    </group>
  );
};

// ---------------- 資料流：SSD → RAM ----------------

const STREAM_N = 90;
const Stream: React.FC<{f: number; T: Times}> = ({f, T}) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const on = progress(f, T.streamStart, T.streamStart + 30) * (1 - progress(f, T.streamEnd - 30, T.streamEnd));
  const tube = useMemo(() => new THREE.TubeGeometry(STREAM_CURVE, 160, 0.012, 8, false), []);
  const m = useMemo(
    () => ({
      dot: new THREE.MeshBasicMaterial({color: '#FFD08A', toneMapped: false, transparent: true}),
      tube: new THREE.MeshBasicMaterial({color: P.amber, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false}),
    }),
    [],
  );
  m.tube.opacity = 0.28 * on;
  m.dot.opacity = on;
  const reveal = progress(f, T.streamStart, T.streamStart + 60);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    for (let i = 0; i < STREAM_N; i++) {
      const u = (((i / STREAM_N + (f - T.streamStart) / 150) % 1) + 1) % 1;
      const vis = u < reveal ? 1 : 0;
      const p = STREAM_CURVE.getPointAt(u);
      const tan = STREAM_CURVE.getTangentAt(u);
      o.position.copy(p);
      o.lookAt(p.clone().add(tan));
      const s = vis * on * Math.min(1, Math.sin(u * Math.PI) * 4);
      o.scale.set(s, s, s);
      o.updateMatrix();
      ref.current!.setMatrixAt(i, o.matrix);
    }
    ref.current!.instanceMatrix.needsUpdate = true;
  }, [f, on, reveal, T.streamStart]);
  return (
    <group visible={on > 0.01}>
      <mesh geometry={tube} material={m.tube} />
      <instancedMesh ref={ref} args={[undefined, undefined, STREAM_N]} material={m.dot}>
        <boxGeometry args={[0.022, 0.022, 0.05]} />
      </instancedMesh>
    </group>
  );
};

// ---------------- 模型層 ----------------

const AMBER = new THREE.Color('#C9781F');
const HOT = new THREE.Color('#FFE7B8');

const Slabs: React.FC<{f: number; a: A5; T: Times}> = ({f, a, T}) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const m = useMemo(
    () => ({
      slab: new THREE.MeshStandardMaterial({color: '#FFFFFF', roughness: 0.4, metalness: 0.1, emissive: P.amberDeep, emissiveIntensity: 0.08}),
    }),
    [],
  );
  const visibleAll = f > T.slabRise - 2 && f < T.xfadeOutEnd + 4;
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    for (let i = 0; i < N_LAYERS; i++) {
      const s = slabState(T, i, f);
      o.position.copy(s.pos);
      o.scale.set(s.visible ? s.scale : 0.0001, s.visible ? 1 : 0.0001, s.visible ? s.scale : 0.0001);
      o.updateMatrix();
      ref.current!.setMatrixAt(i, o.matrix);
      // 計算波：GPU 層在 gpulayers 之後由下往上依序亮起；CPU 層在 cpulayers 之後
      let g = 0;
      if (i >= N_CPU) {
        const ph = (f - a.gpulayers) / 46 - (i - N_CPU) / 20;
        g = f > a.gpulayers - 4 && f < a.why + 20 ? Math.max(0, Math.cos((ph - Math.floor(ph)) * Math.PI * 2)) ** 6 : 0;
      } else {
        const ph = (f - a.cpulayers) / 70 - i / 12;
        g = f > a.cpulayers - 4 && f < a.why + 20 ? Math.max(0, Math.cos((ph - Math.floor(ph)) * Math.PI * 2)) ** 6 : 0;
      }
      c.copy(AMBER).lerp(HOT, g * 0.75);
      ref.current!.setColorAt(i, c);
    }
    ref.current!.instanceMatrix.needsUpdate = true;
    if (ref.current!.instanceColor) ref.current!.instanceColor.needsUpdate = true;
  }, [f, T, a]);
  return (
    <group visible={visibleAll}>
      <instancedMesh ref={ref} args={[undefined, undefined, N_LAYERS]} material={m.slab} castShadow receiveShadow>
        <boxGeometry args={[SLAB[0], SLAB[1], SLAB[2]]} />
      </instancedMesh>
    </group>
  );
};
