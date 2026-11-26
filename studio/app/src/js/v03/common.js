// Shared v0.3 building blocks: page header, tabs that embed v0.2 screens, episode / language picker,
// status pills, small popup menu, audio element for project files.
import { t } from '../i18n.js';
import { h, mount, btn, toastError, empty } from '../ui.js';
import { icon } from '../icons.js';
import { call, fileSrc, hasTauri } from '../api.js';
import { store, ensureAssets } from '../store.js';

export function pageHead(title, lede, ...right) {
  return h('div.page-head', h('div.grow', h('h1.large', title), lede ? h('div.lede', lede) : null), ...right);
}

export function card(title, body, opts = {}) {
  return h(`div.card${opts.flush ? '.flush' : ''}`, { id: opts.id || null },
    title ? h('div.card-head', h('div.t', title), ...(opts.actions || [])) : null,
    h('div.card-body', body));
}

const STATUS_TEXT = { fresh: '最新', done: '完成', stale: '需要更新', missing: '尚未產生', none: '未使用', running: '執行中' };
export function statusPill(s) {
  return h('span', { class: `status-pill ${s}` }, t(STATUS_TEXT[s] || s));
}

/**
 * Tabbed section. `tabs` = [{ id, title, render(el, ctx) } | { id, title, screen }]; v0.2 screens render into the tab
 * body with a sub-context (their toolbar actions go to the section toolbar).
 */
export async function tabbed(ctx, title, tabs, opts = {}) {
  const cur = tabs.find((x) => x.id === ctx.tab) || tabs[0];
  const bar = h('div.tabs', { role: 'tablist', 'aria-label': title },
    tabs.map((x) => h('button.tab', { type: 'button', role: 'tab', 'aria-selected': String(x.id === cur.id), dataset: { tab: x.id },
      onclick: () => ctx.setTab(x.id) }, t(x.title))));
  const body = h('div.tab-body', { role: 'tabpanel' });
  mount(ctx.content, h('div.page', { style: { paddingBottom: '0', gap: '0' } }, opts.head || null, bar), body);
  ctx.toolbar(title, t(cur.title), []);
  if (cur.screen) {
    const sub = {
      ...ctx, content: body,
      toolbar: (ti, s, actions) => ctx.toolbar(title, s ? `${t(cur.title)} · ${s}` : t(cur.title), actions),
    };
    await cur.screen.render(sub);
  } else {
    await cur.render(body, ctx);
  }
}

// ---------------------------------------------------------------- episode / language selection

export const LOCALES = [{ value: 'zh-TW', label: '繁中 zh-TW' }, { value: 'zh-CN', label: '简中 zh-CN' }];

export function selected() {
  return { episode: localStorage.getItem('ws.episode') || null, locale: localStorage.getItem('ws.locale') || 'zh-TW' };
}
export function select(episode, locale) {
  if (episode) localStorage.setItem('ws.episode', episode);
  if (locale) localStorage.setItem('ws.locale', locale);
}

export async function episodes(force = false) {
  if (!store.projectId) return [];
  if (!force && store.episodes && store.episodes.pid === store.projectId) return store.episodes.list;
  const list = await call('episode_list', { projectId: store.projectId });
  store.episodes = { pid: store.projectId, list: list || [] };
  return store.episodes.list;
}

/** Episode + language pickers; calls onChange(episode, locale). Only languages that exist for the episode are enabled. */
export function epPicker(list, cur, onChange) {
  const sel = h('select.select', { 'aria-label': t('集數'), style: { width: '260px' } },
    list.map((e) => h('option', { value: e.id, selected: e.id === cur.episode ? true : null }, `${e.id.toUpperCase()} · ${e.title || ''}`)));
  const ep = list.find((e) => e.id === cur.episode) || list[0];
  const loc = h('div.seg', { role: 'group', 'aria-label': t('語言版本') },
    LOCALES.map((l) => h('button', { type: 'button', 'aria-pressed': String(l.value === cur.locale), disabled: ep && !ep.locales[l.value] ? true : null,
      onclick: () => onChange(sel.value, l.value) }, l.label)));
  sel.addEventListener('change', () => {
    const e = list.find((x) => x.id === sel.value);
    const l = e && e.locales[cur.locale] ? cur.locale : (e && Object.keys(e.locales)[0]) || 'zh-TW';
    onChange(sel.value, l);
  });
  return h('div.row.gap2.wrap', sel, loc);
}

/** Resolve the current episode/language (falls back to the first episode that exists). */
export function resolveSel(list) {
  const s = selected();
  let e = list.find((x) => x.id === s.episode) || list.find((x) => x.locales && x.locales['zh-TW']) || list[0];
  if (!e) return null;
  const locale = e.locales[s.locale] ? s.locale : Object.keys(e.locales)[0];
  return { episode: e.id, locale, info: e };
}

export function needEpisode(ctx) {
  return h('div.page', empty(t('這個專案還沒有影片'), t('到「專案」建立第一集，或用「自動製作」從主題開始。'), 'film',
    btn(t('前往專案'), { kind: 'primary', onClick: () => ctx.go('projects') })));
}

// ---------------------------------------------------------------- menu & audio

export function popupMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const m = h('div.menu', { role: 'menu' }, items.filter(Boolean).map((it) => h('button', { type: 'button', role: 'menuitem', disabled: it.disabled || null,
    onclick: () => { m.remove(); it.onClick(); } }, it.icon ? icon(it.icon) : null, h('span', it.label))));
  document.body.appendChild(m);
  const w = m.offsetWidth;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 4)}px`;
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  return m;
}

export async function audioFor(path) {
  if (!hasTauri || !path) return h('span.caption.muted', t('（無法播放）'));
  try { await ensureAssets(store.projectId); } catch (e) { toastError(e); }
  const a = h('audio', { controls: true, preload: 'none', src: `${fileSrc(path)}?v=${Date.now()}` });
  return a;
}

export function pathLine(p) { return h('div.pathline', { title: p }, p || '—'); }

export function fmtSecs(s) {
  if (s == null) return '—';
  s = Math.round(s);
  if (s < 60) return t('{n} 秒', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('約 {m} 分 {s} 秒', { m, s: s % 60 });
  return t('約 {h} 小時 {m} 分', { h: Math.floor(m / 60), m: m % 60 });
}
