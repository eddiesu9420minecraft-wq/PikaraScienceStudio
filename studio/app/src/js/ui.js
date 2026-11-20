// DOM helpers and shared components (Button, Sheet, Toast, EmptyState, NotReady, ...)
import { t } from './i18n.js';
import { NotReady, errText, call } from './api.js';
import { icon } from './icons.js';

// h('div.cls#id', {attrs}, ...children)
export function h(sel, attrs, ...kids) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  (m[2] || '').replace(/([.#])([\w-]+)/g, (_, k, v) => { if (k === '.') el.classList.add(v); else el.id = v; });
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...kids) { clear(el); append(el, kids); return el; }

export function btn(label, opts = {}) {
  const cls = ['btn', opts.kind || '', opts.small ? 'small' : '', opts.icon && !label ? 'icon' : ''].filter(Boolean).join(' ');
  const b = h('button', {
    type: 'button', class: cls, title: opts.title || (label ? null : opts.aria), 'aria-label': opts.aria || null,
    disabled: opts.disabled || null, onclick: opts.onClick,
  }, opts.icon ? icon(opts.icon) : null, label ? h('span', label) : null, opts.kbd ? h('span.kbd', opts.kbd) : null);
  if (opts.disabled && opts.why) { b.disabled = false; b.setAttribute('aria-disabled', 'true'); b.title = opts.why; b.onclick = null; }
  return b;
}

// run async handler with busy state on a button
export async function busy(button, fn) {
  if (!button) return fn();
  const prev = button.innerHTML; button.disabled = true;
  button.classList.add('is-busy');
  try { return await fn(); } finally { button.disabled = false; button.classList.remove('is-busy'); button.innerHTML = prev; }
}

export function seg(options, value, onChange, opts = {}) {
  const wrap = h('div.seg', { role: 'group', 'aria-label': opts.aria || null });
  for (const o of options) {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), disabled: o.disabled || null, title: o.title || null }, o.label);
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onChange(o.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

export function toggle(label, checked, onChange, opts = {}) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, disabled: opts.disabled || null });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label.toggle', { title: opts.title || null }, input, h('span.callout', label));
}

export function field(label, control, extra) {
  return h('div.field', h('label', label), control, extra || null);
}

export function dot(status) {
  const s = statusClass(status);
  return h('span', { class: `dot ${s}`, 'aria-hidden': 'true' });
}
export function statusClass(s) {
  s = String(s || '').toLowerCase();
  if (['ok', 'pass', 'passed', 'succeeded', 'success', 'done', 'ready'].includes(s)) return 'ok';
  if (['warn', 'warning', 'waiting_resource', 'paused', 'blocked', 'interrupted', 'fix_ready'].includes(s)) return 'warn';
  if (['fail', 'failed', 'error', 'canceled', 'cancelled', 'missing'].includes(s)) return 'fail';
  if (['running', 'started', 'active'].includes(s)) return 'running';
  return 'idle';
}
export function tag(text, kind = '') { return h('span', { class: `tag ${kind}` }, text); }

export function progress(frac, kind = '') {
  const indet = frac == null || Number.isNaN(frac);
  const p = h('div', { class: `progress ${kind} ${indet ? 'indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': indet ? null : String(Math.round(frac * 100)) });
  p.appendChild(h('span', { style: { width: indet ? '30%' : `${Math.max(0, Math.min(1, frac)) * 100}%` } }));
  return p;
}

// ---------- states ----------
export function empty(title, text, iconName = 'inbox', action) {
  return h('div.empty', icon(iconName), h('div.headline', title), text ? h('div.callout', text) : null, action || null);
}
export function loading(rows = 3) {
  return h('div.col', { style: { padding: '16px' }, 'aria-busy': 'true' }, Array.from({ length: rows }, (_, i) => h('div.skeleton', { style: { width: `${90 - i * 15}%` } })));
}
export function notReady(cmd, detail) {
  const cmds = Array.isArray(cmd) ? cmd : [cmd];
  return h('div.empty.not-ready', icon('plug'),
    h('div.headline', t('後端尚未就緒')),
    h('div.callout', t('這個功能需要的後端指令還沒有提供，所以不顯示任何資料。')),
    h('div.row.wrap', { style: { justifyContent: 'center' } }, cmds.map((c) => h('code', c))),
    detail ? h('div.caption.muted.selectable', { style: { maxWidth: '560px', overflowWrap: 'anywhere' } }, detail) : null);
}
export function errorBox(e, retry) {
  if (e instanceof NotReady) return notReady(e.cmd, e.detail);
  return h('div.banner.fail', { role: 'alert' }, icon('alert'),
    h('div.grow', h('div', { style: { fontWeight: 600 } }, t('發生錯誤')), h('div.selectable.mono', { style: { fontSize: '12px', whiteSpace: 'pre-wrap' } }, errText(e))),
    retry ? btn(t('重試'), { small: true, onClick: retry }) : null);
}

// Load data into a container with skeleton / not-ready / error states.
export async function loadInto(container, fn, render) {
  mount(container, loading());
  try {
    const data = await fn();
    mount(container, render(data));
    return data;
  } catch (e) {
    mount(container, errorBox(e, () => loadInto(container, fn, render)));
    return undefined;
  }
}

export function needProject() {
  return empty(t('尚未選擇專案'), t('請先在「專案」頁註冊並選擇一個專案資料夾。'), 'folder',
    btn(t('前往專案'), { kind: 'primary', onClick: () => { location.hash = '#/projects'; } }));
}

// ---------- toast ----------
export function toast(text, kind = 'info', actions = []) {
  const host = document.getElementById('toasts');
  const el = h('div.toast', { role: kind === 'fail' ? 'alert' : 'status' }, dot(kind === 'info' ? 'running' : kind), h('div.grow', text),
    actions.length ? h('div.row.gap2', actions.map((a) => btn(a.label, { small: true, kind: 'plain', onClick: () => { a.onClick(); el.remove(); } }))) : null);
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'fail' ? 8000 : 5000);
}
export function toastError(e, prefix) {
  if (e instanceof NotReady) return toast(`${prefix ? prefix + '：' : ''}${t('後端尚未就緒')}（${e.cmd}）`, 'warn');
  toast(`${prefix ? prefix + '：' : ''}${errText(e)}`, 'fail');
}

// ---------- sheet ----------
export function sheet({ title, body, actions = [], wide = false, onClose }) {
  const prevFocus = document.activeElement;
  const back = h('div.sheet-backdrop');
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus(); onClose && onClose(); };
  const foot = h('div.sheet-foot');
  for (const a of actions) {
    foot.appendChild(btn(a.label, { kind: a.kind, onClick: async (ev) => { if (a.onClick) { const r = await a.onClick(ev); if (r === false) return; } close(); } }));
  }
  const dlg = h('div', { class: `sheet ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.sheet-head', h('div.headline', title)), h('div.sheet-body', body), actions.length ? foot : null);
  back.appendChild(dlg);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') { // focus trap
      const f = [...dlg.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  const first = foot.querySelector('.btn.primary, .btn.destructive') || dlg.querySelector('input, textarea, button');
  setTimeout(() => first && first.focus(), 0);
  return { close, el: dlg };
}

export function confirmSheet({ title, text, detail, confirmLabel, destructive = false }) {
  return new Promise((resolve) => {
    let ok = false;
    sheet({
      title,
      body: [h('div', text), detail ? (detail instanceof Node ? detail : h('pre.code', { style: { maxHeight: '240px' } }, detail)) : null],
      actions: [
        { label: t('取消'), onClick: () => { ok = false; } },
        { label: confirmLabel || t('確定'), kind: destructive ? 'destructive solid' : 'primary', onClick: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

// ---------- clipboard ----------
export async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(label ? t('已複製：{x}', { x: label }) : t('已複製到剪貼簿'), 'ok');
}
export function copyBtn(getText, label) {
  return btn(t('複製'), { small: true, icon: 'copy', onClick: () => copyText(typeof getText === 'function' ? getText() : getText, label) });
}

// ---------- open path via backend ----------
export async function openPath(path, cmd = 'open_path') {
  try { await call(cmd, { path }); } catch (e) { toastError(e, t('開啟資料夾')); }
}

// ---------- formatters ----------
export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function fmtDur(s) {
  if (s == null || isNaN(s)) return '—';
  s = Number(s); const sign = s < 0 ? '-' : ''; s = Math.abs(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return sign + (hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`);
}
export function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const d = Date.parse(ts); return isNaN(d) ? null : d;
}
export function fmtTime(ts) {
  const ms = toMs(ts); if (ms == null) return '—';
  const d = new Date(ms); const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}
export function fmtAgo(ts) {
  const ms = toMs(ts); if (ms == null) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t('{n} 秒前', { n: s });
  if (s < 3600) return t('{n} 分前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小時前', { n: Math.floor(s / 3600) });
  return t('{n} 天前', { n: Math.floor(s / 86400) });
}
export function fmtNum(v, digits = 0, unit = '') {
  if (v == null || v === '' || isNaN(v)) return '—';
  return `${Number(v).toFixed(digits)}${unit}`;
}
export function basename(p) { return String(p || '').split(/[\\/]/).pop(); }
export function dirname(p) { const s = String(p || ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : s; }
export function joinPath(a, b) { if (!a) return b; if (/^[a-z]:[\\/]|^[\\/]/i.test(b)) return b; return `${a.replace(/[\\/]+$/, '')}\\${String(b).replace(/\//g, '\\')}`; }
