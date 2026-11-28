// Release guard: the UI that ships must be the UI in the source tree, wired into the real routes.
//
//   node scripts/check-ui.mjs                 static checks on studio/app/src (router, screens)
//   node scripts/check-ui.mjs --exe <exe>     + the built exe must embed exactly this frontend
//                                              (exe `--cli build-info` frontendSha256 == hash of src/)
//
// Why: v0.3.2 was published with a version bump while the new 新影片 / 製作狀態 pages existed only on a development
// branch; the router still served the v0.2 auto-production page. Exit code 1 on any failure.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(APP, 'src');
const fails = [];
const ok = [];
const check = (cond, msg) => (cond ? ok : fails).push(msg);

// ---- 1. router: new pages are real top-level sections, the old page is gone ----
const main = readFileSync(join(SRC, 'js', 'main.js'), 'utf8');
const sections = /export const SECTIONS\s*=\s*\[([^\]]*)\]/.exec(main)?.[1].split(',').map((s) => s.trim()) ?? [];
check(/import\s+create\s+from\s+'\.\/screens\/create\.js'/.test(main), "main.js imports screens/create.js (新影片)");
check(/import\s+status\s+from\s+'\.\/screens\/status\.js'/.test(main), "main.js imports screens/status.js (製作狀態)");
check(sections.includes('create') && sections.includes('status'), `SECTIONS contains create and status (got: ${sections.join(', ')})`);
check(/auto:\s*'create'/.test(main), "legacy route #/auto redirects to the new 新影片 page");
check(!existsSync(join(SRC, 'js', 'screens', 'auto.js')), 'old v0.2 page screens/auto.js is not shipped');
const files = [];
const walk = (d) => readdirSync(d).forEach((n) => { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); });
walk(SRC);
const importsAuto = files.filter((f) => f.endsWith('.js') && /from\s+['"][^'"]*screens\/auto\.js['"]/.test(readFileSync(f, 'utf8')));
check(importsAuto.length === 0, `no module imports screens/auto.js${importsAuto.length ? ': ' + importsAuto.map((f) => relative(SRC, f)).join(', ') : ''}`);
const projects = readFileSync(join(SRC, 'js', 'screens', 'projectsx.js'), 'utf8');
check(!/id:\s*'auto'/.test(projects), "專案 section has no old 'auto' tab");

// ---- 2. frontend fingerprint (same rule as src-tauri/build.rs) ----
const rels = files.map((f) => relative(SRC, f).split(sep).join('/')).sort();
const h = createHash('sha256');
for (const r of rels) {
  const b = readFileSync(join(SRC, ...r.split('/')));
  h.update(r); h.update(Buffer.from([0]));
  h.update(Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')); h.update(Buffer.from([0]));
}
const srcHash = h.digest('hex');
console.log(`frontend src: ${rels.length} files, sha256 ${srcHash}`);

// ---- 3. the built exe embeds exactly this frontend ----
const ei = process.argv.indexOf('--exe');
if (ei > 0) {
  const exe = process.argv[ei + 1];
  const r = spawnSync(exe, ['--cli', 'build-info'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  let info = null;
  try { info = JSON.parse((r.stdout || '').trim()); } catch {}
  check(!!info, `exe answers --cli build-info (${exe})`);
  if (info) {
    console.log(`exe: v${info.version}, frontend ${info.frontendFiles} files, sha256 ${info.frontendSha256}`);
    check(info.frontendSha256 === srcHash, 'exe embeds the same frontend as src/ (sha256 match)');
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
    check(info.version === pkg.version, `exe version ${info.version} == package.json ${pkg.version}`);
  }
}

for (const m of ok) console.log('  ✓ ' + m);
for (const m of fails) console.log('  ✗ ' + m);
if (fails.length) {
  console.log(`\nUI release check FAILED (${fails.length})`);
  process.exit(1);
}
console.log('\nUI release check passed');
