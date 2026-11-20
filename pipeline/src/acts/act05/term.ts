import {palette as P} from '../../theme/palette';
import type {Rect} from './ui';

/** 開場終端機視窗的位置（2D 畫面與 3D 筆電螢幕貼圖共用，確保交叉溶接時完全重合）。 */
export const TERM: Rect = {x: 370, y: 336, w: 1180, h: 288};
export const TERM_BAR = 46;
export const TERM_FONT = 34;
export const TERM_PAD = 40;
export const TERM_BG = '#0D1322';
export const TERM_BAR_BG = '#131B2E';

/** 指令（-m / -ngl / -c 都是 llama.cpp 的真實參數） */
export const CMD_PARTS: {text: string; color: string; key?: string}[] = [
  {text: 'llama-cli', color: P.ice, key: 'bin'},
  {text: ' -m ', color: P.mist},
  {text: 'model-Q4_K_M.gguf', color: P.amber, key: 'model'},
  {text: ' -ngl ', color: P.mist},
  {text: '20', color: P.paper},
  {text: ' -c ', color: P.mist},
  {text: '4096', color: P.paper},
];
export const CMD = CMD_PARTS.map((p) => p.text).join('');
