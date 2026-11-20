import {clamp} from './anim';

/**
 * 旁白驅動的時間映射：動畫用「樣板影格」設計，旁白決定「實際影格」。
 * pairs: [實際影格, 樣板影格]（遞增）。分段線性後做盒狀濾波，避免錨點處速度突變。
 * 例：旁白念到「GPU」的實際影格 619 ↔ 樣板中 GPU 轉到展示角度的影格 300。
 */
export type WarpPair = [number, number];

export const makeWarp = (pairs: WarpPair[], smooth = 18) => {
  const p = [...pairs].sort((a, b) => a[0] - b[0]);
  const raw = (f: number) => {
    if (f <= p[0][0]) return p[0][1] + (f - p[0][0]) * slope(0);
    for (let i = 0; i < p.length - 1; i++) {
      if (f <= p[i + 1][0]) {
        const t = clamp((f - p[i][0]) / (p[i + 1][0] - p[i][0]));
        return p[i][1] + (p[i + 1][1] - p[i][1]) * t;
      }
    }
    const n = p.length - 1;
    return p[n][1] + (f - p[n][0]) * slope(n - 1);
  };
  function slope(i: number) {
    return (p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]);
  }
  const lo = p[0][1];
  const hi = p[p.length - 1][1];
  return (f: number) => {
    let s = 0;
    for (let k = -smooth; k <= smooth; k++) s += raw(f + k);
    return Math.min(hi, Math.max(lo, s / (smooth * 2 + 1)));
  };
};
