// 渲染關鍵幀 PNG 供美術檢查（GPU / ANGLE）。
//   node scripts/stills.mjs <frames> [compId] [entry]
//   例：node scripts/stills.mjs 0,120,600 EP01-Act02 src/entries/act02.tsx
// 每個 entry 用獨立的 bundle 資料夾（build-<entry>），多人／多代理同時檢查互不干擾。
// 輸出：out/stills/<compId>-<frame>.png
import {mkdirSync} from 'node:fs';
import {remotion} from './lib.mjs';

const frames = (process.argv[2] ?? '0,60,120,180,240').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const comp = process.argv[3] ?? 'ArtTest';
const entry = process.argv[4] ?? 'src/index.ts';
const gl = process.env.PIKARA_GL ?? 'angle';
// 低解析度預覽：PIKARA_STILL_SCALE=0.33 → 640×360 JPEG（Studio 即時監控的分鏡預覽），輸出 out/preview/
const scale = Number(process.env.PIKARA_STILL_SCALE || '1');
const low = scale > 0 && scale < 1;
const buildDir = 'build-' + entry.replace(/[^a-zA-Z0-9]+/g, '_');
mkdirSync(low ? 'out/preview' : 'out/stills', {recursive: true});
const b = remotion(['bundle', entry, `--out-dir=${buildDir}`]);
if (b.code !== 0) {
  console.error('[bundle 失敗]\n' + b.out.slice(-4000));
  process.exit(1);
}
let failed = 0;
for (const f of frames) {
  const out = low ? `out/preview/${comp}-${String(f).padStart(5, '0')}.jpeg` : `out/stills/${comp}-${String(f).padStart(5, '0')}.png`;
  const r = remotion(['still', buildDir, comp, out, `--frame=${f}`, `--gl=${gl}`, ...(low ? [`--scale=${scale}`, '--image-format=jpeg', '--jpeg-quality=80'] : [])]);
  if (r.code === 0) console.log(`${f} → ${out}`);
  else {
    failed++;
    console.log(`${f} 失敗：\n${r.out.slice(-2500)}`);
  }
}
process.exit(failed ? 1 : 0);
