import React, {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {palette as P} from '../../../theme/palette';
import {DIE_POS, DIE_TOP} from '../gpuRig';
import {brushedTexture} from './textures';
import {makeDitherDepth, makeGhostMaterial} from './materials';

/**
 * Cooler: aluminium fin stack + copper cold plate + heat pipes.
 * Shroud: brushed anodised metal with chamfers + three fans.
 * X-ray phase: solids fade out while an additive Fresnel ghost shell and thin outlines fade in.
 */

const FIN_COUNT = 128;
const FIN_X0 = -1.41;
const FIN_X1 = 1.41;
const FIN_T = 0.0036;
const FIN_Y0 = 0.1;
const FIN_Y1 = 0.39;
const FIN_Z0 = -0.5;
const FIN_Z1 = 0.545;

const finShape = () => {
  const s = new THREE.Shape();
  const c = 0.035;
  // shape x = card z, shape y = card y
  s.moveTo(FIN_Z0, FIN_Y0);
  s.lineTo(FIN_Z1, FIN_Y0);
  s.lineTo(FIN_Z1, FIN_Y1 - c);
  s.lineTo(FIN_Z1 - c, FIN_Y1);
  s.lineTo(FIN_Z0 + c, FIN_Y1);
  s.lineTo(FIN_Z0, FIN_Y1 - c);
  s.closePath();
  return s;
};

const setFade = (m: THREE.Material, o: number) => {
  m.opacity = o;
  m.transparent = o < 0.999;
  m.depthWrite = o > 0.6;
};

type CoolerProps = {solid: number; ghost: number};

export const Heatsink: React.FC<CoolerProps> = ({solid, ghost}) => {
  const fins = useRef<THREE.InstancedMesh>(null);
  const shadowU = useMemo(() => ({value: 1}), []);
  shadowU.value = solid;
  const geo = useMemo(() => {
    const fin = new THREE.ExtrudeGeometry(finShape(), {depth: FIN_T, bevelEnabled: false});
    fin.rotateY(-Math.PI / 2);
    fin.translate(FIN_T / 2, 0, 0);
    const env = new THREE.ExtrudeGeometry(finShape(), {depth: FIN_X1 - FIN_X0, bevelEnabled: false});
    env.rotateY(-Math.PI / 2);
    env.translate(FIN_X1, 0, 0);
    const pipes = [-0.13, -0.065, 0, 0.065, 0.13].map((z, k) => {
      const lift = (k % 2) * 0.05;
      const pts = [
        new THREE.Vector3(-1.36, 0.33 - lift, z),
        new THREE.Vector3(-1.1, 0.31 - lift, z),
        new THREE.Vector3(-0.72, 0.13, z),
        new THREE.Vector3(DIE_POS.x, 0.105, z + DIE_POS.z),
        new THREE.Vector3(0.08, 0.13, z),
        new THREE.Vector3(0.5, 0.26 + lift * 0.5, z),
        new THREE.Vector3(1.36, 0.3 + lift * 0.5, z),
      ];
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 96, 0.016, 14, false);
    });
    return {fin, env, envEdges: new THREE.EdgesGeometry(env, 20), pipes, plate: new RoundedBoxGeometry(0.36, 0.028, 0.36, 2, 0.004)};
  }, []);
  const m = useMemo(() => {
    const brushed = brushedTexture('fin', 812, 0.6, 0.18);
    const alu = new THREE.MeshStandardMaterial({color: '#C9CFD8', roughness: 0.38, roughnessMap: brushed, metalness: 0.95});
    const copper = new THREE.MeshPhysicalMaterial({color: P.copper, roughness: 0.24, metalness: 1, clearcoat: 0.3, clearcoatRoughness: 0.2});
    return {
      alu,
      copper,
      ghost: makeGhostMaterial(P.ice, 3.0, 0.0),
      ghostCopper: makeGhostMaterial(P.amber, 2.2, 0.0),
      line: new THREE.LineBasicMaterial({color: P.ice, transparent: true, depthWrite: false, toneMapped: false}),
      depth: makeDitherDepth(shadowU),
    };
  }, [shadowU]);
  setFade(m.alu, solid);
  setFade(m.copper, solid);
  m.ghost.uniforms.uOpacity.value = ghost * 0.1;
  m.ghostCopper.uniforms.uOpacity.value = ghost * 0.22;
  m.line.opacity = ghost * 0.28;

  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    for (let i = 0; i < FIN_COUNT; i++) {
      o.position.set(FIN_X0 + (i / (FIN_COUNT - 1)) * (FIN_X1 - FIN_X0), 0, 0);
      o.updateMatrix();
      fins.current!.setMatrixAt(i, o.matrix);
    }
    fins.current!.instanceMatrix.needsUpdate = true;
  }, []);

  const showSolid = solid > 0.005;
  return (
    <group>
      <instancedMesh ref={fins} args={[geo.fin, m.alu, FIN_COUNT]} castShadow receiveShadow visible={showSolid} customDepthMaterial={m.depth} />
      <mesh geometry={geo.plate} material={m.copper} position={[DIE_POS.x, DIE_TOP + 0.015, DIE_POS.z]} castShadow receiveShadow visible={showSolid} customDepthMaterial={m.depth} />
      {geo.pipes.map((p, i) => (
        <mesh key={i} geometry={p} material={m.copper} castShadow receiveShadow visible={showSolid} customDepthMaterial={m.depth} />
      ))}
      {ghost > 0.005 ? (
        <>
          <mesh geometry={geo.env} material={m.ghost} renderOrder={10} />
          <lineSegments geometry={geo.envEdges} material={m.line} renderOrder={11} />
          {geo.pipes.map((p, i) => (
            <mesh key={i} geometry={p} material={m.ghostCopper} renderOrder={10} />
          ))}
        </>
      ) : null}
    </group>
  );
};

// ---------------- shroud and fans ----------------

export const FAN_X = [-1.0, 0, 1.0];
const FAN_R = 0.46;
const SHROUD_Y = 0.43;
const PLATE_T = 0.034;

export const Shroud: React.FC<CoolerProps & {fanAngle: number}> = ({solid, ghost, fanAngle}) => {
  const shadowU = useMemo(() => ({value: 1}), []);
  shadowU.value = solid;
  const geo = useMemo(() => {
    const s = new THREE.Shape();
    const w = 1.52;
    const h = 0.6;
    const c = 0.09;
    s.moveTo(-w + c, -h);
    s.lineTo(w - c, -h);
    s.lineTo(w, -h + c);
    s.lineTo(w, h - c);
    s.lineTo(w - c, h);
    s.lineTo(-w + c, h);
    s.lineTo(-w, h - c);
    s.lineTo(-w, -h + c);
    s.closePath();
    for (const x of FAN_X) {
      const hole = new THREE.Path();
      hole.absarc(x, 0, FAN_R + 0.004, 0, Math.PI * 2, true);
      s.holes.push(hole);
    }
    const plate = new THREE.ExtrudeGeometry(s, {
      depth: PLATE_T,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 3,
      curveSegments: 72,
    });
    plate.rotateX(-Math.PI / 2);
    // fan bezel ring (lathe profile: inner lip, chamfer, land)
    const prof = [
      new THREE.Vector2(FAN_R - 0.004, -0.05),
      new THREE.Vector2(FAN_R + 0.002, -0.05),
      new THREE.Vector2(FAN_R + 0.002, 0.004),
      new THREE.Vector2(FAN_R + 0.012, 0.016),
      new THREE.Vector2(FAN_R + 0.034, 0.016),
      new THREE.Vector2(FAN_R + 0.046, 0.006),
      new THREE.Vector2(FAN_R + 0.048, 0.0),
    ];
    const bezel = new THREE.LatheGeometry(prof, 128);
    // blade: curved aerofoil with angle of attack
    const b = new THREE.Shape();
    b.moveTo(0.12, -0.03);
    b.bezierCurveTo(0.2, -0.085, 0.33, -0.1, 0.44, -0.045);
    b.lineTo(0.438, 0.055);
    b.bezierCurveTo(0.33, 0.02, 0.21, 0.01, 0.12, 0.045);
    b.closePath();
    const blade = new THREE.ExtrudeGeometry(b, {depth: 0.006, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1, curveSegments: 20});
    blade.rotateX(-Math.PI / 2);
    const hub = new THREE.CylinderGeometry(0.125, 0.13, 0.04, 64);
    const hubCap = new THREE.CylinderGeometry(0.1, 0.12, 0.012, 64);
    const rim = new THREE.TorusGeometry(0.442, 0.005, 8, 128).rotateX(Math.PI / 2);
    const skirt = new RoundedBoxGeometry(3.04, 0.11, 0.024, 2, 0.008);
    const endCap = new RoundedBoxGeometry(0.024, 0.11, 1.2, 2, 0.008);
    return {plate, plateEdges: new THREE.EdgesGeometry(plate, 25), bezel, bezelEdges: new THREE.EdgesGeometry(bezel, 40), blade, hub, hubCap, rim, skirt, endCap};
  }, []);

  const m = useMemo(() => {
    const brushed = brushedTexture('shroud', 2207, 0.5, 0.28);
    brushed.repeat.set(0.7, 2.5);
    return {
      shell: new THREE.MeshPhysicalMaterial({
        color: '#3A4252',
        metalness: 0.82,
        roughness: 0.52,
        roughnessMap: brushed,
        clearcoat: 0.55,
        clearcoatRoughness: 0.18,
        envMapIntensity: 1.2,
      }),
      bezel: new THREE.MeshPhysicalMaterial({color: '#B9C1CC', metalness: 1, roughness: 0.28, clearcoat: 0.4, clearcoatRoughness: 0.1}),
      skirt: new THREE.MeshPhysicalMaterial({color: '#262C38', metalness: 0.7, roughness: 0.45, clearcoat: 0.3}),
      fan: new THREE.MeshPhysicalMaterial({color: '#0C0E13', roughness: 0.6, metalness: 0.0, specularIntensity: 0.35, sheen: 0.4, sheenColor: '#5C6A85', sheenRoughness: 0.5, envMapIntensity: 0.35}),
      hub: new THREE.MeshPhysicalMaterial({color: '#2E3443', roughness: 0.3, metalness: 0.85, clearcoat: 0.5}),
      accent: new THREE.MeshStandardMaterial({color: P.amber, emissive: P.amber, emissiveIntensity: 0.7, roughness: 0.4}),
      ghost: makeGhostMaterial(P.ice, 2.6, 0.0),
      line: new THREE.LineBasicMaterial({color: P.ice, transparent: true, depthWrite: false, toneMapped: false}),
      depth: makeDitherDepth(shadowU),
    };
  }, [shadowU]);
  for (const k of ['shell', 'bezel', 'skirt', 'fan', 'hub', 'accent'] as const) setFade(m[k], solid);
  m.ghost.uniforms.uOpacity.value = ghost * 0.16;
  m.line.opacity = ghost * 0.42;

  const showSolid = solid > 0.005;
  const sd = {castShadow: true, receiveShadow: true, customDepthMaterial: m.depth, visible: showSolid};
  return (
    <group>
      <mesh geometry={geo.plate} material={m.shell} position={[0, SHROUD_Y, 0]} {...sd} />
      {/* short side skirts so the fin stack shows from the side */}
      {[0.6, -0.6].map((z) => (
        <mesh key={z} geometry={geo.skirt} material={m.skirt} position={[0, SHROUD_Y - 0.045, z]} {...sd} />
      ))}
      {[1.52, -1.5].map((x) => (
        <mesh key={x} geometry={geo.endCap} material={m.skirt} position={[x, SHROUD_Y - 0.045, 0]} {...sd} />
      ))}
      {/* thin amber accent line on the outer edge */}
      <mesh material={m.accent} position={[0.05, SHROUD_Y - 0.03, 0.6125]} visible={showSolid}>
        <boxGeometry args={[2.6, 0.0035, 0.002]} />
      </mesh>
      {FAN_X.map((x, fi) => (
        <group key={x} position={[x, SHROUD_Y + PLATE_T + 0.012, 0]}>
          <mesh geometry={geo.bezel} material={m.bezel} {...sd} />
          <group position={[0, -0.03, 0]} rotation={[0, fanAngle + fi * 0.7, 0]} visible={showSolid}>
            {Array.from({length: 11}).map((_, b) => (
              <mesh key={b} geometry={geo.blade} material={m.fan} rotation={[0.38, (b / 11) * Math.PI * 2, 0, 'YXZ']} castShadow customDepthMaterial={m.depth} />
            ))}
            <mesh geometry={geo.rim} material={m.fan} position={[0, 0.003, 0]} />
          </group>
          <mesh geometry={geo.hub} material={m.hub} position={[0, -0.022, 0]} {...sd} />
          <mesh geometry={geo.hubCap} material={m.hub} position={[0, 0.004, 0]} {...sd} />
          <mesh material={m.accent} position={[0, 0.0105, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={showSolid}>
            <ringGeometry args={[0.076, 0.081, 64]} />
          </mesh>
          {ghost > 0.005 ? (
            <>
              <mesh geometry={geo.bezel} material={m.ghost} renderOrder={10} />
              <lineSegments geometry={geo.bezelEdges} material={m.line} renderOrder={11} />
            </>
          ) : null}
        </group>
      ))}
      {ghost > 0.005 ? (
        <>
          <mesh geometry={geo.plate} material={m.ghost} position={[0, SHROUD_Y, 0]} renderOrder={10} />
          <lineSegments geometry={geo.plateEdges} material={m.line} position={[0, SHROUD_Y, 0]} renderOrder={11} />
        </>
      ) : null}
    </group>
  );
};
