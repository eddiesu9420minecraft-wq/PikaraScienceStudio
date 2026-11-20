// npm run benchmark [-- --frames 840-1019 --concurrency 3]
// 以相同幀段、相同並行數，比較 GPU（ANGLE/D3D11 + NVENC）與 CPU（SwiftShader + libx264）。
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT} from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
// 預設取 3D 最重的段落（X 光透視 → 晶片 → 矩陣）
const frames = opt('frames', '840-1019');
const concurrency = opt('concurrency', '3');

const results = {};
for (const mode of ['gpu', 'cpu']) {
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const out = join(ROOT, 'out', 'benchmark', `bench-${mode}.mp4`);
  mkdirSync(join(ROOT, 'out', 'benchmark'), {recursive: true});
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'render.mjs'), mode, '--frames', frames, '--concurrency', concurrency, '--out', out, '--skip-check', '--fresh'], {cwd: ROOT, stdio: 'inherit'});
  if (r.status !== 0) {
    console.error(`${mode} 失敗`);
    continue;
  }
  results[mode] = JSON.parse(readFileSync(join(ROOT, 'out', 'reports', `ArtTest-1080p-${mode}.json`), 'utf8'));
}

const g = results.gpu;
const c = results.cpu;
const row = (label, f, unit = '') => `| ${label} | ${g ? f(g) + unit : '-'} | ${c ? f(c) + unit : '-'} |`;
const md = [
  `# 渲染效能比較（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）`,
  '',
  `幀段 ${frames}（1920×1080），並行 ${concurrency}。GPU 模式先執行 \`npm run gpu:check\` 確認 WebGL 走 NVIDIA。`,
  '',
  '| 項目 | GPU（ANGLE D3D11 + h264_nvenc） | CPU（SwiftShader + libx264） |',
  '|---|---|---|',
  row('幀數', (x) => x.frames),
  row('渲染時間', (x) => x.seconds.render.toFixed(1), ' s'),
  row('渲染速度', (x) => x.renderFps.toFixed(1), ' fps'),
  row('編碼時間', (x) => x.seconds.encode.toFixed(1), ' s'),
  row('總時間', (x) => x.seconds.total.toFixed(1), ' s'),
  row('渲染期間 GPU 平均／峰值', (x) => `${x.render.gpuAvg.toFixed(0)}% / ${x.render.gpuPeak}%`),
  row('渲染期間 VRAM 峰值', (x) => x.render.vramPeakMiB, ' MiB'),
  row('渲染期間 CPU 平均／峰值', (x) => `${x.render.cpuAvg.toFixed(0)}% / ${x.render.cpuPeak.toFixed(0)}%`),
  row('編碼期間 NVENC 平均／峰值', (x) => `${x.encode.encoderAvg.toFixed(0)}% / ${x.encode.encoderPeak}%`),
  row('編碼期間 CPU 平均', (x) => x.encode.cpuAvg.toFixed(0), '%'),
  row('輸出位元率', (x) => (Number(x.ffprobe?.format?.bit_rate ?? 0) / 1e6).toFixed(1), ' Mb/s'),
  '',
  g && c ? `**GPU 模式總時間為 CPU 模式的 ${(g.seconds.total / c.seconds.total * 100).toFixed(0)}%（快 ${(c.seconds.total / g.seconds.total).toFixed(1)} 倍）。**` : '',
  '',
  '註：VRAM 峰值包含系統與其他程式已占用的量（基準值見 out/gpu-check.json）。取樣間隔 1 秒。',
].join('\n');
writeFileSync(join(ROOT, 'out', 'benchmark', 'BENCHMARK.md'), md);
console.log('\n' + md);
