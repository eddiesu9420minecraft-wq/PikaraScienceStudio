// 第一階段 15 秒美術測試的鏡頭表（60fps，全域影格）
// 鏡頭之間以重疊區段銜接，形成連續鏡頭語言，而非硬切。
export const FPS = 60;
export const SHOT = {
  total: 900,
  deskStart: 0,
  deskEnd: 252, // 2D 桌面場景（210–252 與 3D 交疊溶接）
  deskGlassSweepStart: 196,
  gpuStart: 206, // 3D 世界開始
  gpuEnd: 812,
  xrayStart: 410, // 外殼抬起並透明化
  pulseStart: 452, // VRAM → GPU 資料流
  diveStart: 532, // 鏡頭潛入晶片
  matrixStart: 590, // 矩陣運算
  waveStart: 640,
  waveEnd: 704,
  pullStart: 716, // 拉遠
  brandStart: 752,
} as const;

/**
 * 樣板錨點：動畫設計時的關鍵影格。實際播放時由旁白時間軸（timeline.generated.json）的同名錨點決定位置。
 * 例如 gpu: 300 表示「顯示卡轉到展示角度」這一刻，會被對齊到旁白念出「GPU」的那一幀。
 */
export const TEMPLATE_ANCHORS: Record<string, number> = {
  enter: 128, // 按下 Enter、問題送出
  gpu: 300, // 顯示卡轉向鏡頭
  vram: 470, // VRAM 標註出現
  flow: 500, // 資料流
  chip: 538, // 潛入晶片
  multiply: 645, // 乘加波前
  brand: 754, // 品牌出現（畫面已轉暗）
};

// 可單獨渲染的鏡頭範圍（舊：樣板影格；有聲版改由 Root 依錨點計算）（Remotion Studio 中為獨立 Composition）
export const SHOT_RANGES = [
  {id: 'Shot1-Desk', from: 0, to: 240},
  {id: 'Shot2-GPU', from: 240, to: 480},
  {id: 'Shot3-Matrix', from: 480, to: 720},
  {id: 'Shot4-Brand', from: 720, to: 900},
] as const;
