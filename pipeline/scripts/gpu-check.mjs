// npm run gpu:check — 實測 GPU 加速狀態（不是只看設定、也不是只看品牌）
//   node scripts/gpu-check.mjs [--force] [--codec h264|hevc]
//
// 兩種能力分開偵測：
//  1) 畫面渲染：Chromium（Remotion / Three.js）的 WebGL 是否走硬體 GPU。實際渲染一張 GpuProbe 靜態圖讀出 renderer 字串，
//     只要不是 SwiftShader／WARP／llvmpipe 等軟體實作，就算硬體加速（任何品牌）。
//  2) 影片編碼：交給 hwenc.mjs，依序實測 NVENC／AMF／QSV／VideoToolbox／VA-API／Media Foundation，最後是 libx264。
// 結束代碼：0 = WebGL 有硬體加速（GPU 模式可用）；1 = 沒有。編碼器不可用不算失敗，因為一定有 CPU 編碼備援。
// WebGL 結果快取在 out/gpu-check.json（同一個瀏覽器、同一組顯示卡 24 小時內有效），避免每次渲染都多開兩次 Chromium。
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromiumFlagsArg, ensureBrowser, remotion, ROOT, run} from './lib.mjs';
import {detectAdapters, probe} from './hwenc.mjs';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const codec = argv.includes('--codec') ? argv[argv.indexOf('--codec') + 1] : 'h264';
const OUT = join(ROOT, 'out', 'gpu-check.json');
const SOFTWARE = /SwiftShader|Basic Render|WARP|llvmpipe|softpipe|Software Rasterizer/i;
const GL = process.platform === 'linux' ? 'angle-egl' : 'angle';

const out = {time: new Date().toISOString(), ok: true, problems: [], warnings: []};
const fail = (msg) => {
  out.ok = false;
  out.problems.push(msg);
};

// 0) 顯示卡清單（只用於報告與排序）
out.adapters = detectAdapters();

// 1) NVIDIA 遙測（選用：只有 NVIDIA 驅動有 nvidia-smi；沒有也不影響其他品牌）
const smi = run('nvidia-smi', ['--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,pstate', '--format=csv,noheader,nounits']);
if (smi.code === 0) {
  const [name, driver, total, used, free, util, temp, pstate] = smi.out.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  out.nvidia = {name, driver, vramTotalMiB: +total, vramUsedMiB: +used, vramFreeMiB: +free, utilization: +util, temperatureC: +temp, pstate};
  if (+free < 1200) out.warnings.push(`NVIDIA VRAM 可用量只剩 ${free} MiB，請關閉其他使用 GPU 的程式（遊戲、llama.cpp、瀏覽器分頁）。`);
}
out.telemetry = out.nvidia ? 'nvidia-smi' : 'none';

// 2) WebGL 後端（Remotion/Three.js 實際使用的 GPU）——與編碼器無關
const browser = ensureBrowser() ?? '';
const sig = JSON.stringify([process.platform, browser, out.adapters.map((a) => `${a.vendorId}:${a.name}:${a.driver}`), process.env.PIKARA_RENDER_GPU_LUID ?? null, process.env.PIKARA_ADAPTER_LUID_FORMAT ?? null]);
let prev = null;
try {
  prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
} catch {}
if (!force && prev?.webglSig === sig && prev.webgl_angle?.renderer && Date.now() - Date.parse(prev.webglTime) < 24 * 3600 * 1000) {
  out.webgl_angle = prev.webgl_angle;
  out.webgl_swangle = prev.webgl_swangle;
  out.webglTime = prev.webglTime;
  out.webglCached = true;
} else {
  for (const gl of [GL, 'swangle']) {
    const r = remotion(['still', 'src/index.ts', 'GpuProbe', `out/probe-${gl}.png`, `--gl=${gl}`, '--log=verbose', ...(gl === 'swangle' ? [] : chromiumFlagsArg())]);
    // strip ANSI colours (CI terminals) and keep the whole log for diagnosis
    const plain = r.out.replace(/\u001b\[[0-9;]*m/g, '');
    try {
      mkdirSync(join(ROOT, 'out'), {recursive: true});
      writeFileSync(join(ROOT, 'out', `probe-${gl}.log`), plain);
    } catch {}
    const line = plain.split(/\r?\n/).find((l) => l.includes('[gpu-probe]') && l.includes('renderer'));
    const m = line?.match(/\\?"renderer\\?"\s*:\s*\\?"((?:[^"\\]|\\.)+?)\\?"/);
    out[gl === 'swangle' ? 'webgl_swangle' : 'webgl_angle'] = {renderer: m ? m[1] : null, gl, raw: m ? undefined : r.out.slice(-400)};
  }
  out.webglTime = out.time;
}
out.webglSig = sig;
const renderer = out.webgl_angle?.renderer ?? '';
const hardware = !!renderer && !SOFTWARE.test(renderer);
out.webgl_angle.backend = !renderer ? 'unavailable' : hardware ? 'hardware' : 'software';
out.webgl_angle.vendor = /NVIDIA/i.test(renderer) ? 'NVIDIA' : /AMD|Radeon/i.test(renderer) ? 'AMD' : /Intel/i.test(renderer) ? 'Intel' : /Apple/i.test(renderer) ? 'Apple' : 'other';
if (!hardware) {
  fail(`Chromium 的 WebGL 沒有使用硬體 GPU（目前：${renderer || '無法取得'}）。可能原因：驅動異常、遠端桌面工作階段、GPU 被停用。`);
} else if (out.adapters.length > 1 && out.webgl_angle.vendor !== 'NVIDIA' && out.adapters.some((a) => a.vendorId === '10de')) {
  // 雙顯卡筆電：WebGL 跑在內顯雖然可用，但通常比獨顯慢
  out.warnings.push(`WebGL 目前使用 ${renderer}，這台電腦還有 NVIDIA 獨立顯卡；若要更快，可在「Windows 設定 > 系統 > 顯示器 > 圖形」把 chrome-headless-shell.exe 設為「高效能」。`);
}

// 3) 影片編碼器（實測，有快取）
const enc = probe({codec, force, log: (m) => console.log(m)});
const sel = enc.results.find((r) => r.id === enc.selected);
out.encoder = {codec, selected: enc.selected, hardware: !!sel && sel.family !== 'cpu', fromCache: enc.fromCache, ffmpeg: enc.ffmpeg, results: enc.results};
if (!enc.ffmpeg) fail('找不到系統 ffmpeg。');
else if (!out.encoder.hardware) out.warnings.push(`沒有可用的硬體影片編碼器，會用 ${enc.selected ?? 'libx264'}（CPU）編碼：速度較慢，畫質相同。`);
// 舊欄位（Studio 0.2.1 以前讀這兩個）
out.ffmpeg = {path: enc.ffmpeg};
for (const r of enc.results) out.ffmpeg[r.id] = {listed: r.listed, works: r.works, ms: r.ms, error: r.error ?? undefined};

mkdirSync(join(ROOT, 'out'), {recursive: true});
writeFileSync(OUT, JSON.stringify(out, null, 2));

const n = out.nvidia;
console.log('\n=== Pikara GPU 加速檢查 ===');
console.log(`顯示卡     ${out.adapters.map((a) => a.name).join('；') || '未偵測到'}`);
if (n) console.log(`NVIDIA     ${n.name}｜驅動 ${n.driver}｜VRAM ${n.vramUsedMiB}/${n.vramTotalMiB} MiB｜${n.temperatureC}°C`);
console.log(`WebGL      ${renderer || '-'}  →  ${out.webgl_angle.backend}${out.webglCached ? '（快取）' : ''}`);
console.log(`軟體回退    ${out.webgl_swangle?.renderer ?? '-'}`);
for (const r of enc.results) console.log(`${r.id.padEnd(18)} ${r.works === true ? `可用（試編碼 ${r.ms} ms）` : r.works === null ? '未測試' : '不可用'}`);
console.log(`編碼器     ${enc.selected ?? '無'}${enc.fromCache ? '（快取）' : ''}`);
out.warnings.forEach((w) => console.log(' ! ' + w));
if (out.ok) console.log('\n結果：GPU 渲染可用 → npm run render:gpu');
else {
  console.log('\n結果：GPU 渲染不可用');
  out.problems.forEach((p) => console.log(' - ' + p));
  console.log('\n可改用 CPU 相容模式：npm run render:cpu');
}
process.exit(out.ok ? 0 : 1);
