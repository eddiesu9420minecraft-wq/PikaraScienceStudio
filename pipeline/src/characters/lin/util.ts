// 林予晴角色用的小工具：路徑插值、兩段式 IK、袖管形狀、確定性雜湊。
export type V = [number, number];

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const ramp = (f: number, a: number, b: number) => smooth((f - a) / (b - a));
export const mixV = (a: V, b: V, t: number): V => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
export const n2 = (v: number) => Math.round(v * 100) / 100;
export const pt = (p: V) => `${n2(p[0])} ${n2(p[1])}`;
export const deg = Math.PI / 180;

/** 確定性雜湊 → [0,1) */
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ---- 路徑插值：兩條命令結構相同的路徑逐數字線性插值 ----
type Tok = string | number;
const TOK = /[MLCQAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi;
const cache = new Map<string, Tok[]>();
const parse = (d: string): Tok[] => {
  let t = cache.get(d);
  if (!t) {
    t = (d.match(TOK) ?? []).map((x) => (/^[a-z]$/i.test(x) ? x : parseFloat(x)));
    cache.set(d, t);
  }
  return t;
};
export const mixPath = (a: string, b: string, t: number): string => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const A = parse(a);
  const B = parse(b);
  if (A.length !== B.length) throw new Error(`mixPath: structure mismatch ${A.length} vs ${B.length}`);
  return A.map((x, i) => (typeof x === 'number' ? n2(x + ((B[i] as number) - x) * t) : x)).join(' ');
};

export const rot = (p: V, c: V, degrees: number): V => {
  const r = degrees * deg;
  const s = Math.sin(r);
  const co = Math.cos(r);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * co - y * s, c[1] + x * s + y * co];
};

/** 兩段式 IK：回傳 [肘, 實際腕位置]。bend=1 時肘在 肩→腕 方向的右手側（SVG 座標為左下）。 */
export const ik = (s: V, w: V, l1: number, l2: number, bend = 1): [V, V] => {
  const dx = w[0] - s[0];
  const dy = w[1] - s[1];
  const D0 = Math.hypot(dx, dy) || 1e-3;
  const ux = dx / D0;
  const uy = dy / D0;
  const D = Math.min(Math.max(D0, Math.abs(l1 - l2) + 0.5), l1 + l2 - 0.5);
  const a = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const elbow: V = [s[0] + ux * a - uy * h * bend, s[1] + uy * a + ux * h * bend];
  const wrist: V = [s[0] + ux * D, s[1] + uy * D];
  return [elbow, wrist];
};

/** 由 a 到 b 的錐形袖管（兩側略鼓、兩端圓頭）。 */
export const limb = (a: V, b: V, ra: number, rb: number, bulge = 0): string => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1e-3;
  const ux = dx / L;
  const uy = dy / L;
  const nx = -uy;
  const ny = ux;
  const p1: V = [a[0] + nx * ra, a[1] + ny * ra];
  const p2: V = [b[0] + nx * rb, b[1] + ny * rb];
  const p3: V = [b[0] - nx * rb, b[1] - ny * rb];
  const p4: V = [a[0] - nx * ra, a[1] - ny * ra];
  const m: V = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const r = (ra + rb) / 2 + bulge;
  const c1: V = [m[0] + nx * r, m[1] + ny * r];
  const c2: V = [m[0] - nx * r, m[1] - ny * r];
  return `M ${pt(p1)} Q ${pt(c1)} ${pt(p2)} A ${n2(rb)} ${n2(rb)} 0 0 0 ${pt(p3)} Q ${pt(c2)} ${pt(p4)} A ${n2(ra)} ${n2(ra)} 0 0 0 ${pt(p1)} Z`;
};

// ---- 顏色混合 ----
const hexToRgb = (h: string) => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
export const mixHex = (a: string, b: string, t: number) => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return '#' + A.map((x, i) => Math.round(mix(x, B[i], t)).toString(16).padStart(2, '0')).join('');
};
