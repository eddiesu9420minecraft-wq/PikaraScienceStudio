import {Easing} from 'remotion';

// ---- 逐幀確定性動畫工具：所有動畫只依賴 frame，不使用 Math.random / Date ----

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const progress = (frame: number, start: number, end: number) => clamp((frame - start) / (end - start));

export const ease = {
  linear: (t: number) => t,
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  out: Easing.bezier(0.16, 1, 0.3, 1),
  in: Easing.bezier(0.55, 0, 0.9, 0.4),
  inOutSoft: Easing.bezier(0.45, 0, 0.25, 1),
  camera: Easing.bezier(0.6, 0.02, 0.2, 1), // 有重量感的攝影機運動
};
export type EaseFn = (t: number) => number;

export const tween = (frame: number, start: number, end: number, from: number, to: number, fn: EaseFn = ease.inOut) =>
  lerp(from, to, fn(progress(frame, start, end)));

// 關鍵影格：每段可指定自己的 easing
export type Key<T> = {f: number; v: T; ease?: EaseFn};

const mixValue = <T,>(a: T, b: T, t: number): T => {
  if (typeof a === 'number') return lerp(a, b as number, t) as T;
  if (Array.isArray(a)) return (a as number[]).map((x, i) => lerp(x, (b as number[])[i], t)) as T;
  const out: Record<string, number> = {};
  for (const k of Object.keys(a as object)) out[k] = lerp((a as any)[k], (b as any)[k], t);
  return out as T;
};

export const keyframes = <T,>(frame: number, keys: Key<T>[]): T => {
  if (frame <= keys[0].f) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (frame <= k1.f) {
      const t = (k1.ease ?? ease.inOut)(progress(frame, k0.f, k1.f));
      return mixValue(k0.v, k1.v, t);
    }
  }
  return keys[keys.length - 1].v;
};

// 種子亂數（mulberry32）
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// 平滑雜訊（確定性），用於呼吸、微動
export const wobble = (frame: number, period: number, phase = 0) => Math.sin(((frame / period) + phase) * Math.PI * 2);
