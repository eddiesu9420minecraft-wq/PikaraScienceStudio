// 影片編碼器能力偵測（跨 GPU 品牌）：
//   node scripts/hwenc.mjs [--codec h264|hevc] [--all] [--force] [--json]
//
// 規則：
//  - 不看 GPU 品牌字串決定能不能用。每個候選編碼器（scripts/hw_encoders.json）必須
//    1) 出現在 `ffmpeg -encoders`，而且 2) 用「正式渲染會用的同一組參數」實際編碼 1 秒 720p60 測試片，
//    輸出檔用 ffprobe 確認幀數與編碼格式正確，才算可用。
//  - 偵測到的顯示卡 PCI 廠商代碼（10DE/1002/8086）只用來決定「先測哪一個」：NVIDIA→NVENC、AMD→AMF、Intel→QSV，
//    macOS→VideoToolbox；所有平台最後都有 libx264／libx265 CPU 備援。
//  - 結果快取在 out/hwenc-cache.json（同一個 ffmpeg、同一組顯示卡與驅動 7 天內有效），避免每次渲染都重新初始化 GPU 編碼器。
//    正式編碼若失敗，render.mjs 會呼叫 markFailed() 讓快取失效並改用下一個候選。
//  - 任何錯誤（找不到驅動、初始化失敗、逾時）都只會讓該候選標示為不可用，不會丟出例外。
import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {ROOT} from './lib.mjs';

const TABLE = JSON.parse(readFileSync(join(ROOT, 'scripts', 'hw_encoders.json'), 'utf8'));
const CACHE = join(ROOT, 'out', 'hwenc-cache.json');
const TTL_MS = 7 * 24 * 3600 * 1000;
const PLATFORM = process.platform;

const sh = (cmd, args, timeout = 20000) => {
  try {
    const r = spawnSync(cmd, args, {encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1 << 24});
    return {code: r.error ? -1 : r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), error: r.error?.message};
  } catch (e) {
    return {code: -1, out: '', error: String(e)};
  }
};

/** 顯示卡清單（不分品牌）：[{name, vendorId, driver}]。失敗回傳 []。 */
let _adapters = null;
export const detectAdapters = () => {
  if (_adapters) return _adapters;
  let list = [];
  if (PLATFORM === 'win32') {
    const r = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion | ConvertTo-Json -Compress']);
    try {
      const j = JSON.parse(r.out.trim() || '[]');
      list = (Array.isArray(j) ? j : [j]).map((a) => ({name: a.Name ?? '', vendorId: (/VEN_([0-9A-F]{4})/i.exec(a.PNPDeviceID ?? '')?.[1] ?? '').toLowerCase(), driver: a.DriverVersion ?? ''}));
    } catch {}
  } else if (PLATFORM === 'linux') {
    const r = sh('sh', ['-c', 'for d in /sys/class/drm/card*/device; do echo "$(cat $d/vendor 2>/dev/null) $(cat $d/device 2>/dev/null)"; done']);
    list = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({name: l, vendorId: l.split(' ')[0].replace(/^0x/, '').toLowerCase(), driver: ''}));
  } else if (PLATFORM === 'darwin') {
    const r = sh('system_profiler', ['SPDisplaysDataType', '-json']);
    try {
      list = (JSON.parse(r.out).SPDisplaysDataType ?? []).map((a) => ({name: a.sppci_model ?? a._name ?? '', vendorId: /apple/i.test(a.spdisplays_vendor ?? '') ? 'apple' : (/0x([0-9a-f]{4})/i.exec(a.spdisplays_vendor ?? '')?.[1] ?? '').toLowerCase(), driver: ''}));
    } catch {}
  }
  _adapters = list.filter((a) => a.name && !/Microsoft Basic|Remote Display|Virtual/i.test(a.name));
  return _adapters;
};

/** 依平台與本機顯示卡排出要測試的順序（品牌只影響順序，不影響是否可用）。 */
export const candidates = (codec = 'h264', adapters = detectAdapters()) => {
  const fam = TABLE.families;
  const list = TABLE.encoders.filter((e) => e.codec === codec && fam[e.family].platforms.includes(PLATFORM));
  const vendors = adapters.map((a) => a.vendorId);
  const rank = (e) => {
    if (e.family === 'cpu') return 1000;
    if (e.family === 'mf') return 900; // Windows 通用硬體 MFT：品質控制較少，排在原生 SDK 後面
    if (e.family === 'videotoolbox') return 0;
    const hit = vendors.findIndex((v) => fam[e.family].vendorIds.includes(v));
    // 獨立顯卡（NVIDIA）通常排在清單後面，但編碼器較完整，所以優先 NVIDIA → AMD → Intel
    const pref = {nvenc: 0, amf: 1, qsv: 2, vaapi: 3}[e.family] ?? 5;
    return hit >= 0 ? 10 + pref : 100 + pref;
  };
  return list.sort((a, b) => rank(a) - rank(b));
};

export const ffmpegInfo = () => {
  const w = sh(PLATFORM === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const path = w.code === 0 ? w.out.split(/\r?\n/)[0].trim() : null;
  if (!path) return null;
  let sig = path;
  try {
    const s = statSync(path);
    sig += `|${s.size}|${s.mtimeMs}`;
  } catch {}
  return {path, sig};
};

const listedEncoders = (ff) => {
  const r = sh(ff, ['-hide_banner', '-encoders']);
  return new Set([...r.out.matchAll(/^\s*V\S*\s+(\S+)/gm)].map((m) => m[1]));
};

/** 組出某個編碼器的 ffmpeg 參數。filter：在既有 -vf 後面要接的像素格式（與 VA-API 的 hwupload）。 */
export const encoderArgs = (id, {preview = false} = {}) => {
  const e = TABLE.encoders.find((x) => x.id === id);
  if (!e) throw new Error(`未知的編碼器 ${id}`);
  return {
    id, family: e.family, label: TABLE.families[e.family].label, hardware: e.family !== 'cpu',
    pre: e.pre ?? [],
    filter: `format=${e.pixFmt}${e.hwupload ? ',hwupload' : ''}`,
    args: ['-c:v', e.id, ...(preview ? e.preview : e.final)],
  };
};

/** 實際試編碼 1 秒 720p60，並用 ffprobe 驗證輸出。 */
export const testEncoder = (ff, id, {timeoutMs = 45000} = {}) => {
  const a = encoderArgs(id);
  const dir = join(ROOT, 'out', 'hwenc-test');
  mkdirSync(dir, {recursive: true});
  const out = join(dir, `${id}.mp4`);
  rmSync(out, {force: true});
  const t0 = Date.now();
  const r = sh(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...a.pre, '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60', '-t', '1',
    '-vf', a.filter, ...a.args, '-an', out], timeoutMs);
  const ms = Date.now() - t0;
  let error = r.code === 0 ? null : (r.error ? `執行失敗：${r.error}` : r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ') || `ffmpeg 結束代碼 ${r.code}`);
  if (!error) {
    const p = sh('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', out]);
    try {
      const s = JSON.parse(p.out).streams?.[0] ?? {};
      const want = id.startsWith('hevc') || id === 'libx265' ? 'hevc' : 'h264';
      if (s.codec_name !== want || Number(s.nb_read_frames) !== 60) error = `輸出檢查失敗：codec=${s.codec_name}，幀數=${s.nb_read_frames}（應為 ${want}／60）`;
    } catch {
      error = '輸出檢查失敗：ffprobe 無法讀取試編碼檔';
    }
  }
  rmSync(out, {force: true});
  return {works: !error, ms, error};
};

const readCache = () => {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  } catch {
    return null;
  }
};
const writeCache = (c) => {
  mkdirSync(join(ROOT, 'out'), {recursive: true});
  writeFileSync(CACHE, JSON.stringify(c, null, 2));
};
const envSig = (ff, adapters) => JSON.stringify([PLATFORM, ff.sig, adapters.map((a) => `${a.vendorId}:${a.name}:${a.driver}`)]);

/**
 * 找出可用的編碼器。all=false 時找到第一個可用的硬體編碼器就停（渲染用）；all=true 全部實測（環境檢查用）。
 * 回傳 {ffmpeg, adapters, codec, selected, results[], fromCache}；selected 一定有值（至少是 CPU）——除非連 ffmpeg 都沒有。
 */
export const probe = ({codec = 'h264', all = false, force = false, log = () => {}} = {}) => {
  const ff = ffmpegInfo();
  const adapters = detectAdapters();
  if (!ff) return {ffmpeg: null, adapters, codec, selected: null, results: [], fromCache: false, error: '找不到 ffmpeg'};
  const sig = envSig(ff, adapters);
  const cache = readCache();
  const fresh = !force && cache && cache.sig === sig && Date.now() - cache.time < TTL_MS ? cache : {sig, time: Date.now(), results: {}};
  const listed = listedEncoders(ff.path);
  const results = [];
  let selected = null;
  let usedCache = true;
  for (const e of candidates(codec, adapters)) {
    let r = fresh.results[e.id];
    if (!listed.has(e.id)) r = {works: false, listed: false, ms: 0, error: '這個 ffmpeg 沒有編譯此編碼器'};
    else if (!r) {
      if (selected && !all) {
        results.push({id: e.id, family: e.family, listed: true, works: null, ms: 0, error: '未測試（已找到可用的編碼器）'});
        continue;
      }
      log(`  試編碼 ${e.id}…`);
      r = {...testEncoder(ff.path, e.id), listed: true, tested: new Date().toISOString()};
      usedCache = false;
    }
    fresh.results[e.id] = r;
    results.push({id: e.id, family: e.family, label: TABLE.families[e.family].label, ...r});
    if (r.works && !selected) selected = e.id;
  }
  writeCache(fresh);
  return {ffmpeg: ff.path, adapters, codec, selected, results, fromCache: usedCache};
};

/**
 * 正式編碼失敗時呼叫：刪掉這個編碼器的快取結果，下次渲染會重新實測（失敗可能是暫時的，例如另一個程式占用編碼器，
 * 所以不把它記成 7 天內不可用）。這次渲染則直接改用鏈裡的下一個。
 */
export const markFailed = (id, error) => {
  const c = readCache();
  if (!c?.results?.[id]) return;
  delete c.results[id];
  c.lastFailure = {id, error: String(error).slice(0, 300), time: new Date().toISOString()};
  writeCache(c);
};

/**
 * 編碼時依序嘗試的鏈：實測可用的 → 已編譯但還沒測（找到首選後就不再試編碼的那些；正式編碼本身就是測試，
 * 輸出幀數會驗證）→ 最後一定是 CPU。實測失敗的不會出現在鏈裡。
 */
export const usableChain = (p) => {
  const cpu = p.codec === 'hevc' ? 'libx265' : 'libx264';
  const hw = (r) => r.id !== cpu && r.family !== 'cpu';
  const ok = p.results.filter((r) => r.works === true && hw(r)).map((r) => r.id);
  const untested = p.results.filter((r) => r.works === null && r.listed && hw(r)).map((r) => r.id);
  return [...ok, ...untested, cpu];
};

// ---- CLI ----
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('hwenc.mjs')) {
  const argv = process.argv.slice(2);
  const codec = argv.includes('--codec') ? argv[argv.indexOf('--codec') + 1] : 'h264';
  const p = probe({codec, all: argv.includes('--all'), force: argv.includes('--force'), log: (m) => !argv.includes('--json') && console.log(m)});
  if (argv.includes('--json')) console.log(JSON.stringify(p, null, 2));
  else {
    console.log(`\n=== 影片編碼器（${codec}）===`);
    console.log(`ffmpeg   ${p.ffmpeg ?? '找不到'}`);
    console.log(`顯示卡   ${p.adapters.map((a) => `${a.name}（${a.vendorId || '?'}，驅動 ${a.driver || '?'}）`).join('；') || '未偵測到'}`);
    for (const r of p.results) console.log(`${r.id.padEnd(18)} ${r.works === true ? `可用（試編碼 ${r.ms} ms）` : r.works === null ? '未測試' : `不可用：${r.error}`}`);
    console.log(`\n選用：${p.selected ?? '無'}${p.fromCache ? '（來自快取，加 --force 重新實測）' : ''}`);
  }
  process.exit(p.selected ? 0 : 1);
}
