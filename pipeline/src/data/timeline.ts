import raw from './timeline.generated.json';
import type {Cue} from '../components/Subtitles';

export type TimelineLine = {id: string; scene: string; subtitle: string; audio: string; start: number; startFrame: number; durationFrames: number};
export type Timeline = {
  id: string;
  fps: number;
  totalFrames: number;
  lines: TimelineLine[];
  cues: (Cue & {start: number; end: number})[];
  anchors: Record<string, {frame: number; time: number; word: string; line: string}>;
  mix?: string; // 後製混音檔（public 相對路徑），由 scripts/mix_audio.py 寫入
};

const all = raw as unknown as Record<string, Timeline>;
export const getTimeline = (id: string): Timeline | null => all[id] ?? null;
