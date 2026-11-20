import {ease, lerp, progress} from '../../lib/anim';
import {anchor} from '../actData';
import type {Anchors} from './common';
import {A_TOKENS, Q_TOKENS, textW} from './data';

/** 生成段落（logits → 取樣 → 自回歸 → Prefill/Decode → token/s）的時間點。 */
export const genTimes = (A: Anchors) => {
  const g = (n: string) => anchor(A, n);
  const logits = g('logits');
  const append = g('append');
  const loop = g('loop');
  const prefill = g('prefill');
  const decode = g('decode');
  const tps = g('tps');
  const speed = g('speed');
  const spacing = Math.max(70, Math.min(100, (prefill - 400 - loop) / 2));
  const iter = (k: number) => loop + (k - 1) * spacing; // k = 1..3
  const dstep = (s: number) => decode - 10 + (s - 1) * 30; // s = 1..5
  const popT = (k: number) => tps + 40 + (k - 6) * ((speed + 10 - (tps + 40)) / 7); // k = 6..13
  const arrive = (k: number) => {
    if (k === 0) return append + 10;
    if (k <= 3) return iter(k) + 70;
    if (k <= 5) return dstep(k) + 26;
    return popT(k);
  };
  return {
    logits,
    score: g('score'),
    sample: g('sample'),
    lowT: g('lowT'),
    highT: g('highT'),
    append,
    loop,
    autoreg: g('autoreg'),
    prefill,
    decode,
    tps,
    speed,
    iter,
    dstep,
    popT,
    arrive,
    moveA: prefill - 330,
    moveB: prefill - 200,
  };
};

export const ROW_FS = 28;
export const ROW_H = 48;
export const chipW = (t: string) => textW(t, ROW_FS) + 26;

export type RowChip = {t: string; x: number; w: number; a: number; ans: boolean; k: number};

/** 上方（之後移到下方）的 token 序列：問題 token + 已產生的回答 token。 */
export const rowAt = (A: Anchors, f: number) => {
  const T = genTimes(A);
  const y = lerp(150, 600, ease.camera(progress(f, T.moveA, T.moveB)));
  const items: RowChip[] = Q_TOKENS.map((t, i) => ({t, x: 0, w: chipW(t), a: 1, ans: false, k: i}));
  for (let k = 0; k <= 5; k++) {
    const a = ease.out(progress(f, T.arrive(k) - 12, T.arrive(k) + 8));
    items.push({t: A_TOKENS[k], x: 0, w: chipW(A_TOKENS[k]), a, ans: true, k});
  }
  const gap = 10;
  // 下一個 token 的空位
  const slotW = 54;
  const total = items.reduce((s, it) => s + (it.w + gap) * it.a, 0) + slotW;
  let x = 960 - total / 2;
  for (const it of items) {
    it.x = x + (it.w * it.a) / 2;
    x += (it.w + gap) * it.a;
  }
  const slotX = x + slotW / 2;
  return {y, items, slotX};
};
