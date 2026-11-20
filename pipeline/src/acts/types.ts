import type React from 'react';

/** 每一幕元件收到的資料（全部是「本幕本地影格」，0 = 本幕第一幀）。 */
export type ActLine = {id: string; subtitle: string; from: number; to: number};
export type ActProps = {
  frame: number; // 本幕本地影格（可為小數）
  durationInFrames: number;
  fps: number;
  /** 旁白錨點：名稱 → 本地影格。例：anchors.gpu 是旁白念出「GPU」的那一幀。 */
  anchors: Record<string, number>;
  lines: ActLine[];
  /** 以下為選用資訊（通用樣板 GenericAct 使用；EP01 手工幕不需要）。 */
  title?: string; // 本幕標題（narration.json scenes[].title）
  index?: number; // 第幾幕（0 起算）
  total?: number; // 本集幕數
  episodeId?: string; // 例：ep02
  episodeTitle?: string; // narration.json sequences.<ep>.title
  anchorWords?: Record<string, string>; // 錨點名稱 → 旁白中的詞
};
export type ActComponent = React.FC<ActProps>;
