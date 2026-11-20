import * as THREE from 'three';

/**
 * X 光「幽靈」材質：只在輪廓（掠射角）發光的加法混合 Fresnel 殼。
 * 比半透明灰色實體乾淨很多，不會出現混濁的灰板。支援對數深度緩衝。
 */
export const makeGhostMaterial = (color: string, power = 2.6, floor = 0.035) =>
  new THREE.ShaderMaterial({
    uniforms: {uColor: {value: new THREE.Color(color)}, uOpacity: {value: 0}, uPower: {value: power}, uFloor: {value: floor}},
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uPower;
      uniform float uFloor;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
        gl_FragColor = vec4(uColor * (f + uFloor) * uOpacity, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

/**
 * 陰影用的抖動深度材質：依 uOpacity 以有序抖動丟棄片段，
 * 讓淡出中的外殼／散熱器陰影平滑消失（PCFSoft 會把抖動模糊掉），而不是突然跳掉。
 */
export const makeDitherDepth = (uniform: {value: number}) => {
  const m = new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking});
  m.onBeforeCompile = (s) => {
    s.uniforms.uShadowOpacity = uniform;
    s.fragmentShader =
      'uniform float uShadowOpacity;\n' +
      s.fragmentShader.replace(
        'void main() {',
        `void main() {
          vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
          float b = mod(q.x * 4.0 + q.y * 9.0 + q.x * q.y * 3.0, 16.0) / 16.0 + 1.0 / 32.0;
          if (b > uShadowOpacity) discard;`,
      );
  };
  m.customProgramCacheKey = () => 'dither-depth';
  return m;
};

/** 讓 instance color 同時驅動自發光（示意圖元素：有立體明暗，又帶有資訊色的光）。 */
export const makeGlowStandard = (glow: number, params: THREE.MeshStandardMaterialParameters = {}) => {
  const m = new THREE.MeshStandardMaterial({roughness: 0.35, metalness: 0.1, ...params});
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance += vColor.rgb * ${glow.toFixed(3)};
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'glow-std-' + glow.toFixed(3);
  return m;
};
