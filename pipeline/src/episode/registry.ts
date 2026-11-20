import type {ActComponent} from '../acts/types';
import {ACTS as EP01_ACTS} from '../acts/registry';
import {GenericAct} from './GenericAct';
import {getTimeline, timelineIds} from '../data/timeline';
import narration from '../data/narration.json';

/**
 * 多集登錄表：每一集 = narration.json 的 sequences.<epId>（例：ep01、ep02）。
 *  - 有手工動畫的集數在 CUSTOM_ACTS 列出各幕元件（id 必須對應 narration 的 scene id）。
 *  - 其他集數自動使用通用旁白樣板 GenericAct（章節標題＋由錨點驅動的關鍵詞卡片），每個 scene 一幕。
 * transitionIn：'iris' = 由 Episode 套用「資料點」收合／展開轉場；'self' = 本幕自行處理進場。
 */
export type ActEntry = {id: string; component: ActComponent; transitionIn: 'iris' | 'self'};

export const CUSTOM_ACTS: Record<string, ActEntry[]> = {
  // <studio:custom-acts>（Studio 建立新專案時會清空這個區塊，新專案的集數一律先用通用樣板）
  ep01: EP01_ACTS,
  // </studio:custom-acts>
};

/** 集數 id 規則：ep 加 2–3 位數字（ep01、ep02、ep120）。 */
export const EPISODE_ID = /^ep\d{2,3}$/;

/** 時間軸中已建立的集數（依編號排序）。尚未建立時間軸的集數不會註冊 composition。 */
export const episodeIds = (): string[] =>
  timelineIds()
    .filter((k) => EPISODE_ID.test(k))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

/** composition 前綴：ep02 → EP02 */
export const compPrefix = (epId: string) => epId.toUpperCase();

type Seq = {title?: string; scenes?: {id: string; title?: string}[]};
const sequences = (narration as unknown as {sequences: Record<string, Seq>}).sequences;

export const episodeTitle = (epId: string): string => sequences[epId]?.title ?? compPrefix(epId);

/** 某一集的幕列表：手工幕優先，否則依時間軸的 scenes 產生通用樣板幕。 */
export const actsFor = (epId: string): ActEntry[] => {
  const custom = CUSTOM_ACTS[epId];
  if (custom) return custom;
  const tl = getTimeline(epId) as unknown as {scenes?: {id: string}[]} | null;
  return (tl?.scenes ?? []).map((s, i) => ({id: s.id, component: GenericAct, transitionIn: i === 0 ? 'self' : 'iris'}));
};

export const hasCustomActs = (epId: string) => !!CUSTOM_ACTS[epId];
