import {getTimeline} from '../data/timeline';
import type {ActLine} from './types';

export type ActSpan = {
  id: string;
  title: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  anchors: Record<string, number>;
  lines: ActLine[];
  cues: {from: number; to: number; text: string}[];
};

type RawTl = {
  scenes: {id: string; title: string; startFrame: number; endFrame: number; durationFrames: number; anchors: Record<string, {local: number}>}[];
  lines: {id: string; scene: string; subtitle: string; audio: string; startFrame: number; durationFrames: number}[];
  cues: {from: number; to: number; text: string}[];
};

export const rawEp01 = () => getTimeline('ep01') as unknown as RawTl | null;

/** 從 timeline.generated.json（ep01）取出某一幕的範圍、本地錨點與本地字幕。 */
export const getAct = (actId: string): ActSpan => {
  const tl = rawEp01();
  const s = tl?.scenes?.find((x) => x.id === actId);
  if (!tl || !s) {
    return {id: actId, title: actId, startFrame: 0, endFrame: 600, durationFrames: 600, anchors: {}, lines: [], cues: []};
  }
  const anchors: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.anchors)) anchors[k] = v.local;
  return {
    id: s.id,
    title: s.title,
    startFrame: s.startFrame,
    endFrame: s.endFrame,
    durationFrames: s.durationFrames,
    anchors,
    lines: tl.lines
      .filter((l) => l.scene === actId)
      .map((l) => ({id: l.id, subtitle: l.subtitle, from: l.startFrame - s.startFrame, to: l.startFrame + l.durationFrames - s.startFrame})),
    cues: tl.cues.filter((c) => c.from >= s.startFrame && c.from < s.endFrame).map((c) => ({...c, from: c.from - s.startFrame, to: c.to - s.startFrame})),
  };
};

/** 取錨點；不存在時丟出錯誤（避免動畫默默失去同步）。 */
export const anchor = (anchors: Record<string, number>, name: string): number => {
  const v = anchors[name];
  if (v === undefined) throw new Error(`找不到旁白錨點：${name}`);
  return v;
};
