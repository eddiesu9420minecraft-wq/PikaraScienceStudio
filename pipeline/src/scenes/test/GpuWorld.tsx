import React, {useLayoutEffect} from 'react';
import * as THREE from 'three';
import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {palette as P} from '../../theme/palette';
import {ease, progress, tween} from '../../lib/anim';
import {SHOT} from './shots';
import {cardRotation, rig} from './gpuRig';
import {Board} from './gpu/Board';
import {Heatsink, Shroud} from './gpu/Cooler';
import {MatrixGrid} from './gpu/Matrix';

/**
 * 3D graphics card scene. Everything is driven by the `frame` prop (template frames) and updated in
 * useLayoutEffect: no useFrame, no Math.random.
 * Parts live in ./gpu/: Board (PCB, package, VRAM, VRM, I/O, backplate), Cooler (fin stack, heat pipes,
 * shroud, fans, x-ray ghost), Matrix (schematic y = W x on the die), textures/materials (procedural).
 */
export const GpuWorld: React.FC<{frame: number; width?: number; height?: number}> = ({frame, width = 1920, height = 1080}) => (
  <ThreeCanvas
    width={width}
    height={height}
    shadows="soft"
    gl={{antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: true}}
    style={{position: 'absolute', inset: 0}}
  >
    <SceneSetup />
    <CameraDriver frame={frame} />
    <Lights />
    <Card frame={frame} />
  </ThreeCanvas>
);

// ---------------- scene setup ----------------

const SceneSetup: React.FC = () => {
  const {gl, scene} = useThree();
  useLayoutEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.22;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.62;
    scene.environmentRotation.set(0.2, -0.6, 0);
    scene.background = new THREE.Color(P.ink);
    scene.fog = new THREE.Fog(P.ink, 8, 18);
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
};

const CameraDriver: React.FC<{frame: number}> = ({frame}) => {
  const {camera, size} = useThree();
  useLayoutEffect(() => {
    const s = rig(frame);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = s.fov;
    cam.aspect = size.width / size.height;
    cam.near = 0.004;
    cam.far = 60;
    cam.position.copy(s.pos);
    cam.lookAt(s.target);
    cam.updateProjectionMatrix();
  }, [frame, camera, size]);
  return null;
};

/** Key (warm, soft shadows) + cool rim from behind + warm fill + soft top bounce, plus RoomEnvironment reflections. */
const Lights: React.FC = () => (
  <>
    <hemisphereLight args={['#C4D2EE', '#16120E', 0.55]} />
    <directionalLight
      position={[3.2, 6, 4.4]}
      intensity={3.1}
      color="#FFF0DE"
      castShadow
      shadow-mapSize-width={4096}
      shadow-mapSize-height={4096}
      shadow-camera-left={-2.1}
      shadow-camera-right={2.1}
      shadow-camera-top={2.1}
      shadow-camera-bottom={-2.1}
      shadow-camera-near={1}
      shadow-camera-far={18}
      shadow-bias={-0.00015}
      shadow-normalBias={0.0025}
    />
    {/* cool rim from behind-left: separates silhouette from the dark background */}
    <directionalLight position={[-5, 2.6, -4.5]} intensity={3.4} color="#9ED6FF" />
    <directionalLight position={[4.5, 1.2, -4]} intensity={1.4} color="#BFD9FF" />
    {/* warm fill from the front-left */}
    <directionalLight position={[-4, 1.6, 4]} intensity={0.75} color="#FFC890" />
    <pointLight position={[0.2, 1.6, 2.6]} intensity={1.2} distance={7} decay={1.6} color="#FFD7A8" />
  </>
);

// ---------------- card ----------------

const Card: React.FC<{frame: number}> = ({frame}) => {
  const {rx, ry} = cardRotation(frame);
  const lift = tween(frame, SHOT.xrayStart, SHOT.xrayStart + 56, 0, 1, ease.camera);
  const vanish = progress(frame, SHOT.diveStart, SHOT.diveStart + 40);
  const smooth = (a: number, b: number) => ease.inOut(progress(lift, a, b));
  const shroudSolid = 1 - smooth(0.0, 0.5);
  const sinkSolid = 1 - smooth(0.22, 0.75);
  const ghostOut = 1 - ease.inOut(progress(frame, SHOT.xrayStart + 48, SHOT.xrayStart + 84));
  const shroudGhost = smooth(0.15, 0.6) * ghostOut * (1 - vanish);
  const sinkGhost = smooth(0.4, 0.85) * ghostOut * (1 - vanish);
  const fanAngle = frame * 0.16; // fixed angular speed per frame (deterministic)

  return (
    <group rotation={[0, ry, 0]}>
      <group rotation={[rx, 0, 0]}>
        <Board frame={frame} />
        <group position={[0, lift * 0.3, 0]} visible={sinkSolid > 0.005 || sinkGhost > 0.005}>
          <Heatsink solid={sinkSolid} ghost={sinkGhost} />
        </group>
        <group position={[0, lift * 0.62, 0]} visible={shroudSolid > 0.005 || shroudGhost > 0.005}>
          <Shroud solid={shroudSolid} ghost={shroudGhost} fanAngle={fanAngle} />
        </group>
        <MatrixGrid frame={frame} />
      </group>
    </group>
  );
};
