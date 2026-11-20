import type {ActLine} from '../types';

/**
 * 第 05 幕的錨點表。全部事件都從旁白錨點推算（不寫死影格）。
 * 若某個錨點暫時不存在（時間軸重建中），用估算版的相對位置按本幕長度縮放補上，避免整幕崩潰。
 */
const NAMES = [
  'intro', 'engine', 'tools', 'notmodel', 'ggml', 'cpu', 'cuda', 'laptop', 'ryzen', 'ram', 'rtx', 'ssd', 'load',
  'offload', 'gpulayers', 'cpulayers', 'why', 'parallel', 'bandwidth', 'readall', 'bottleneck', 'fast', 'analogy',
  'kv', 'store', 'context', 'grow', 'compete', 'tradeoff',
] as const;
export type AnchorName = (typeof NAMES)[number];
/** hook：開場提問句（若時間軸沒有這句，hook < 0，開場直接從終端機開始） */
export type A5 = Record<AnchorName, number> & {end: number; l12: number; hook: number};

// 時間軸（7723 幀版本）中的位置，只在錨點缺失時當備援比例使用
const FALLBACK: Record<AnchorName, number> = {
  intro: 663, engine: 1146, tools: 1260, notmodel: 1375, ggml: 1868, cpu: 1994, cuda: 2121, laptop: 2449, ryzen: 2587,
  ram: 2713, rtx: 2805, ssd: 3231, load: 3394, offload: 3544, gpulayers: 3877, cpulayers: 4072, why: 4183,
  parallel: 4413, bandwidth: 4621, readall: 4978, bottleneck: 5231, fast: 5622, analogy: 5703, kv: 6055, store: 6365,
  context: 6663, grow: 7100, compete: 7204, tradeoff: 7655,
};

export const resolveA5 = (anchors: Record<string, number>, duration: number, lines: ActLine[]): A5 => {
  const k = duration / 7723;
  const out = {} as A5;
  for (const n of NAMES) out[n] = anchors[n] ?? FALLBACK[n] * k;
  out.end = duration;
  out.hook = anchors.hook ?? -200;
  const l12 = lines.find((l) => l.id === 'a5-12');
  out.l12 = l12 ? l12.from : out.compete + (out.tradeoff - out.compete) * 0.19;
  return out;
};

export const keyOf = (a: A5) => NAMES.map((n) => Math.round(a[n])).join(',') + ':' + a.end;
