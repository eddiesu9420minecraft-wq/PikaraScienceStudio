// UI tour (debug harness, only when Studio runs with PIKARA_UI_TOUR=1). Visits every section and tab in light and
// dark mode, at the current window size, and reports for each step:
//   - layout problems: elements wider than their box that are not scroll / ellipsis containers, content outside the
//     viewport, overlapping toolbar actions, zero-size buttons;
//   - buttons without a visible label or aria-label, error banners / failed toasts on screen;
//   - navigation state: the active sidebar item and selected tab must match the route.
// Each step is written with ui_tour_report(step, data); scripts/ui_tour_capture.ps1 waits for current.txt to change
// and captures the real window (PrintWindow) — so the screenshot and the checks describe the same state.
import { call } from '../api.js';
import { forceTheme, effectiveTheme } from './theme.js';
import { setLang } from '../i18n.js';
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
  // 介面語言（不保存）與主題清單：light、dark、system（system＝依 Windows 設定，驗證「自動」的對應）
  if (info.uiTourLang) { setLang(info.uiTourLang, false); await sleep(300); }
  const themes = (info.uiTourThemes || 'light,dark').split(',').map((x) => x.trim()).filter(Boolean);
  const only = info.uiTourOnly ? info.uiTourOnly.split(',').map((x) => x.trim()) : null;
  // tabs per section (kept here so the sections stay simple)
  const TABS = { status: [null], projects: ['videos', 'publish', 'folders', 'guide'], editor: ['workspace', 'script', 'production'], settings: ['general', 'hardware'], diagnostics: ['system', 'gpu', 'doctor', 'monitor', 'history'] };
  const steps = [];
  for (const theme of themes) {
    for (const s of sections) {
      if (only && !only.includes(s.id)) continue;
      for (const tb of TABS[s.id] || [null]) steps.push({ theme, section: s.id, tab: tb });
    }
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
    forceTheme(st.theme === 'system' ? effectiveTheme('system') : st.theme);
    go(st.tab ? `${st.section}/${st.tab}` : st.section);
    await sleep(stepMs);
    const name = `${String(i + 1).padStart(2, '0')}-${st.theme}-${st.section}${st.tab ? '-' + st.tab : ''}`;
    const data = { ...st, w: window.innerWidth, h: window.innerHeight, issues: layoutIssues(), state: stateCheck(st.section, st.tab) };
    summary.push({ name, issues: data.issues.length, navOk: data.state.navOk, tabOk: data.state.tabOk, errors: data.state.errors.length });
    await call('ui_tour_report', { step: name, data });
    await sleep(2200); // capture window（電腦忙碌時 PrintWindow 較慢，留足時間避免漏拍）
  }
  // interaction checks: every sidebar item and tab button actually navigates
  const nav = [];
  for (const b of document.querySelectorAll('.nav-item')) { b.click(); await sleep(600); nav.push({ route: b.dataset.route, ok: location.hash.startsWith(`#/${b.dataset.route}`) && document.querySelector('.nav-item[aria-current="page"]') === b }); }
  go('editor/workspace'); await sleep(stepMs);
  const tabsClicked = [];
  for (const b of [...document.querySelectorAll('.tab')]) { const id = b.dataset.tab; b.click(); await sleep(stepMs); tabsClicked.push({ tab: id, ok: (document.querySelector('.tab[aria-selected="true"]') || {}).dataset?.tab === id }); }
  await call('ui_tour_report', { step: 'done', data: { summary, nav, tabsClicked, selfTest } });
}

// ---------------------------------------------------------------- 操作測試（PIKARA_UI_TOUR_ACTIONS=<製作 id>）
// 在「製作狀態」用真的按鈕操作一部 Sandbox 測試影片：開始 → 暫停 → 繼續 → 更多 › 刪除影片任務，確認對話框按主要按鈕。
// 每一步記錄畫面上的狀態與後端（auto_board）的狀態，並截圖。需要另一個程序（命令列 auto-run）執行佇列。
const text = (el) => (el ? el.textContent.trim() : '');
function findBtn(label, root = document) { return [...root.querySelectorAll('button')].find((b) => text(b) === label || text(b).startsWith(label)); }
async function confirmIfAsked() {
  await sleep(500);
  const b = document.querySelector('.sheet-foot .btn.primary, .sheet-foot .btn.destructive.solid');
  if (b) { const label = text(b); b.click(); await sleep(800); return label; }
  return null;
}
export async function runActionTour({ go, info }) {
  const id = info.uiTourActions;
  const stepMs = info.uiTourStepMs || 2500;
  const log = [];
  const backend = async () => { try { const [x] = await call('auto_board', { id }); return x ? x.status : null; } catch (e) { return `removed:${String(e).slice(0, 60)}`; } };
  const snap = async (name, extra = {}) => {
    const st = { ui: text(document.querySelector('.detail .st-pill')), backend: await backend(), ...extra };
    log.push({ name, ...st });
    await call('ui_tour_report', { step: name, data: st });
    await sleep(900);
  };
  const waitFor = async (pred, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(1000); } return false; };
  go(`status?id=${id}`); await sleep(stepMs);
  await snap('a01-draft');
  const click = async (label, name) => {
    const b = findBtn(label, document.querySelector('.detail'));
    if (!b) { log.push({ name, error: `找不到按鈕 ${label}` }); return false; }
    b.click(); const c = await confirmIfAsked(); await sleep(stepMs);
    await snap(name, { clicked: label, confirmed: c });
    return true;
  };
  await click('開始製作', 'a02-start');
  await waitFor(async () => ['running', 'waiting_agent'].includes(await backend()));
  await sleep(stepMs); await snap('a03-running');
  await click('暫停製作', 'a04-pause');
  await click('繼續製作', 'a05-resume');
  await waitFor(async () => ['running', 'waiting_agent'].includes(await backend()));
  const more = findBtn('更多', document.querySelector('.detail'));
  if (more) {
    more.click(); await sleep(600);
    await snap('a06-more-menu', { menu: [...document.querySelectorAll('.menu button')].map(text) });
    const del = [...document.querySelectorAll('.menu button')].find((b) => text(b).startsWith('刪除影片任務'));
    if (del) { del.click(); const c = await confirmIfAsked(); await sleep(stepMs); await snap('a07-deleted', { confirmed: c, stillListed: !!document.querySelector(`.prod-item[data-id="${id}"]`) }); }
  }
  await call('ui_tour_report', { step: 'done', data: { actions: log } });
}
