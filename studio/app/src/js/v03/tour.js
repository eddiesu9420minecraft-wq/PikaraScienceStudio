// UI tour (debug harness, only when Studio runs with PIKARA_UI_TOUR=1). Visits every section and tab in light and
// dark mode, at the current window size, and reports for each step:
//   - layout problems: elements wider than their box that are not scroll / ellipsis containers, content outside the
//     viewport, overlapping toolbar actions, zero-size buttons;
//   - buttons without a visible label or aria-label, error banners / failed toasts on screen;
//   - navigation state: the active sidebar item and selected tab must match the route.
// Each step is written with ui_tour_report(step, data); scripts/ui_tour_capture.ps1 waits for current.txt to change
// and captures the real window (PrintWindow) — so the screenshot and the checks describe the same state.
import { call } from '../api.js';
import { forceTheme } from './theme.js';
import { select } from './common.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function layoutIssues() {
  const issues = [];
  const vw = window.innerWidth;
  const root = document.querySelector('.app');
  const scrollish = (el) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowX) || s.textOverflow === 'ellipsis' || el.closest('.tabs, .pathline, pre, .code, .log, .table-wrap, .scenebar, .stage .loc'); };
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !scrollish(el) && s.overflowX !== 'hidden' && el.children.length) {
      issues.push({ kind: 'overflow', sel: describe(el), over: el.scrollWidth - el.clientWidth });
    }
    if (r.right > vw + 2 && !el.closest('.content, .tabs, .nav')) issues.push({ kind: 'offscreen', sel: describe(el), right: Math.round(r.right), vw });
  }
  for (const b of root.querySelectorAll('button')) {
    const r = b.getBoundingClientRect();
    if (getComputedStyle(b).display === 'none' || b.closest('[hidden]')) continue;
    if (r.width > 0 && r.height > 0 && r.height < 16) issues.push({ kind: 'tiny-button', sel: describe(b), h: r.height });
    const label = (b.textContent || '').trim() || b.getAttribute('aria-label') || b.getAttribute('title');
    if (!label) issues.push({ kind: 'unlabeled-button', sel: describe(b) });
  }
  const tb = document.getElementById('toolbar');
  if (tb && tb.scrollWidth > tb.clientWidth + 2) issues.push({ kind: 'toolbar-overflow', over: tb.scrollWidth - tb.clientWidth });
  return dedupe(issues);
}

function dedupe(a) {
  const seen = new Set();
  return a.filter((x) => { const k = `${x.kind}:${x.sel}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}

function describe(el) {
  const parts = [];
  for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
    parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''));
  }
  return parts.join(' > ');
}

function stateCheck(sectionId, tabId) {
  const nav = document.querySelector('.nav-item[aria-current="page"]');
  const tab = document.querySelector('.tab[aria-selected="true"]');
  const errors = [...document.querySelectorAll('.banner.fail')].map((b) => b.textContent.trim().slice(0, 200));
  const toasts = [...document.querySelectorAll('.toast')].map((x) => x.textContent.trim().slice(0, 160));
  const notReady = [...document.querySelectorAll('.not-ready')].map((x) => x.textContent.trim().slice(0, 160));
  return {
    navOk: !!nav && nav.dataset.route === sectionId,
    tabOk: !tabId || (!!tab && tab.dataset.tab === tabId),
    errors, toasts, notReady,
    title: document.getElementById('tb-title').textContent,
  };
}

export async function runTour({ go, info, sections }) {
  const stepMs = info.uiTourStepMs || 2500;
  if (info.uiTourEpisode) { const [e, l] = info.uiTourEpisode.split(':'); select(e, l || 'zh-TW'); }
  // tabs per section (kept here so the sections stay simple)
  const TABS = { projects: ['videos', 'auto', 'publish', 'folders'], editor: ['workspace', 'script', 'production'], settings: ['general', 'hardware'], diagnostics: ['system', 'gpu', 'doctor', 'monitor', 'history'] };
  const steps = [];
  for (const theme of ['light', 'dark']) {
    for (const s of sections) for (const tb of TABS[s.id] || [null]) steps.push({ theme, section: s.id, tab: tb });
  }
  const summary = [];
  // self-test: a deliberately overflowing box and an unlabeled button must be reported (proves the checks are not blind)
  const probe = document.createElement('div');
  probe.style.cssText = 'width:120px;height:40px;';
  probe.innerHTML = '<div style="width:600px;height:20px;white-space:nowrap">overflow probe</div><button type="button" style="width:20px;height:20px"></button>';
  document.getElementById('content').prepend(probe);
  await sleep(50);
  const found = layoutIssues().filter((x) => x.sel && (x.sel.includes('content') || x.kind === 'unlabeled-button'));
  probe.remove();
  const selfTest = { overflowDetected: found.some((x) => x.kind === 'overflow'), unlabeledDetected: found.some((x) => x.kind === 'unlabeled-button') };
  await call('ui_tour_report', { step: 'start', data: { steps: steps.length, w: window.innerWidth, h: window.innerHeight, selfTest } });
  for (const [i, st] of steps.entries()) {
    forceTheme(st.theme);
    go(st.tab ? `${st.section}/${st.tab}` : st.section);
    await sleep(stepMs);
    const name = `${String(i + 1).padStart(2, '0')}-${st.theme}-${st.section}${st.tab ? '-' + st.tab : ''}`;
    const data = { ...st, w: window.innerWidth, h: window.innerHeight, issues: layoutIssues(), state: stateCheck(st.section, st.tab) };
    summary.push({ name, issues: data.issues.length, navOk: data.state.navOk, tabOk: data.state.tabOk, errors: data.state.errors.length });
    await call('ui_tour_report', { step: name, data });
    await sleep(900); // capture window
  }
  // interaction checks: every sidebar item and tab button actually navigates
  const nav = [];
  for (const b of document.querySelectorAll('.nav-item')) { b.click(); await sleep(600); nav.push({ route: b.dataset.route, ok: location.hash.startsWith(`#/${b.dataset.route}`) && document.querySelector('.nav-item[aria-current="page"]') === b }); }
  go('editor/workspace'); await sleep(stepMs);
  const tabsClicked = [];
  for (const b of [...document.querySelectorAll('.tab')]) { const id = b.dataset.tab; b.click(); await sleep(stepMs); tabsClicked.push({ tab: id, ok: (document.querySelector('.tab[aria-selected="true"]') || {}).dataset?.tab === id }); }
  await call('ui_tour_report', { step: 'done', data: { summary, nav, tabsClicked, selfTest } });
}
