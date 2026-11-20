import narration from './narration.json';
import type {Cue} from '../components/Subtitles';

/** 配音稿單一來源是 narration.json（Python 產生器與 Remotion 共用）。 */
export const NARRATION = narration;

/** 無時間軸時（尚未產生旁白）的備用字幕。 */
export const TEST_CUES: Cue[] = [
  {from: 24, to: 132, text: '當你向 AI 提出一個問題時，'},
  {from: 132, to: 250, text: '你有沒有想過，電腦究竟做了什麼？'},
];
