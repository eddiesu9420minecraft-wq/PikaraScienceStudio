import {continueRender, delayRender, staticFile} from 'remotion';

// 中文字型：Noto Sans TC（SIL OFL 1.1），隨專案打包於 public/fonts，渲染不依賴網路。
export const FONT_FAMILY = 'PikaraSans';
export const fontStack = `${FONT_FAMILY}, "Noto Sans TC", "Microsoft JhengHei", sans-serif`;

let loaded = false;
export const ensureFonts = () => {
  if (loaded || typeof document === 'undefined') return;
  loaded = true;
  const handle = delayRender('Loading Noto Sans TC');
  const face = new FontFace(FONT_FAMILY, `url(${staticFile('fonts/NotoSansTC-VF.ttf')}) format('truetype')`, {
    weight: '100 900',
  });
  face
    .load()
    .then((f) => {
      (document.fonts as unknown as {add: (f: FontFace) => void}).add(f);
      continueRender(handle);
    })
    .catch((err) => {
      console.error('Font load failed', err);
      continueRender(handle);
    });
};

export const type = {
  display: {fontFamily: fontStack, fontWeight: 800, letterSpacing: '0.02em'},
  title: {fontFamily: fontStack, fontWeight: 700, letterSpacing: '0.04em'},
  label: {fontFamily: fontStack, fontWeight: 500, letterSpacing: '0.08em'},
  mono: {fontFamily: '"Cascadia Mono", "Consolas", monospace', fontWeight: 500},
} as const;
