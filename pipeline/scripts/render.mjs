// 渲染管線（分段、可中斷續傳、動態並行）：
//   node scripts/render.mjs <gpu|cpu|preview> [--comp EP01|EP02-30fps|EP02-YT15…] [--seq ep02] [--codec h264|hevc] [--concurrency N] [--frames a-b]
//                           [--chunk 1800] [--out file] [--allow-cpu-fallback] [--skip-check] [--fresh]
//  gpu     1920×1080 60fps：Chromium WebGL 走 ANGLE/D3D11（RTX 4050），h264_nvenc 高畫質編碼
//  cpu     相容模式：SwiftShader 軟體 WebGL + libx264
//  preview 1280×720 快速預覽
//
// 設計：
//  - 只 bundle 一次；整片切成多個區段（預設 1800 幀＝30 秒），每段完成後把幀檔改名為固定 6 位數編號，
//    存到 out/frames/<tag>/。中斷後重新執行同一指令，會跳過已完成的區段（--fresh 才會清空重來）。
//  - 每段開始前讀 nvidia-smi（VRAM、溫度、熱降頻旗標），依上一段實測的「每個分頁 VRAM」動態決定並行數：
//    VRAM 目標上限 5300 MiB；出現熱降頻或溫度 ≥ 87°C 就降一級；穩定且有餘裕時升一級（上限 8，受 CPU 執行緒限制）。
//  - 全程每 2 秒記錄 GPU 使用率、VRAM、溫度、功耗、SM 時脈、NVENC 使用率與 CPU 使用率到報告。
//  - 不修改任何 GPU 功耗、時脈或散熱設定，保留原廠保護機制。
import {spawn, execFile} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {ensureBrowser, remotionBin, ROOT, run, findFfmpeg} from './lib.mjs';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'gpu';
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);
const comp = opt('comp', 'EP01');
const SRC = opt('src', 'src'); // 例：--src src_cn（大陸簡體版）
const MIXNAME = opt('mix', null); // 例：--mix ep01_cn
// 集數由 composition 名稱推得：EP02 / EP02-30fps / EP02-YT15 / EP02-Act03 → ep02（--seq 可覆寫）
const EP_COMP = /^(EP\d{2,3}|TEST\d{3})(?:-(30fps|YT15|Act\d+))?$/i.exec(comp);
const VARIANT = EP_COMP ? (EP_COMP[2] ?? '').toLowerCase() : null; // '' | '30fps' | 'yt15' | 'actNN'
const SPEED = VARIANT === 'yt15' ? 1.5 : 1; // 1.5 倍速版：音訊 atempo=1.5（音調不變）
const codec = opt('codec', 'h264');
const isPreview = mode === 'preview';
const CHUNK = Number(opt('chunk', 1800));
const VRAM_CAP = Number(opt('vram-cap', 5300));
const MAX_CONC = Math.min(8, Math.max(1, Math.floor(os.cpus().length / 2)));

const smi = () => {
  const r = run('nvidia-smi', ['--query-gpu=memory.used,memory.total,temperature.gpu,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown', '--format=csv,noheader,nounits']);
  if (r.code !== 0) return null;
  const [used, total, temp, hw, sw] = r.out.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  return {used: +used, total: +total, temp: +temp, throttle: hw === 'Active' || sw === 'Active'};
};

// ---- GPU 可用性：實測，不是假設 ----
let useGpu = mode !== 'cpu';
if (useGpu && !flag('skip-check')) {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'gpu-check.mjs')]);
  const p = join(ROOT, 'out', 'gpu-check.json');
  const info = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {problems: ['gpu-check 沒有輸出']};
  if (r.code !== 0) {
    console.error('GPU 加速不可用：\n - ' + (info.problems ?? []).join('\n - '));
    if (isPreview || flag('allow-cpu-fallback')) {
      console.error('→ 改用 CPU 相容模式繼續。');
      useGpu = false;
    } else {
      console.error('\n未自動降級（避免在你不知情時用軟體渲染）。請排除上述問題，或執行：npm run render:cpu');
      process.exit(1);
    }
  } else {
    console.log(`GPU：${info.webgl_angle.renderer}`);
  }
}
if (!findFfmpeg()) {
  console.error('找不到系統 ffmpeg。');
  process.exit(1);
}

// 取得總幀數
const tlPath = join(ROOT, SRC, 'data', 'timeline.generated.json');
if (!existsSync(tlPath)) {
  console.error(`[錯誤] 找不到 ${SRC}/data/timeline.generated.json。${SRC === 'src_cn' ? '請先執行 make_cn.py 產生簡體版原始碼，再建立簡體時間軸。' : '請先執行 build_timeline.py。'}`);
  process.exit(1);
}
const tlAll = JSON.parse(readFileSync(tlPath, 'utf8'));
const seqId = opt('seq', EP_COMP ? EP_COMP[1].toLowerCase() : comp === 'ArtTest' ? 'arttest' : null);
if (seqId && !tlAll[seqId] && (EP_COMP || comp === 'ArtTest')) {
  console.error(`[錯誤] ${SRC}/data/timeline.generated.json 裡沒有 ${seqId} 的時間軸。請先產生配音並執行 build_timeline.py --seq ${seqId}${SRC === 'src' ? '' : ' --src ' + SRC}。`);
  process.exit(1);
}
const FPS_OUT = VARIANT === '30fps' || VARIANT === 'yt15' ? 30 : 60;
const seqFrames = seqId && tlAll[seqId] ? tlAll[seqId].totalFrames : null;
const totalFrames =
  seqFrames == null ? null : comp === 'ArtTest' || VARIANT === '' ? seqFrames : VARIANT === '30fps' ? Math.ceil(seqFrames / 2) : VARIANT === 'yt15' ? Math.ceil(seqFrames / 3) : null;
// ---- 1) bundle（只做一次）----
const t0 = Date.now();
const BUILD = SRC === 'src' ? 'build' : `build-${SRC}`;
const b = run(process.execPath, [remotionBin, 'bundle', `${SRC}/index.ts`, `--out-dir=${BUILD}`]);
if (b.code !== 0) {
  console.error(b.out);
  process.exit(1);
}
const [rangeA, rangeB] = opt('frames', null)?.split('-').map(Number) ?? [0, (totalFrames ?? Number(opt('total', 0))) - 1];
if (!(rangeB >= rangeA)) {
  console.error('無法得知總幀數，請用 --frames a-b 指定。');
  process.exit(1);
}

const tag = `${SRC === 'src' ? '' : SRC + '-'}${comp}-${isPreview ? '720p' : '1080p'}-${useGpu ? 'gpu' : 'cpu'}`;
const frameDir = join(ROOT, 'out', 'frames', tag);
if (flag('fresh')) rmSync(frameDir, {recursive: true, force: true});
// 續傳安全：幀檔只在「同一份原始碼＋同一條時間軸」時沿用；改稿或改動畫後自動清除舊幀，避免新舊畫面混在一起
const fingerprint = (() => {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true}).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|json|css)$/.test(e.name) && !/^(timeline\.generated|narration)\.json$/.test(e.name)) h.update(p.slice(ROOT.length)).update(readFileSync(p));
    }
  };
  walk(join(ROOT, SRC));
  const seqTl = seqId && tlAll[seqId] ? {...tlAll[seqId], mix: undefined} : null; // 混音路徑不影響畫面
  const narP = join(ROOT, SRC, 'data', 'narration.json');
  const nar = existsSync(narP) ? JSON.parse(readFileSync(narP, 'utf8')).sequences?.[seqId] ?? null : null;
  h.update(JSON.stringify(seqTl)).update(JSON.stringify(nar?.title ?? null)).update(comp).update(isPreview ? 'p' : 'f');
  return h.digest('hex').slice(0, 16);
})();
const fpFile = join(frameDir, 'fingerprint.txt');
// 場景級增量渲染：本集每個場景一個指紋（共用程式碼 + 該場景的幕元件 + 該場景的時間軸片段）。
// 只有某幾個場景的動畫或旁白改變時（例如 QA／畫面審查修正了 S03.tsx），只刪除那幾個場景範圍（前後各多 1 秒，涵蓋轉場）的幀；
// 共用程式碼、場景數量或整體長度改變時才全部重來。
const sceneFp = (() => {
  const seqTl = seqId && tlAll[seqId];
  if (!seqTl || !Array.isArray(seqTl.scenes) || !seqTl.scenes.length || !EP_COMP || !['', '30fps', 'yt15'].includes(VARIANT)) return null;
  const actDir = join(ROOT, SRC, 'acts', seqId);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true}).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|json|css)$/.test(e.name) && !/^(timeline\.generated|narration)\.json$/.test(e.name)) files.push(p);
    }
  };
  walk(join(ROOT, SRC));
  const sceneOf = (p) => {
    if (!p.startsWith(actDir)) return null;
    const base = p.slice(actDir.length + 1).split(/[\/]/)[0].replace(/\.(tsx?)$/, '').toLowerCase();
    return seqTl.scenes.find((s) => s.id.toLowerCase() === base)?.id ?? null;
  };
  const common = createHash('sha256');
  const per = Object.fromEntries(seqTl.scenes.map((s) => [s.id, createHash('sha256')]));
  for (const p of files) {
    const sid = sceneOf(p);
    (sid ? per[sid] : common).update(p.slice(ROOT.length)).update(readFileSync(p));
  }
  const narP = join(ROOT, SRC, 'data', 'narration.json');
  const nar = existsSync(narP) ? JSON.parse(readFileSync(narP, 'utf8')).sequences?.[seqId] ?? null : null;
  const {scenes: _s, lines: _l, mix: _m, ...rest} = seqTl;
  common.update(JSON.stringify(rest)).update(JSON.stringify(nar?.title ?? null)).update(comp).update(isPreview ? 'p' : 'f');
  const ratio = FPS_OUT === 60 ? 1 : VARIANT === 'yt15' ? 1 / 3 : 1 / 2;
  const margin = FPS_OUT;
  const out = {v: 2, common: common.digest('hex').slice(0, 16), total: seqTl.totalFrames, scenes: {}};
  for (const s of seqTl.scenes) {
    const lines = (seqTl.lines ?? []).filter((l) => l.scene === s.id || (l.startFrame >= s.startFrame && l.startFrame < s.endFrame));
    per[s.id].update(JSON.stringify(s)).update(JSON.stringify(lines));
    out.scenes[s.id] = {hash: per[s.id].digest('hex').slice(0, 16), a: Math.max(0, Math.floor(s.startFrame * ratio) - margin), z: Math.ceil(s.endFrame * ratio) + margin};
  }
  return out;
})();
const sceneFile = join(frameDir, 'fingerprint.scenes.json');
if (existsSync(frameDir) && readdirSync(frameDir).some((f) => f.endsWith('.jpeg'))) {
  const old = existsSync(fpFile) ? readFileSync(fpFile, 'utf8').trim() : null;
  const oldScenes = existsSync(sceneFile) ? JSON.parse(readFileSync(sceneFile, 'utf8')) : null;
  if (old !== null && old !== fingerprint) {
    const sameShape = sceneFp && oldScenes && oldScenes.v === 2 && oldScenes.common === sceneFp.common && oldScenes.total === sceneFp.total &&
      Object.keys(oldScenes.scenes).join() === Object.keys(sceneFp.scenes).join();
    if (sameShape) {
      const changed = Object.entries(sceneFp.scenes).filter(([id, s]) => oldScenes.scenes[id].hash !== s.hash);
      let removed = 0;
      for (const [, s] of changed) {
        for (let f = s.a; f <= s.z; f++) {
          const p = join(frameDir, `f${String(f).padStart(6, '0')}.jpeg`);
          if (existsSync(p)) { rmSync(p, {force: true}); removed++; }
        }
      }
      console.log(`  場景級增量渲染：${changed.length}/${Object.keys(sceneFp.scenes).length} 個場景有變更（${changed.map(([id]) => id).join('、') || '無'}），清除 ${removed} 幀，其餘沿用`);
    } else {
      console.log(`  原始碼或時間軸已變更（${old} → ${fingerprint}），清除舊幀後重新渲染`);
      rmSync(frameDir, {recursive: true, force: true});
    }
  }
}
mkdirSync(frameDir, {recursive: true});
writeFileSync(fpFile, fingerprint);
if (sceneFp) writeFileSync(sceneFile, JSON.stringify(sceneFp));
const outFile = opt('out', join(ROOT, 'out', isPreview ? `${comp}-preview-720p.mp4` : `${comp}-${useGpu ? 'gpu' : 'cpu'}-1080p60.mp4`));
const fname = (f) => join(frameDir, `f${String(f).padStart(6, '0')}.jpeg`);

// ---- 2) 監控取樣（每 2 秒）----
const samples = [];
let phase = 'render';
let lastCpu = os.cpus();
const sampler = setInterval(() => {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const a = lastCpu[i].times;
    const z = c.times;
    total += Object.keys(z).reduce((s, k) => s + (z[k] - a[k]), 0);
    idle += z.idle - a.idle;
  });
  lastCpu = now;
  const cpu = total ? 100 * (1 - idle / total) : 0;
  const ph = phase;
  execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,utilization.encoder,power.draw,temperature.gpu,clocks.sm,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown', '--format=csv,noheader,nounits'], (err, stdout) => {
    if (err) return;
    const p = stdout.trim().split(',').map((s) => s.trim());
    samples.push({t: Date.now(), phase: ph, cpu: +cpu.toFixed(1), gpu: +p[0], vramMiB: +p[1], enc: +p[2], powerW: +p[3], tempC: +p[4], smMHz: +p[5], throttle: p[6] === 'Active' || p[7] === 'Active'});
  });
}, 2000);

// ---- 3) 分段渲染 ----
const browser = ensureBrowser();
const base = smi();
const baselineVram = base?.used ?? 2000;
let concurrency = Number(opt('concurrency', 0)) || Number(opt('start-concurrency', 0)) || (useGpu ? 4 : MAX_CONC);
let perTab = 350; // MiB，第一段後以實測更新
const chunks = [];
for (let a = rangeA; a <= rangeB; a += CHUNK) chunks.push([a, Math.min(rangeB, a + CHUNK - 1)]);
console.log(`渲染 ${comp}：${rangeB - rangeA + 1} 幀，${chunks.length} 段（每段 ${CHUNK} 幀），${useGpu ? 'GPU：ANGLE / D3D11' : 'CPU：SwiftShader'}；VRAM 基準 ${baselineVram} MiB，上限 ${VRAM_CAP} MiB`);

const chunkLog = [];
const tr = Date.now();
for (const [a, z] of chunks) {
  let have = 0;
  let m1 = -1;
  let m2 = -1;
  for (let f = a; f <= z; f++) {
    if (existsSync(fname(f))) have++;
    else { if (m1 < 0) m1 = f; m2 = f; }
  }
  if (have === z - a + 1) {
    console.log(`  區段 ${a}–${z}：已完成，略過`);
    continue;
  }
  // 只渲染這一段中缺少的範圍（場景級增量渲染只刪除變更場景的幀）
  const need = m2 - m1 + 1;
  if (need < z - a + 1) console.log(`  ↻ ${a}–${z} 這一段沿用 ${have} 幀，只渲染 ${m1}–${m2}`);
  const tmp = join(frameDir, `_chunk_${a}`);
  rmSync(tmp, {recursive: true, force: true});
  const cs = Date.now();
  const startIdx = samples.length;
  const args = [
    remotionBin, 'render', BUILD, comp, tmp,
    '--sequence', '--image-format=jpeg', `--jpeg-quality=${isPreview ? 88 : 95}`,
    `--gl=${useGpu ? 'angle' : 'swangle'}`, `--concurrency=${concurrency}`,
    `--frames=${m1}-${m2}`, '--log=error',
    ...(isPreview ? ['--scale=0.6666667'] : []),
    ...(browser ? [`--browser-executable=${browser}`] : []),
  ];
  const code = await new Promise((res) => {
    const p = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let tail = '';
    const onData = (d) => (tail = (tail + d.toString()).slice(-4000));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (c) => {
      if (c !== 0) console.error('\n' + tail);
      res(c);
    });
  });
  if (code !== 0) {
    clearInterval(sampler);
    console.error(`區段 ${a}–${z} 失敗。已完成的區段都保留；修正後重新執行同一指令即可續傳。`);
    process.exit(1);
  }
  // 改名成固定 6 位數編號並移入共用資料夾
  for (const f of readdirSync(tmp)) {
    const m = f.match(/(\d+)\.jpeg$/);
    if (m) renameSync(join(tmp, f), fname(parseInt(m[1], 10)));
  }
  rmSync(tmp, {recursive: true, force: true});
  const secs = (Date.now() - cs) / 1000;
  const cs_ = samples.slice(startIdx);
  const peak = cs_.length ? Math.max(...cs_.map((s) => s.vramMiB)) : baselineVram;
  const throttled = cs_.some((s) => s.throttle);
  const hot = cs_.length ? Math.max(...cs_.map((s) => s.tempC)) : 0;
  const gpuAvg = cs_.length ? cs_.reduce((s, x) => s + x.gpu, 0) / cs_.length : 0;
  chunkLog.push({a, z, concurrency, secs, fps: need / secs, peakVram: peak, maxTemp: hot, throttled, gpuAvg});
  console.log(`  區段 ${a}–${z}：${secs.toFixed(0)}s，${(need / secs).toFixed(1)} fps，並行 ${concurrency}，GPU 平均 ${gpuAvg.toFixed(0)}%，VRAM 峰值 ${peak} MiB，最高 ${hot}°C${throttled ? '，⚠ 熱降頻' : ''}`);
  // 動態調整並行數
  if (useGpu && !opt('concurrency', null)) {
    perTab = Math.max(150, (peak - baselineVram) / concurrency);
    const byVram = Math.floor((VRAM_CAP - baselineVram) / perTab);
    let next = Math.min(MAX_CONC, byVram);
    if (throttled || hot >= 87) next = Math.min(next, concurrency - 1);
    else if (next > concurrency) next = concurrency + 1; // 一次只升一級
    concurrency = Math.max(1, next);
  }
}
const renderMs = Date.now() - tr;

// ---- 4) 編碼（NVENC 或 libx264）並混入後製音軌 ----
const waitFile = opt('wait-file', null);
if (waitFile) {
  const ws = Date.now();
  while (!existsSync(join(ROOT, waitFile)) && Date.now() - ws < 15 * 60 * 1000) await new Promise((r) => setTimeout(r, 2000));
  console.log(existsSync(join(ROOT, waitFile)) ? '混音已完成，開始編碼' : '⚠ 等待混音逾時，仍以現有混音檔編碼');
}
phase = 'encode';
const mix = MIXNAME ? join(ROOT, 'public', 'assets', 'audio', 'mix', `${MIXNAME}.wav`) : seqId && tlAll[seqId]?.mix ? join(ROOT, 'public', tlAll[seqId].mix) : null;
const audioArgs = mix && existsSync(mix) && (comp === 'ArtTest' || EP_COMP) ? ['-ss', ((rangeA / FPS_OUT) * SPEED).toFixed(4), '-i', mix] : [];
if (!audioArgs.length) console.log('（注意：沒有可用的混音檔，這次輸出不含音軌）');
const q = isPreview;
const video = useGpu
  ? codec === 'hevc'
    ? ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', q ? '26' : '18', '-b:v', '0', '-maxrate', '60M', '-bufsize', '120M', '-profile:v', 'main', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-tag:v', 'hvc1']
    : ['-c:v', 'h264_nvenc', '-preset', q ? 'p5' : 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', q ? '25' : '17', '-b:v', '0', '-maxrate', '50M', '-bufsize', '100M', '-profile:v', 'high', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-bf', '3']
  : codec === 'hevc'
    ? ['-c:v', 'libx265', '-preset', 'slow', '-crf', q ? '26' : '18', '-tag:v', 'hvc1']
    : ['-c:v', 'libx264', '-preset', q ? 'veryfast' : 'slow', '-crf', q ? '23' : '16', '-profile:v', 'high'];
const te = Date.now();
const enc = await new Promise((res) => {
  const p = spawn('ffmpeg', [
    '-hide_banner', '-y', '-framerate', String(FPS_OUT), '-start_number', String(rangeA), '-i', join(frameDir, 'f%06d.jpeg'), ...audioArgs,
    '-frames:v', String(rangeB - rangeA + 1),
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    ...video, '-color_range', 'tv', '-r', String(FPS_OUT), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    ...(audioArgs.length ? [...(SPEED !== 1 ? ['-af', `atempo=${SPEED}`] : []), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-shortest'] : []),
    '-movflags', '+faststart', outFile,
  ], {cwd: ROOT});
  let out = '';
  p.stderr.on('data', (d) => (out = (out + d).slice(-6000)));
  p.on('close', (code) => res({code, out}));
});
const encodeMs = Date.now() - te;
await new Promise((r) => setTimeout(r, 2500));
clearInterval(sampler);
if (enc.code !== 0) {
  console.error(enc.out.slice(-2500));
  process.exit(1);
}

// ---- 5) 報告 ----
const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames:stream_tags=encoder:format=duration,size,bit_rate', '-of', 'json', outFile]);
const peakOf = (arr, k) => (arr.length ? Math.max(...arr.map((s) => s[k])) : 0);
const avg = (arr, k) => (arr.length ? arr.reduce((s, x) => s + x[k], 0) / arr.length : 0);
const rs = samples.filter((s) => s.phase === 'render');
const es = samples.filter((s) => s.phase === 'encode');
const frames = rangeB - rangeA + 1;
const report = {
  mode, useGpu, comp, codec, output: outFile, frames, chunks: chunkLog,
  seconds: {total: (Date.now() - t0) / 1000, render: renderMs / 1000, encode: encodeMs / 1000},
  render: {gpuAvg: avg(rs, 'gpu'), gpuPeak: peakOf(rs, 'gpu'), vramPeakMiB: peakOf(rs, 'vramMiB'), tempMaxC: peakOf(rs, 'tempC'), powerMaxW: peakOf(rs, 'powerW'), throttledSamples: rs.filter((s) => s.throttle).length, cpuAvg: avg(rs, 'cpu')},
  encode: {encoderAvg: avg(es, 'enc'), encoderPeak: peakOf(es, 'enc'), cpuAvg: avg(es, 'cpu')},
  ffprobe: JSON.parse(probe.out || '{}'),
  samples,
};
mkdirSync(join(ROOT, 'out', 'reports'), {recursive: true});
writeFileSync(join(ROOT, 'out', 'reports', `${tag}.json`), JSON.stringify(report, null, 2));
const r = report.render;
console.log(`\n完成：${outFile}（${(statSync(outFile).size / 1048576).toFixed(1)} MB）`);
console.log(`  幀數 ${frames}｜渲染 ${report.seconds.render.toFixed(0)}s｜編碼 ${report.seconds.encode.toFixed(0)}s｜總計 ${report.seconds.total.toFixed(0)}s`);
console.log(`  渲染期間 GPU 平均 ${r.gpuAvg.toFixed(0)}%、峰值 ${r.gpuPeak}%｜VRAM 峰值 ${r.vramPeakMiB} MiB｜最高 ${r.tempMaxC}°C｜最高 ${r.powerMaxW} W｜熱降頻取樣 ${r.throttledSamples}｜CPU 平均 ${r.cpuAvg.toFixed(0)}%`);
console.log(`  編碼期間 NVENC 平均 ${report.encode.encoderAvg.toFixed(0)}%、峰值 ${report.encode.encoderPeak}%`);
console.log(`  中間幀檔保留於 ${frameDir}（可續傳；確認成品後可手動刪除）`);
