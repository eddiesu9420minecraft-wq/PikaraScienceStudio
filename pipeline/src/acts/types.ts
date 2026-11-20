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
};
export type ActComponent = React.FC<ActProps>;
