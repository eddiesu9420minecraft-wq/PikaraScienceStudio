// App shell: sidebar navigation, hash router, toolbar, global listeners.
import { t, setLang, getLang, onLang, applyStatic } from './i18n.js';
import { h, mount, btn, toast } from './ui.js';
import { icon } from './icons.js';
import { hasTauri, call } from './api.js';
import { store, on, refreshProjects, currentProject, wireEvents } from './store.js';

import projects from './screens/projects.js';
import script from './screens/script.js';
import prompt from './screens/prompt.js';
import production from './screens/production.js';
import queue from './screens/queue.js';
import monitor from './screens/monitor.js';
import doctor from './screens/doctor.js';
import publish from './screens/publish.js';
import rollback from './screens/rollback.js';

const SCREENS = [projects, script, prompt, production, queue, monitor, doctor, publish, rollback];
const GROUPS = [
  { title: '工作區', ids: ['projects'] },
  { title: '內容', ids: ['script', 'prompt'] },
  { title: '執行', ids: ['production', 'queue', 'monitor'] },
  { title: '交付', ids: ['publish', 'rollback'] },
  { title: '系統', ids: ['doctor'] },
];

const $ = (id) => document.getElementById(id);
let active = null;      // { screen, cleanups: [] }
let renderSeq = 0;

function buildNav() {
  const nav = $('nav');
  mount(nav, GROUPS.map((g) => h('div.nav-group', { role: 'group', 'aria-label': t(g.title) },
    h('div.nav-group-title', t(g.title)),
    g.ids.map((id) => {
      const s = SCREENS.find((x) => x.id === id);
      return h('button.nav-item', { type: 'button', dataset: { route: id }, onclick: () => go(id), 'aria-current': active && active.screen.id === id ? 'page' : null },
        icon(s.icon), h('span.label', t(s.title)), h('span', { class: 'badge', id: `badge-${id}`, hidden: true }));
    }))));
  updateBadges();
}

function updateProjectChip() {
  const p = currentProject();
  mount($('project-chip'), p
    ? [h('span', t('目前專案')), h('b.ellipsis', { title: p.rootPath }, p.name)]
    : h('span', hasTauri ? t('尚未開啟專案') : t('未連接到 Studio 後端')));
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

export function go(id) { location.hash = `#/${id}`; }

async function route() {
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'projects';
  const screen = SCREENS.find((s) => s.id === id) || projects;
  if (active) { active.cleanups.forEach((f) => { try { f(); } catch {} }); }
  const cleanups = [];
  active = { screen, cleanups };
  const seq = ++renderSeq;
  document.querySelectorAll('.nav-item').forEach((n) => n.setAttribute('aria-current', n.dataset.route === screen.id ? 'page' : 'false'));
  const content = $('content');
  mount(content);
  content.scrollTop = 0;
  const ctx = {
    content,
    project: currentProject(),
    projectId: store.projectId,
    toolbar: (title, sub, actions) => {
      if (seq !== renderSeq) return;
      $('tb-title').textContent = title || t(screen.title);
      $('tb-sub').textContent = sub || '';
      mount($('tb-actions'), actions || []);
    },
    subtitle: (s) => { if (seq === renderSeq) $('tb-sub').textContent = s || ''; },
    cleanup: (f) => cleanups.push(f),
    alive: () => seq === renderSeq,
    rerender: () => route(),
    go,
  };
  ctx.toolbar(t(screen.title), '', []);
  document.title = `${t(screen.title)} — Pikara Studio`;
  try { await screen.render(ctx); } catch (e) { console.error(e); toast(String(e && e.message || e), 'fail'); }
}

function wireLang() {
  const segEl = $('lang-seg');
  const sync = () => segEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === getLang())));
  segEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLang(b.dataset.lang); });
  onLang(() => { sync(); buildNav(); updateProjectChip(); route(); });
  sync();
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+1..9 jumps to sidebar entries in order
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const order = GROUPS.flatMap((g) => g.ids);
      const id = order[Number(e.key) - 1];
      if (id) { e.preventDefault(); go(id); }
    }
  });
  // arrow-key navigation inside the sidebar
  $('nav').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...document.querySelectorAll('.nav-item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
}

async function boot() {
  applyStatic(document);
  buildNav();
  wireLang();
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
      kind === 'fail' ? [{ label: t('查看 log'), onClick: () => { sessionStorage.setItem('queue.select', j.id); go('queue'); } }, { label: t('交給 Doctor'), onClick: () => go('doctor') }] : []);
  });
  window.addEventListener('hashchange', route);
  if (hasTauri) {
    wireEvents();
    try { await refreshProjects(); } catch (e) { console.warn('project_list', e); }
    try { store.queue = await call('queue_status'); updateBadges(); } catch {}
  }
  route();
}
const seenFinal = new Set();

boot();
