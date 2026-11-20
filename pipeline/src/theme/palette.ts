// Pikara Science — 統一色彩系統
// 原則：低飽和深色基底 + 兩個資訊色（琥珀＝權重/正值，冰藍＝資料/負值），避免廉價漸層與過度發光。
export const palette = {
  ink: '#090D18', // 最深背景
  night: '#0F1626',
  wall: '#151E33',
  wallLight: '#1C2740',
  floor: '#10172A',
  line: '#2A3654',
  mist: '#8A97B4', // 次要文字
  paper: '#EEF1F7', // 主要文字
  amber: '#FFB547', // 品牌主色、權重正值
  amberDeep: '#E08A1E',
  ice: '#5CC8FF', // 資料流、負值
  iceDeep: '#2C7FD0',
  mint: '#7FE0C2', // 輔助（少量使用）
  wood: '#3B2D2A',
  woodTop: '#5A4038',
  woodEdge: '#715147',
  metal: '#2B3242',
  metalLight: '#465067',
  pcb: '#10231E',
  copper: '#C7834F',
  gold: '#D9A441',
  // 人物「林予晴」專用色（跨場景固定）
  skin: '#E9B994',
  skinShadow: '#C98E72',
  skinLight: '#F6D2B5',
  hair: '#1D1922',
  hairLight: '#3A3143',
  hoodie: '#2E5E6C',
  hoodieShadow: '#21454F',
  hoodieLight: '#4C8C9B',
  pants: '#262B3A',
  pantsShadow: '#1B1F2B',
  shoe: '#D9DCE4',
  shoeSole: '#9AA0AE',
} as const;

export type PaletteKey = keyof typeof palette;
