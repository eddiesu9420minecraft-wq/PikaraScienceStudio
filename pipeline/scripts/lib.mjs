// 共用：Node/ffmpeg 路徑、短路徑瀏覽器（Windows MAX_PATH 260 字元限制的解法）
import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import os from 'node:os';

export const ROOT = resolve(import.meta.dirname, '..');
const SRC_BROWSER = join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64');
export const SHORT_BROWSER_DIR = join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'pikara-science', 'chrome-headless-shell');

/** 回傳可用的 chrome-headless-shell 路徑；專案路徑過長時複製到短路徑。 */
export const ensureBrowser = () => {
  if (process.platform !== 'win32') return null;
  const exe = join(SRC_BROWSER, 'chrome-headless-shell.exe');
  if (exe.length < 240 && existsSync(exe)) return exe;
  const target = join(SHORT_BROWSER_DIR, 'chrome-headless-shell.exe');
  const stamp = join(SHORT_BROWSER_DIR, '.source');
  if (!existsSync(SRC_BROWSER)) {
    // 讓 Remotion 先下載瀏覽器（下載本身不受 spawn 路徑限制）
    spawnSync(process.execPath, [join(ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), 'browser', 'ensure'], {cwd: ROOT, stdio: 'inherit'});
  }
  const srcVersion = existsSync(SRC_BROWSER) ? readFileSync(join(SRC_BROWSER, 'LICENSE.headless_shell')).length + ':' + SRC_BROWSER : '';
  if (!existsSync(target) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== srcVersion) {
    mkdirSync(SHORT_BROWSER_DIR, {recursive: true});
    cpSync(SRC_BROWSER, SHORT_BROWSER_DIR, {recursive: true});
    writeFileSync(stamp, srcVersion);
  }
  return target;
};

export const remotionBin = join(ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');

export const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts});
  return {code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), error: r.error};
};

export const remotion = (args, opts = {}) => {
  const browser = ensureBrowser();
  const extra = browser ? [`--browser-executable=${browser}`] : [];
  return run(process.execPath, [remotionBin, ...args, ...extra], opts);
};

export const remotionInherit = (args) => {
  const browser = ensureBrowser();
  const extra = browser ? [`--browser-executable=${browser}`] : [];
  const r = spawnSync(process.execPath, [remotionBin, ...args, ...extra], {cwd: ROOT, stdio: 'inherit'});
  return r.status ?? -1;
};

/** 系統 ffmpeg（需含 NVENC）；Remotion 內建 ffmpeg 不含 NVENC。 */
export const findFfmpeg = () => {
  const r = run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  return r.code === 0 ? r.out.split(/\r?\n/)[0].trim() : null;
};
