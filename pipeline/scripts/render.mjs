// 渲染管線（分段、可中斷續傳、動態並行）：
//   node scripts/render.mjs <gpu|cpu|preview> [--comp EP01|EP02-30fps|EP02-YT15…] [--seq ep02] [--codec h264|hevc] [--concurrency N] [--frames a-b]
//                           [--chunk 1800] [--out file] [--allow-cpu-fallback] [--skip-check] [--fresh] [--encoder auto|h264_nvenc|h264_amf|…|libx264]
//  gpu     1920×1080 60fps：Chromium WebGL 走硬體 GPU（ANGLE：Windows D3D11／macOS Metal／Linux EGL，任何品牌），
//          影片編碼用實測可用的硬體編碼器（NVENC／AMF／QSV／VideoToolbox／VA-API／Media Foundation），都不行就用 libx264
//  cpu     相容模式：SwiftShader 軟體 WebGL + libx264（--encoder auto 可改用硬體編碼）
//  畫面渲染（WebGL）與影片編碼是兩種不同的能力，分開偵測、分開降級。
//  preview 1280×720 快速預覽
//
// 設計：
//  - 只 bundle 一次；整片切成多個區段（預設 1800 幀＝30 秒），每段完成後把幀檔改名為固定 6 位數編號，
//    存到 out/frames/<tag>/。中斷後重新執行同一指令，會跳過已完成的區段（--fresh 才會清空重來）。
//  - 有 nvidia-smi（NVIDIA）時，每段開始前讀 VRAM、溫度、熱降頻旗標，依上一段實測的「每個分頁 VRAM」動態決定並行數；
//    其他品牌沒有可靠的 VRAM 遙測，並行數維持起始值（--concurrency 可指定）：
//    VRAM 目標上限 5300 MiB；出現熱降頻或溫度 ≥ 87°C 就降一級；穩定且有餘裕時升一級（上限 8，受 CPU 執行緒限制）。
//  - 全程每 2 秒記錄 GPU 使用率、VRAM、溫度、功耗、SM 時脈、NVENC 使用率與 CPU 使用率到報告。
//  - 不修改任何 GPU 功耗、時脈或散熱設定，保留原廠保護機制。
import {spawn, execFile} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {chromiumFlagsArg, ensureBrowser, remotionBin, ROOT, run, findFfmpeg} from './lib.mjs';
import {encoderArgs, markFailed, probe as probeEncoders, usableChain} from './hwenc.mjs';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'gpu';
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);
const PLAN = flag('plan'); // 只試算哪些幀可沿用、要渲染多少（不 bundle、不渲染、不編碼），輸出一行 PLAN_JSON
const comp = opt('comp', 'EP01');
const SRC = opt('src', 'src'); // 例：--src src_cn（大陸簡體版）
const MIXNAME = opt('mix', null); // 例：--mix ep01_cn
// 集數由 composition 名稱推得：EP02 / EP02-30fps / EP02-YT15 / EP02-Act03 → ep02（--seq 可覆寫）
const EP_COMP = /^(EP\d{2,3}|TEST\d{3})(?:-(30fps|YT15|Act\d+))?$/i.exec(comp);
const VARIANT = EP_COMP ? (EP_COMP[2] ?? '').toLowerCase() : null; // '' | '30fps' | 'yt15' | 'actNN'
const SPEED = VARIANT === 'yt15' ? 1.5 : 1; // 1.5 倍速版：音訊 atempo=1.5（音調不變）
const codec = opt('codec', 'h264');
const ENCODER = opt('encoder', mode === 'cpu' ? (codec === 'hevc' ? 'libx265' : 'libx264') : process.env.PIKARA_ENCODER || 'auto'); // Studio DeviceSelector: PIKARA_ENCODER
const isPreview = mode === 'preview';
// 畫面品質（v0.3）：high＝影格 JPEG 98＋正式編碼參數；standard（預設）＝JPEG 95＋正式編碼參數；draft＝JPEG 88＋預覽編碼參數（較小、較快）
const QUALITY = ['high', 'standard', 'draft'].includes(opt('quality', 'standard')) ? opt('quality', 'standard') : 'standard';
const JPEG_Q = isPreview ? 88 : QUALITY === 'high' ? 98 : QUALITY === 'draft' ? 88 : 95;
// ---- 效能模式（預設 balanced）：只決定「起始值與上限」，實際並行數每段依實測 VRAM／GPU／CPU／RAM／fps 調整 ----
//  eco         起始 1、上限 2；CPU ≤ 70%、溫度 ≤ 80°C、RAM 至少留 4 GB
//  balanced    起始 3、上限＝邏輯核心的一半；CPU ≤ 85%、溫度 ≤ 85°C、RAM 至少留 3 GB、VRAM ≤ 85% 總量
//              （2026-11-28 實測 RTX 4050 筆電＋12 執行緒、EP16 同樣 3600 幀：並行 3＝25.2 fps、4＝30.5、6＝33.0，
//               CPU 平均 19%／22%／32%；舊版上限 4、且只比一段就鎖定，實際常停在 3）
//  performance 起始 3、上限 8；CPU ≤ 95%、溫度 ≤ 87°C、RAM 至少留 2 GB、VRAM ≤ 90% 總量
// 這些是保守的起點，不是實測最佳值；每段結束都會記錄調整原因到報告（concurrencyLog）。
const PERF = opt('perf', process.env.PIKARA_PERF || 'balanced');
const PRESETS = {
  eco: {start: 1, max: 2, cpuMax: 70, tempMax: 80, ramMinMiB: 4096, vramFrac: 0.8},
  balanced: {start: 3, max: 64, cpuMax: 85, tempMax: 85, ramMinMiB: 3072, vramFrac: 0.85},
  performance: {start: 3, max: 8, cpuMax: 95, tempMax: 87, ramMinMiB: 2048, vramFrac: 0.9},
};
const P = PRESETS[PERF] ?? PRESETS.balanced;
// 900 幀的段比 1800 幀慢約 5%（每段都要重新啟動分頁）；eco 保留較小的段以便較快降載
const CHUNK = Number(opt('chunk', PERF === 'eco' ? 900 : 1800));
const VRAM_CAP_OPT = opt('vram-cap', process.env.PIKARA_VRAM_CAP || null); // Studio: GPU 資源使用上限
let VRAM_CAP = Number(VRAM_CAP_OPT ?? 5300);
// 自動調整的上限：模式上限與邏輯核心的一半取小。--concurrency 明確指定時只受「邏輯核心數」這個安全上限限制
// （舊版會被模式上限悄悄改成 4，報告卻寫「固定」）
const HARD_MAX = Math.max(1, os.cpus().length);
const MAX_CONC = Math.min(P.max, Math.max(1, Math.floor(os.cpus().length / 2)));

const smi = () => {
  const r = run('nvidia-smi', ['--query-gpu=memory.used,memory.total,temperature.gpu,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown', '--format=csv,noheader,nounits']);
  if (r.code !== 0) return null;
  const [used, total, temp, hw, sw] = r.out.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  return {used: +used, total: +total, temp: +temp, throttle: hw === 'Active' || sw === 'Active'};
};

// ---- GPU 可用性：實測，不是假設 ----
let useGpu = mode !== 'cpu' && process.env.PIKARA_RENDER_TARGET !== 'cpu'; // Studio may assign CPU rendering (no usable GPU)
if (useGpu && !flag('skip-check') && !PLAN) {
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
// ---- 影片編碼器：實測可用的鏈（首選 → … → CPU），與 WebGL 無關 ----
let encChain;
if (PLAN) {
  encChain = [];
} else if (ENCODER === 'auto') {
  const p = probeEncoders({codec, log: (m) => console.log(m)});
  encChain = usableChain(p);
  const bad = p.results.filter((r) => r.works === false && r.listed).map((r) => r.id);
  console.log(`影片編碼器：${encChain.join(' → ')}${p.fromCache ? '（實測結果快取）' : ''}${bad.length ? `；不可用：${bad.join('、')}` : ''}`);
} else {
  encChain = [...new Set([ENCODER, codec === 'hevc' ? 'libx265' : 'libx264'])];
  console.log(`影片編碼器（指定）：${encChain.join(' → ')}`);
}

// 取得總幀數（--timeline 可改用試算的時間軸，供 --plan 使用）
const tlPath = opt('timeline', null) ? resolve(ROOT, opt('timeline')) : join(ROOT, SRC, 'data', 'timeline.generated.json');
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
const [rangeA, rangeB] = opt('frames', null)?.split('-').map(Number) ?? [0, (totalFrames ?? Number(opt('total', 0))) - 1];
if (!(rangeB >= rangeA)) {
  console.error('無法得知總幀數，請用 --frames a-b 指定。');
  process.exit(1);
}

const tag = `${SRC === 'src' ? '' : SRC + '-'}${comp}-${isPreview ? '720p' : '1080p'}-${useGpu ? 'gpu' : 'cpu'}${QUALITY === 'standard' || isPreview ? '' : '-' + QUALITY}`;
const frameDir = join(ROOT, 'out', 'frames', tag);
if (flag('fresh') && !PLAN) rmSync(frameDir, {recursive: true, force: true});
const codeFiles = (() => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true}).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|json|css)$/.test(e.name) && !/^(timeline\.generated|narration)\.json$/.test(e.name)) files.push(p);
    }
  };
  walk(join(ROOT, SRC));
  return files;
})();
const narP = join(ROOT, SRC, 'data', 'narration.json');
const narTitle = existsSync(narP) ? JSON.parse(readFileSync(narP, 'utf8')).sequences?.[seqId]?.title ?? null : null;
// 續傳安全：幀檔只在「同一份原始碼＋同一條時間軸」時整批沿用
const fingerprint = (() => {
  const h = createHash('sha256');
  for (const p of codeFiles) h.update(p.slice(ROOT.length)).update(readFileSync(p));
  const seqTl = seqId && tlAll[seqId] ? {...tlAll[seqId], mix: undefined, voiceTempo: undefined, warnings: undefined} : null; // 混音路徑不影響畫面
  h.update(JSON.stringify(seqTl)).update(JSON.stringify(narTitle)).update(comp).update(isPreview ? 'p' : 'f');
  return h.digest('hex').slice(0, 16);
})();
const fpFile = join(frameDir, 'fingerprint.txt');
// ---- 場景級增量渲染 v3（v0.3）----
// 每個場景的指紋只包含「這個場景看得到的東西」，而且全部換算成場景內的相對時間：
//   共用程式碼＋該場景的幕元件＋場景長度、相對錨點、相對的句子與字幕（含前後 2 秒內跨界的字幕）。
// 所以某一句重新配音、後面的場景整段往後移時，這些場景的指紋不變——它們已渲染的幀直接搬到新位置沿用，
// 只渲染真的改變的場景，以及移動過的場景前後各 0.5 秒的邊界幀（保險）。
// 條件：位移必須剛好是整數個輸出幀（build_timeline.py 對齊 0.1 秒格點保證這點），否則該場景重新渲染。
const RATIO = FPS_OUT === 60 ? 1 : VARIANT === 'yt15' ? 1 / 3 : 1 / 2;
const sceneFp = (() => {
  const seqTl = seqId && tlAll[seqId];
  if (!seqTl || !Array.isArray(seqTl.scenes) || !seqTl.scenes.length || !EP_COMP || !['', '30fps', 'yt15'].includes(VARIANT)) return null;
  const actDir = join(ROOT, SRC, 'acts', seqId);
  const sceneOf = (p) => {
    if (!p.startsWith(actDir)) return null;
    const base = p.slice(actDir.length + 1).split(/[\\/]/)[0].replace(/\.(tsx?)$/, '').toLowerCase();
    return seqTl.scenes.find((s) => s.id.toLowerCase() === base)?.id ?? null;
  };
  const common = createHash('sha256');
  const per = Object.fromEntries(seqTl.scenes.map((s) => [s.id, createHash('sha256')]));
  for (const p of codeFiles) {
    const sid = sceneOf(p);
    (sid ? per[sid] : common).update(p.slice(ROOT.length)).update(readFileSync(p));
  }
  common.update(JSON.stringify({id: seqTl.id, fps: seqTl.fps, voiceEngine: seqTl.voiceEngine, n: seqTl.scenes.length, ids: seqTl.scenes.map((s) => s.id)}))
    .update(JSON.stringify(narTitle)).update(comp).update(isPreview ? 'p' : 'f');
  const out = {v: 3, common: common.digest('hex').slice(0, 16), total: seqTl.totalFrames, ratio: RATIO, scenes: {}};
  seqTl.scenes.forEach((s, i) => {
    const S = s.startFrame;
    const local = {
      index: i, title: s.title, dur: s.durationFrames,
      anchors: Object.fromEntries(Object.entries(s.anchors ?? {}).map(([k, v]) => [k, [v.frame - S, v.word ?? null]])),
      lines: (seqTl.lines ?? []).filter((l) => l.scene === s.id).map((l) => [l.id, l.subtitle, l.startFrame - S, l.durationFrames]),
      cues: (seqTl.cues ?? []).filter((c) => c.to >= S - 120 && c.from < s.endFrame + 120).map((c) => [c.text, c.from - S, c.to - S]),
    };
    per[s.id].update(JSON.stringify(local));
    out.scenes[s.id] = {hash: per[s.id].digest('hex').slice(0, 16), start: S, a: Math.ceil(S * RATIO), z: Math.ceil(s.endFrame * RATIO) - 1};
  });
  return out;
})();
const sceneFile = join(frameDir, 'fingerprint.scenes.json');
const fname = (f) => join(frameDir, `f${String(f).padStart(6, '0')}.jpeg`);
const jpegs = () => (existsSync(frameDir) ? readdirSync(frameDir).filter((f) => /^f\d{6}\.jpeg$/.test(f)) : []);
const reuse = {mode: 'fresh', reusedFrames: 0, renderFrames: 0, scenes: []};
{
  const have = jpegs();
  const old = existsSync(fpFile) ? readFileSync(fpFile, 'utf8').trim() : null;
  const oldScenes = existsSync(sceneFile) ? JSON.parse(readFileSync(sceneFile, 'utf8')) : null;
  if (!have.length) reuse.mode = 'fresh';
  else if (old === fingerprint) {
    reuse.mode = 'identical'; // 同一份原始碼＋時間軸：已完成的幀全部沿用（中斷續傳、只改混音或編碼設定）
  } else if (sceneFp && oldScenes && oldScenes.v === 3 && oldScenes.common === sceneFp.common && oldScenes.ratio === RATIO) {
    const M = Math.round(FPS_OUT / 2);
    const moves = [];
    for (const [id, s] of Object.entries(sceneFp.scenes)) {
      const o = oldScenes.scenes[id];
      const d = o ? (s.start - o.start) * RATIO : NaN;
      const ok = !!o && o.hash === s.hash && s.z - s.a === o.z - o.a && Number.isInteger(d) && s.a - o.a === d;
      const margin = ok && d !== 0 ? M : 0;
      const n = ok ? Math.max(0, o.z - o.a + 1 - 2 * margin) : 0;
      reuse.scenes.push({id, reuse: ok, shiftFrames: ok ? d : null, frames: s.z - s.a + 1, reusedFrames: n, reason: !o ? '新場景' : o.hash !== s.hash ? '內容或旁白改變' : !ok ? '位移不是整數幀' : d ? `整段平移 ${d} 幀` : '未改變'});
      if (ok) for (let f = o.a + margin; f <= o.z - margin; f++) moves.push([f, f + d]);
    }
    reuse.mode = 'scenes';
    if (!PLAN) {
      const stage = join(frameDir, '_reuse');
      rmSync(stage, {recursive: true, force: true});
      mkdirSync(stage, {recursive: true});
      let moved = 0;
      for (const [a, b] of moves) {
        if (existsSync(fname(a))) { renameSync(fname(a), join(stage, `f${String(b).padStart(6, '0')}.jpeg`)); moved++; }
      }
      for (const f of jpegs()) rmSync(join(frameDir, f), {force: true});
      for (const f of readdirSync(stage)) renameSync(join(stage, f), join(frameDir, f));
      rmSync(stage, {recursive: true, force: true});
      const ch = reuse.scenes.filter((s) => !s.reuse).map((s) => s.id);
      console.log(`  場景級增量渲染：沿用 ${moved} 幀；重新渲染 ${ch.length}/${reuse.scenes.length} 個場景（${ch.join('、') || '無'}）與平移場景的邊界幀`);
    }
  } else {
    reuse.mode = 'full';
    if (!PLAN) {
      console.log(`  原始碼或時間軸已變更（${old} → ${fingerprint}），清除舊幀後重新渲染`);
      rmSync(frameDir, {recursive: true, force: true});
    }
  }
}
if (PLAN) {
  // 試算：不 bundle、不渲染、不編碼、不改任何檔案
  let cached = 0;
  if (reuse.mode === 'identical') cached = jpegs().filter((f) => { const n = +f.slice(1, 7); return n >= rangeA && n <= rangeB; }).length;
  else if (reuse.mode === 'scenes') cached = reuse.scenes.reduce((s, x) => s + x.reusedFrames, 0);
  const total = rangeB - rangeA + 1;
  const plan = {comp, src: SRC, tag, frameDir, fps: FPS_OUT, totalFrames: total, cachedFrames: Math.min(cached, total), renderFrames: Math.max(0, total - cached), mode: reuse.mode, scenes: reuse.scenes, fingerprint};
  console.log('PLAN_JSON ' + JSON.stringify(plan));
  process.exit(0);
}
mkdirSync(frameDir, {recursive: true});
writeFileSync(fpFile, fingerprint);
if (sceneFp) writeFileSync(sceneFile, JSON.stringify(sceneFp));
reuse.reusedFrames = jpegs().length;
// ---- 1) bundle（只做一次；計畫模式不需要）----
const t0 = Date.now();
const BUILD = SRC === 'src' ? 'build' : `build-${SRC}`;
const b = run(process.execPath, [remotionBin, 'bundle', `${SRC}/index.ts`, `--out-dir=${BUILD}`]);
if (b.code !== 0) {
  console.error(b.out);
  process.exit(1);
}
const outFile = opt('out', join(ROOT, 'out', isPreview ? `${comp}-preview-720p.mp4` : `${comp}-${useGpu ? 'gpu' : 'cpu'}-1080p60.mp4`));
mkdirSync(dirname(resolve(ROOT, outFile)), {recursive: true});

// ---- 2) 監控取樣（每 2 秒）----
const samples = [];
const hasTelemetry = run('nvidia-smi', ['-L']).code === 0;
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
    samples.push({t: Date.now(), phase: ph, cpu: +cpu.toFixed(1), ramFreeMiB: Math.round(os.freemem() / 1048576), gpu: +p[0], vramMiB: +p[1], enc: +p[2], powerW: +p[3], tempC: +p[4], smMHz: +p[5], throttle: p[6] === 'Active' || p[7] === 'Active'});
  });
  if (!hasTelemetry) samples.push({t: Date.now(), phase: ph, cpu: +cpu.toFixed(1), ramFreeMiB: Math.round(os.freemem() / 1048576), gpu: null, vramMiB: null, enc: null, tempC: null, throttle: false, noGpu: true});
}, 2000);

// ---- 3) 分段渲染 ----
const browser = ensureBrowser();
const base = smi(); // 非 NVIDIA 時為 null：沒有 VRAM 遙測，只用 CPU／RAM／fps 調整
const baselineVram = base?.used ?? 2000;
if (base?.total && !VRAM_CAP_OPT) VRAM_CAP = Math.round(base.total * P.vramFrac);
const envStart = Number(process.env.PIKARA_RENDER_START_CONC || 0);
const fixedConc = !!opt('concurrency', null);
let concurrency = fixedConc
  ? Math.min(HARD_MAX, Math.max(1, Number(opt('concurrency', 1)) || 1))
  : Math.min(MAX_CONC, Number(opt('start-concurrency', 0)) || envStart || P.start);
let perTab = 350; // MiB，第一段後以實測更新
const concLog = [];
let bestFps = null; // {conc, fps}：升級後若吞吐量沒有變好就退回並鎖定
let lockedMax = MAX_CONC;
const noGain = {}; // 並行數 → 沒有變快的次數：段與段的內容不同，單一段的 fps 有 ±5% 的雜訊，兩次都沒變快才鎖定
console.log(`效能模式 ${PERF}：起始並行 ${concurrency}、上限 ${MAX_CONC}${fixedConc ? '（--concurrency 固定）' : ''}；VRAM 上限 ${VRAM_CAP} MiB${base ? '' : '（無 VRAM 遙測）'}、CPU ≤ ${P.cpuMax}%、RAM 至少留 ${P.ramMinMiB} MiB`);
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
    '--sequence', '--image-format=jpeg', `--jpeg-quality=${JPEG_Q}`,
    ...(useGpu ? chromiumFlagsArg() : []),
    `--gl=${useGpu ? (process.platform === 'linux' ? 'angle-egl' : 'angle') : 'swangle'}`, `--concurrency=${concurrency}`,
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
  const gs = cs_.filter((s) => !s.noGpu);
  const gpuAvg = gs.length ? gs.reduce((s, x) => s + x.gpu, 0) / gs.length : 0;
  const cpuAvg = cs_.length ? cs_.reduce((s, x) => s + x.cpu, 0) / cs_.length : 0;
  const ramMin = cs_.length ? Math.min(...cs_.map((s) => s.ramFreeMiB ?? Infinity)) : Math.round(os.freemem() / 1048576);
  chunkLog.push({a, z, concurrency, secs, fps: need / secs, peakVram: peak, maxTemp: hot, throttled, gpuAvg});
  const fps = need / secs;
  console.log(`  區段 ${a}–${z}：${secs.toFixed(0)}s，${fps.toFixed(1)} fps，並行 ${concurrency}${gs.length ? `，GPU 平均 ${gpuAvg.toFixed(0)}%，VRAM 峰值 ${peak} MiB，最高 ${hot}°C${throttled ? '，⚠ 熱降頻' : ''}` : ''}，CPU 平均 ${cpuAvg.toFixed(0)}%，RAM 最少剩 ${ramMin} MiB`);
  // 動態調整並行數：先看是否超出限制（降），再看是否還有餘裕且上次升級確實提高吞吐量（升）
  if (!fixedConc && need >= 60) {
    const why = [];
    let next = concurrency;
    if (gs.length) perTab = Math.max(150, (peak - baselineVram) / concurrency);
    if (throttled) why.push('熱降頻');
    if (gs.length && hot > P.tempMax) why.push(`溫度 ${hot}°C > ${P.tempMax}`);
    if (gs.length && peak > VRAM_CAP) why.push(`VRAM 峰值 ${peak} > ${VRAM_CAP} MiB`);
    if (cpuAvg > P.cpuMax) why.push(`CPU ${cpuAvg.toFixed(0)}% > ${P.cpuMax}%`);
    if (ramMin < P.ramMinMiB) why.push(`RAM 剩 ${ramMin} < ${P.ramMinMiB} MiB`);
    if (why.length) next = concurrency - 1;
    else {
      // 吞吐量檢查：比上一個並行數慢（< 5% 改善）就退回並不再往上試
      if (bestFps && concurrency > bestFps.conc && fps < bestFps.fps * 1.03) {
        noGain[concurrency] = (noGain[concurrency] || 0) + 1;
        why.push(`並行 ${concurrency} 的 ${fps.toFixed(1)} fps 沒有比並行 ${bestFps.conc} 的 ${bestFps.fps.toFixed(1)} fps 快 3% 以上（第 ${noGain[concurrency]} 次）`);
        if (noGain[concurrency] >= 2) lockedMax = bestFps.conc;
        next = bestFps.conc;
      } else {
        const vramRoom = !gs.length || peak + perTab <= VRAM_CAP;
        const cpuRoom = cpuAvg < P.cpuMax - 15;
        const ramRoom = ramMin > P.ramMinMiB + 2048;
        if (vramRoom && cpuRoom && ramRoom && concurrency < Math.min(MAX_CONC, lockedMax)) {
          next = concurrency + 1;
          why.push(`有餘裕（${gs.length ? `VRAM 預估 ${Math.round(peak + perTab)}/${VRAM_CAP} MiB、` : ''}CPU ${cpuAvg.toFixed(0)}%、RAM 剩 ${ramMin} MiB）`);
        } else why.push(!vramRoom ? 'VRAM 沒有餘裕' : !cpuRoom ? `CPU ${cpuAvg.toFixed(0)}% 接近上限` : !ramRoom ? 'RAM 餘裕不足' : '已達上限');
      }
      if (!bestFps || fps > bestFps.fps) bestFps = {conc: concurrency, fps};
    }
    next = Math.max(1, Math.min(MAX_CONC, next));
    concLog.push({segment: `${a}-${z}`, conc: concurrency, fps: +fps.toFixed(2), cpuAvg: +cpuAvg.toFixed(1), ramMinMiB: ramMin, vramPeakMiB: gs.length ? peak : null, gpuAvg: gs.length ? +gpuAvg.toFixed(1) : null, maxTempC: gs.length ? hot : null, next, reason: why.join('；')});
    if (next !== concurrency) console.log(`  並行 ${concurrency} → ${next}：${why.join('；')}`);
    concurrency = next;
  }
}
const renderMs = Date.now() - tr;

// ---- 4) 編碼（實測可用的硬體編碼器，失敗自動改用下一個，最後是 CPU）並混入後製音軌 ----
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
const te = Date.now();
const encodeWith = (id) => {
  const e = encoderArgs(id, {preview: isPreview || QUALITY === 'draft'});
  // 測試用：PIKARA_FAIL_ENCODER=h264_nvenc 讓該編碼器在 ffmpeg 內真的失敗（未知參數），用來驗證自動降級
  const simulated = (process.env.PIKARA_FAIL_ENCODER ?? '').split(',').includes(id);
  if (simulated) e.args = [...e.args, '-pikara_simulated_failure', '1'];
  return new Promise((res) => {
    let p;
    try {
      p = spawn('ffmpeg', [
        '-hide_banner', '-y', ...e.pre, '-framerate', String(FPS_OUT), '-start_number', String(rangeA), '-i', join(frameDir, 'f%06d.jpeg'), ...audioArgs,
        '-frames:v', String(rangeB - rangeA + 1),
        '-vf', `scale=in_range=pc:out_range=tv:out_color_matrix=bt709,${e.filter}`,
        ...e.args, '-color_range', 'tv', '-r', String(FPS_OUT), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        ...(audioArgs.length ? [...(SPEED !== 1 ? ['-af', `atempo=${SPEED}`] : []), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-shortest'] : []),
        '-movflags', '+faststart', outFile,
      ], {cwd: ROOT});
    } catch (err) {
      return res({code: -1, out: String(err)});
    }
    let out = '';
    p.stderr.on('data', (d) => (out = (out + d).slice(-6000)));
    p.on('error', (err) => res({code: -1, out: out + String(err)}));
    p.on('close', (code) => res({code, out}));
  });
};
// 編碼後驗證：幀數必須等於要求的幀數（硬體編碼器偶爾「成功結束」但掉幀）
const verifyOut = () => {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', outFile]);
  const n = parseInt(r.out.trim(), 10);
  return n === rangeB - rangeA + 1 ? null : `輸出只有 ${Number.isNaN(n) ? 0 : n} 幀（應為 ${rangeB - rangeA + 1}）`;
};
let enc = {code: -1, out: ''};
const encAttempts = [];
let usedEncoder = null;
for (const id of encChain) {
  const t1 = Date.now();
  console.log(`編碼中：${id}`);
  enc = await encodeWith(id);
  const err = enc.code === 0 ? verifyOut() : enc.out.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ');
  encAttempts.push({encoder: id, ok: !err, seconds: (Date.now() - t1) / 1000, error: err || undefined});
  if (!err) {
    usedEncoder = id;
    break;
  }
  console.error(`  ✗ ${id} 編碼失敗：${err}`);
  if (ENCODER === 'auto' && !(process.env.PIKARA_FAIL_ENCODER ?? '').split(',').includes(id)) markFailed(id, err);
  console.error('  → 改用下一個編碼器（已渲染的幀都保留，不會重新渲染）');
}
const encodeMs = Date.now() - te;
await new Promise((r) => setTimeout(r, 2500));
clearInterval(sampler);
if (!usedEncoder) {
  console.error(enc.out.slice(-2500));
  console.error('所有編碼器都失敗（含 CPU）。');
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
  mode, useGpu, comp, codec, perf: PERF, reuse: {...reuse, renderFrames: Math.max(0, rangeB - rangeA + 1 - reuse.reusedFrames)}, concurrencyLog: concLog, encoder: usedEncoder, encoderChain: encChain, encodeAttempts: encAttempts, output: outFile, frames, chunks: chunkLog,
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
console.log(`  編碼器 ${usedEncoder}${encAttempts.length > 1 ? `（先前失敗：${encAttempts.filter((x) => !x.ok).map((x) => x.encoder).join('、')}）` : ''}${es.length ? `｜NVENC 使用率 平均 ${report.encode.encoderAvg.toFixed(0)}%、峰值 ${report.encode.encoderPeak}%` : ''}`);
console.log(`  沿用幀 ${reuse.reusedFrames}／${frames}（${reuse.mode}）`);
console.log(`  中間幀檔保留於 ${frameDir}（可續傳；確認成品後可手動刪除）`);
