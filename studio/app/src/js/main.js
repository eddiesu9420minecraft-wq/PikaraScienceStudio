// v0.3 app shell: 8 sections (Dashboard, Projects, Editor, Queue, Voice Studio, Assets, Settings, Diagnostics),
// hash router #/<section>/<tab>, theme (light / dark / system), UI language, backend health watch, UI tour harness.
// v0.2 screens are embedded unchanged as tabs (their routes #/queue, #/doctor … still work as aliases).
import { t, setLang, getLang, onLang, applyStatic } from './i18n.js';
import { h, mount, toast } from './ui.js';
import { icon } from './icons.js';
import { hasTauri, call } from './api.js';
import { store, on, refreshProjects, currentProject, wireEvents, monitorHistory } from './store.js';
import { showWelcome } from './screens/guide.js';
import { setTheme, getThemePref, onThemeChange } from './v03/theme.js';
import { runTour } from './v03/tour.js';
import { createBridge, mountReveal } from '../vendor/pikara-splash/pikara-splash.js';

import dashboard from './screens/dashboard.js';
import projectsx from './screens/projectsx.js';
import editor from './screens/editor.js';
import queuex from './screens/queuex.js';
import voice from './screens/voice.js';
import assetsx from './screens/assetsx.js';
import settings from './screens/settingsx.js';
import diagnostics from './screens/diagnostics.js';

export const SECTIONS = [dashboard, projectsx, editor, queuex, voice, assetsx, settings, diagnostics];
// v0.2 route ids → section/tab
const ALIASES = {
  auto: 'projects/auto', publish: 'projects/publish', projects: 'projects/folders', guide: 'projects/guide',
  script: 'editor/script', prompt: 'editor/prompt', production: 'editor/production',
  queue: 'queue/jobs', monitor: 'diagnostics/monitor', doctor: 'diagnostics/doctor', rollback: 'diagnostics/history',
};

const $ = (id) => document.getElementById(id);
let active = null;
let renderSeq = 0;

function buildNav() {
  const nav = $('nav');
  mount(nav, SECTIONS.map((s, i) => [
    i === 6 ? h('div.nav-sep', { role: 'separator' }) : null,
    h('button.nav-item', { type: 'button', dataset: { route: s.id }, onclick: () => go(s.id), title: t(s.title),
      'aria-current': active && active.section.id === s.id ? 'page' : null },
    icon(s.icon), h('span.label', t(s.title)), h('span', { class: 'badge', id: `badge-${s.id}`, hidden: true }), h('span.kbd-hint', `Ctrl ${i + 1}`)),
  ]));
  updateBadges();
}

function updateProjectChip() {
  const p = currentProject();
  mount($('project-chip'), p
    ? [h('span', t('目前專案')), h('b.ellipsis', { title: p.rootPath }, p.name)]
    : h('span', hasTauri ? t('尚未選擇專案') : t('未連接 Studio 後端')));
}

function updateBadges() {
  const q = store.queue;
  const b = $('badge-queue');
  if (!b) return;
  if (q) {
    const n = (q.running ? q.running.length : 0) + (q.queued || 0);
    b.hidden = n === 0; b.textContent = n; b.className = 'badge info';
    b.title = t('執行中 {r}・等待 {q}', { r: q.running ? q.running.length : 0, q: q.queued || 0 });
  } else b.hidden = true;
}

export function go(path) { location.hash = `#/${path}`; }

function parseRoute() {
  let raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query] = raw.split('?');
  let path = pathPart;
  const first = path.split('/')[0];
  if (ALIASES[first] && !SECTIONS.find((s) => s.id === first)) path = ALIASES[first] + path.slice(first.length);
  const [sid, tab] = path.split('/');
  const section = SECTIONS.find((s) => s.id === sid) || (store.projects && store.projects.length ? dashboard : projectsx);
  return { section, tab: tab || null, query: new URLSearchParams(query || '') };
}

async function route() {
  const { section, tab, query } = parseRoute();
  if (active) active.cleanups.forEach((f) => { try { f(); } catch {} });
  const cleanups = [];
  active = { section, cleanups };
  const seq = ++renderSeq;
  document.querySelectorAll('.nav-item').forEach((n) => n.setAttribute('aria-current', n.dataset.route === section.id ? 'page' : 'false'));
  const content = $('content');
  mount(content);
  content.scrollTop = 0;
  const ctx = {
    content, tab, query,
    project: currentProject(),
    projectId: store.projectId,
    toolbar: (title, sub, actions) => {
      if (seq !== renderSeq) return;
      $('tb-title').textContent = title || t(section.title);
      $('tb-sub').textContent = sub || '';
      mount($('tb-actions'), actions || []);
    },
    subtitle: (s) => { if (seq === renderSeq) $('tb-sub').textContent = s || ''; },
    cleanup: (f) => cleanups.push(f),
    alive: () => seq === renderSeq,
    rerender: () => route(),
    go,
    setTab: (id) => { history.replaceState(null, '', `#/${section.id}/${id}`); route(); },
  };
  ctx.toolbar(t(section.title), '', []);
  document.title = `${t(section.title)} — Pikara Studio`;
  try { await section.render(ctx); } catch (e) { console.error(e); toast(String((e && e.message) || e), 'fail'); }
}

function wireLang() {
  const segEl = $('lang-seg');
  const sync = () => segEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === getLang())));
  segEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLang(b.dataset.lang); });
  onLang(() => { sync(); buildNav(); updateProjectChip(); route(); });
  sync();
}

function wireTheme() {
  const segEl = $('theme-seg');
  const sync = () => segEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === getThemePref())));
  segEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTheme(b.dataset.theme); });
  onThemeChange(sync);
  sync();
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-8]$/.test(e.key)) {
      const s = SECTIONS[Number(e.key) - 1];
      if (s) { e.preventDefault(); go(s.id); }
    }
  });
  $('nav').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...document.querySelectorAll('.nav-item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
}

// Shared Pikara splash (vendor/pikara-splash): the backend initializes behind the splash window; this
// (hidden) window waits for it, renders real data, reports main_ready, then is revealed.
const splash = hasTauri ? createBridge() : null;
if (splash) {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-window').trim();
  mountReveal(document.body, { theme: document.documentElement.dataset.theme, background: bg || undefined });
}

async function boot() {
  if (splash) await splash.waitReady().catch(() => {});
  applyStatic(document);
  buildNav();
  wireLang();
  wireTheme();
  wireKeys();
  updateProjectChip();
  on('project', () => updateProjectChip());
  on('queue', () => updateBadges());
  on('job', (j) => {
    if (!j || !['succeeded', 'failed', 'interrupted'].includes(j.status)) return;
    const key = `${j.id}:${j.status}`;
    if (seenFinal.has(key)) return; seenFinal.add(key);
    const kind = j.status === 'succeeded' ? 'ok' : 'fail';
    toast(`${j.label || j.kind}：${t(j.status === 'succeeded' ? '完成' : j.status === 'failed' ? '失敗' : '中斷')}${j.error ? ' — ' + j.error : ''}`, kind,
      kind === 'fail' ? [{ label: t('查看紀錄'), onClick: () => { sessionStorage.setItem('queue.select', j.id); go('queue/jobs'); } }, { label: t('診斷'), onClick: () => go('diagnostics/doctor') }] : []);
  });
  window.addEventListener('hashchange', route);
  let info = null;
  if (hasTauri) {
    wireEvents();
    try { await refreshProjects(); } catch (e) { console.warn('project_list', e); }
    try { store.queue = await call('queue_status'); updateBadges(); } catch {}
    try {
      info = await call('app_info');
      store.appInfo = info;
      if (info && info.version) $('brand-sub').textContent = `v${info.version}`;
      if (info && info.schedulerActive === false && !info.uiTour) toast(t('另一個 Studio 程式正在執行佇列，這個視窗不會開始任何工作（只能檢視）。請關閉另一個後重新開啟。'), 'warn');
    } catch {}
  }
  // first screen rendered with real data → hand off from the splash. Capped so one slow screen
  // can't hold the splash (the screen keeps loading in the visible window).
  await Promise.race([route(), new Promise((r) => setTimeout(r, 2500))]);
  if (splash) splash.mainReady().catch(() => {});
  if (info && info.uiTour) { runTour({ go, info, sections: SECTIONS }); return; }
  showWelcome(go);
  if (hasTauri) watchBackend();
}
const seenFinal = new Set();

// 後端健康：2026-11-23 GPU 驅動重置後 Studio 的背景執行緒停住 106 分鐘，畫面上看不出來。
function watchBackend() {
  let warnedSilent = false;
  const warnedThreads = new Set();
  setInterval(() => {
    const last = monitorHistory[monitorHistory.length - 1];
    const age = last ? (Date.now() - last.ts) / 1000 : 0;
    if (last && age > 60) {
      if (!warnedSilent) {
        warnedSilent = true;
        toast(t('Studio 背景程序已 {n} 秒沒有回應，佇列可能已停止。詳情見資料夾 logs\studio-watchdog.log；必要時重新啟動 Studio（已完成的音檔與進度都會保留）。', { n: Math.round(age) }), 'warn');
      }
    } else warnedSilent = false;
    const th = (last && last.threads) || {};
    for (const [name, v] of Object.entries(th)) {
      if (v && v.stalled && !warnedThreads.has(name)) {
        warnedThreads.add(name);
        toast(t('Studio 背景執行緒「{x}」已 {n} 秒沒有進展（正在：{d}）。', { x: name, n: v.ageSec, d: v.doing || '?' }), 'warn');
      } else if (v && !v.stalled) warnedThreads.delete(name);
    }
  }, 15000);
}

boot();
