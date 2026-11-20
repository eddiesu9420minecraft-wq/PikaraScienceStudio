import {rng} from '../../lib/anim';

// ---------------- 第 06 幕資料（全部為示意值） ----------------

/** 使用者的問題，切成 token（切法為示意；實際依分詞器而定）。 */
export const Q_TOKENS = ['AI', '是', '怎麼', '在', '我的', '電腦', '上', '運行', '的', '？'];
/** token 編號（示意值，不代表任何真實分詞器）。 */
export const Q_IDS = ['15836', '3221', '47201', '1840', '98330', '61552', '1741', '88019', '955', '8043'];

/** 模型回答（逐 token 產生）。 */
export const A_TOKENS = ['簡單', '來說', '，', '模型', '會', '在', '你的', '電腦', '上', '一步', '步', '算出', '回答', '。'];

/** 估算文字寬度（Noto Sans TC：中日韓全形字 = 1em）。 */
export const textW = (s: string, fs: number) => {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x2e80) w += 1;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[0-9]/.test(ch)) w += 0.58;
    else if (/[a-z]/.test(ch)) w += 0.56;
    else w += 0.4;
  }
  return w * fs;
};
/** 等寬字（Consolas）寬度。 */
export const monoW = (s: string, fs: number) => s.length * 0.55 * fs;

/** 每個 token 的向量（示意：-1..1）。 */
export const VEC_N = 8;
export const vecOf = (seed: number) => {
  const r = rng(seed * 7919 + 13);
  return Array.from({length: VEC_N}, () => Math.round((r() * 2 - 1) * 100) / 100);
};
export const Q_VECS = Q_TOKENS.map((_, i) => vecOf(i + 1));

// ---------------- 嵌入空間（3D 示意） ----------------
export type EmbWord = {text: string; pos: [number, number, number]; cluster?: number; q?: number};
export const CLUSTERS = [
  {name: '動物', center: [-2.5, 1.0, -0.6] as [number, number, number]},
  {name: '電腦硬體', center: [2.3, 0.9, 0.4] as [number, number, number]},
  {name: '水果', center: [-0.4, -1.0, 1.3] as [number, number, number]},
];
export const EMB_WORDS: EmbWord[] = [
  {text: '貓', pos: [-2.8, 1.35, -0.4], cluster: 0},
  {text: '狗', pos: [-2.15, 1.25, -0.9], cluster: 0},
  {text: '寵物', pos: [-2.55, 0.6, -0.5], cluster: 0},
  {text: '兔子', pos: [-3.05, 0.75, -1.0], cluster: 0},
  {text: 'GPU', pos: [2.65, 1.25, 0.15], cluster: 1},
  {text: '顯示卡', pos: [2.05, 1.35, 0.75], cluster: 1},
  {text: '晶片', pos: [2.5, 0.5, 0.75], cluster: 1},
  {text: '蘋果', pos: [-0.75, -0.75, 1.45], cluster: 2},
  {text: '香蕉', pos: [-0.05, -1.15, 1.2], cluster: 2},
  {text: '水果', pos: [-0.5, -1.35, 1.65], cluster: 2},
  {text: '橘子', pos: [0.15, -0.65, 1.7], cluster: 2},
];
/** 問題 token 在嵌入空間的位置（電腦 落在硬體群附近）。 */
export const Q_EMB: [number, number, number][] = [
  [1.6, 1.75, -0.6], // AI
  [0.3, 0.2, -1.6], // 是
  [-0.9, 0.55, -2.2], // 怎麼
  [0.75, -0.15, -2.1], // 在
  [-1.3, -0.3, -1.4], // 我的
  [1.85, 0.6, 0.15], // 電腦 → 硬體群
  [1.1, -0.55, -1.7], // 上
  [0.6, 0.95, -1.2], // 運行
  [-0.2, -0.45, -2.5], // 的
  [-0.15, 1.1, -2.0], // ？
];

// ---------------- Transformer 層（3D 示意） ----------------
export const SLAB_N = 6;
export const SLAB_Y = (k: number) => -1.7 + k * 0.78;
export const ATT_SLAB = 3;
export const ROW_X = (i: number) => (i - 4.5) * 0.66;
export const ROW_Y0 = -2.35;

// ---------------- Attention 例句 ----------------
export const ATT_WORDS = ['我', '把', '蘋果', '放進', '冰箱', '，', '因為', '它', '快', '壞了', '。'];
export const ATT_IT = 7;
/** 「它」對前面每個詞的注意力權重（示意，總和 = 1）。 */
export const ATT_W = [0.05, 0.03, 0.58, 0.06, 0.18, 0.02, 0.08];

// ---------------- logits / 取樣 ----------------
export type Cand = {t: string; l: number};
export const CANDS: Cand[][] = [
  [
    {t: '簡單', l: 4.2},
    {t: '其實', l: 3.4},
    {t: 'AI', l: 3.0},
    {t: '這', l: 2.5},
    {t: '你', l: 1.9},
    {t: '嗯', l: 0.8},
  ],
  [
    {t: '來說', l: 4.6},
    {t: '地', l: 2.2},
    {t: '講', l: 1.8},
    {t: '的', l: 1.6},
    {t: '說', l: 1.2},
    {t: '而言', l: 0.9},
  ],
  [
    {t: '，', l: 4.1},
    {t: '就是', l: 2.7},
    {t: 'AI', l: 1.9},
    {t: '它', l: 1.7},
    {t: '是', l: 1.2},
    {t: '模型', l: 1.0},
  ],
  [
    {t: '模型', l: 3.9},
    {t: 'AI', l: 3.1},
    {t: '它', l: 2.7},
    {t: '電腦', l: 2.0},
    {t: '你', l: 1.4},
    {t: '這', l: 1.0},
  ],
];

/** 機率 = softmax(logits / T)（只在畫面列出的候選上計算；其餘 token 機率極小，略去）。 */
export const softmax = (ls: number[], T: number) => {
  const z = ls.map((l) => l / T);
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
};
/** 依累積機率找出 u 落在哪個候選。 */
export const pick = (ps: number[], u: number) => {
  let acc = 0;
  for (let i = 0; i < ps.length; i++) {
    acc += ps[i];
    if (u < acc) return i;
  }
  return ps.length - 1;
};
