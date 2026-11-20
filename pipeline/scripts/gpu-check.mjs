// npm run gpu:check — 實測 GPU 加速狀態（不是只看設定）
import {mkdirSync, writeFileSync} from 'node:fs';
import {findFfmpeg, remotion, run} from './lib.mjs';

const out = {time: new Date().toISOString(), ok: true, problems: []};
const fail = (msg) => {
  out.ok = false;
  out.problems.push(msg);
};

// 1) NVIDIA 驅動與顯示卡
const smi = run('nvidia-smi', ['--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,pstate', '--format=csv,noheader,nounits']);
if (smi.code !== 0) {
  fail('找不到 nvidia-smi：NVIDIA 驅動未安裝或顯示卡被停用。');
} else {
  const [name, driver, total, used, free, util, temp, pstate] = smi.out.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  out.nvidia = {name, driver, vramTotalMiB: +total, vramUsedMiB: +used, vramFreeMiB: +free, utilization: +util, temperatureC: +temp, pstate};
  if (+free < 1200) fail(`VRAM 可用量只剩 ${free} MiB，請關閉其他使用 GPU 的程式（遊戲、llama.cpp、瀏覽器分頁）。`);
}

// 2) FFmpeg NVENC
const ffmpeg = findFfmpeg();
out.ffmpeg = {path: ffmpeg};
if (!ffmpeg) fail('找不到系統 ffmpeg（需要含 NVENC 的版本，例如 gyan.dev full build）。');
else {
  const enc = run('ffmpeg', ['-hide_banner', '-encoders']).out;
  for (const codec of ['h264_nvenc', 'hevc_nvenc']) {
    const listed = enc.includes(codec);
    const t0 = Date.now();
    const test = listed ? run('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60', '-t', '2', '-c:v', codec, '-preset', 'p5', '-f', 'null', '-']) : {code: -1, out: ''};
    out.ffmpeg[codec] = {listed, works: test.code === 0, ms: Date.now() - t0, error: test.code === 0 ? undefined : test.out.split(/\r?\n/).filter((l) => /error|cannot|failed/i.test(l)).slice(-3).join(' | ')};
    if (!listed) fail(`ffmpeg 沒有編譯 ${codec}。`);
    else if (test.code !== 0) fail(`${codec} 實際編碼失敗：${out.ffmpeg[codec].error}（常見原因：驅動過舊、顯示卡被 Windows 切到內顯、同時編碼工作過多）`);
  }
}

// 3) Chromium WebGL 後端（Remotion/Three.js 實際使用的 GPU）
for (const gl of ['angle', 'swangle']) {
  const r = remotion(['still', 'src/index.ts', 'GpuProbe', `out/probe-${gl}.png`, `--gl=${gl}`, '--log=verbose']);
  const line = r.out.split(/\r?\n/).find((l) => l.includes('[gpu-probe]'));
  const m = line?.match(/"renderer":"([^"]+)"/);
  out[`webgl_${gl}`] = {renderer: m ? m[1] : null, raw: m ? undefined : r.out.slice(-400)};
}
const renderer = out.webgl_angle?.renderer ?? '';
out.webgl_angle.backend = /SwiftShader/i.test(renderer) ? 'software (SwiftShader)' : /Basic Render/i.test(renderer) ? 'software (Microsoft WARP)' : /NVIDIA/i.test(renderer) ? 'NVIDIA hardware' : /AMD|Radeon/i.test(renderer) ? 'AMD integrated GPU' : 'unknown';
if (!/NVIDIA/i.test(renderer)) {
  fail(
    `Chromium 的 WebGL 沒有使用 NVIDIA 顯示卡（目前：${renderer || '無'}）。` +
      (/Radeon|AMD/i.test(renderer)
        ? ' 請在「Windows 設定 > 系統 > 顯示器 > 圖形」把 chrome-headless-shell.exe 設為「高效能」。'
        : ' 可能原因：驅動異常、遠端桌面工作階段、或 GPU 被停用。'),
  );
}

mkdirSync('out', {recursive: true});
writeFileSync('out/gpu-check.json', JSON.stringify(out, null, 2));

const n = out.nvidia;
console.log('\n=== Pikara GPU 加速檢查 ===');
console.log(`顯示卡     ${n ? `${n.name}｜驅動 ${n.driver}｜VRAM ${n.vramUsedMiB}/${n.vramTotalMiB} MiB｜${n.temperatureC}°C` : '未偵測到'}`);
console.log(`WebGL     ${renderer}  →  ${out.webgl_angle.backend}`);
console.log(`軟體回退   ${out.webgl_swangle?.renderer ?? '-'}`);
for (const c of ['h264_nvenc', 'hevc_nvenc']) {
  const e = out.ffmpeg?.[c];
  console.log(`${c.padEnd(10)} ${e?.works ? `可用（2 秒 1080p60 測試 ${e.ms} ms）` : '不可用'}`);
}
if (out.ok) console.log('\n結果：GPU 加速可用 → npm run render:gpu');
else {
  console.log('\n結果：GPU 加速不完整');
  out.problems.forEach((p) => console.log(' - ' + p));
  console.log('\n可改用 CPU 相容模式：npm run render:cpu');
}
process.exit(out.ok ? 0 : 1);
