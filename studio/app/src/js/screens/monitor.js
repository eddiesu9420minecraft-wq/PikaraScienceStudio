// 6. Monitor — CPU/RAM/GPU/VRAM/temp/power/clock/NVENC sparklines (last 5 min) from monitor://sample.
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, empty, errorBox, notReady, tag, dot, fmtTime } from '../ui.js';
import { icon } from '../icons.js';
import { monitorHistory, pushSample, on } from '../store.js';

const WINDOW_MS = 5 * 60 * 1000;
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const METRICS = [
  { id: 'gpu', label: 'GPU', unit: '%', get: (s) => s.gpu && s.gpu.util, max: () => 100, color: '--amber', gpu: true },
  { id: 'vram', label: 'VRAM', unit: 'GiB', get: (s) => s.gpu && s.gpu.vramUsedMiB != null ? s.gpu.vramUsedMiB / 1024 : null, max: (s) => s && s.gpu && s.gpu.vramTotalMiB ? s.gpu.vramTotalMiB / 1024 : null, digits: 2, color: '--amber', gpu: true, total: (s) => s.gpu && s.gpu.vramTotalMiB ? `/ ${(s.gpu.vramTotalMiB / 1024).toFixed(1)} GiB` : '' },
  { id: 'enc', label: 'NVENC', unit: '%', get: (s) => s.gpu && s.gpu.encoderUtil, max: () => 100, color: '--amber', gpu: true },
  { id: 'temp', label: '溫度', unit: '°C', get: (s) => s.gpu && s.gpu.tempC, min: 30, max: () => 100, color: '--amber', gpu: true },
  { id: 'power', label: '功耗', unit: 'W', get: (s) => s.gpu && s.gpu.powerW, max: null, digits: 1, color: '--amber', gpu: true },
  { id: 'clock', label: 'SM 時脈', unit: 'MHz', get: (s) => s.gpu && s.gpu.smClockMHz, max: null, color: '--amber', gpu: true },
  { id: 'cpu', label: 'CPU', unit: '%', get: (s) => s.cpu && s.cpu.usage, max: () => 100, digits: 0, color: '--ice', total: (s) => s.cpu && s.cpu.cores ? t('{n} 執行緒', { n: s.cpu.cores }) : '' },
  { id: 'ram', label: 'RAM', unit: 'GiB', get: (s) => s.ram && s.ram.usedMiB / 1024, max: (s) => s && s.ram ? s.ram.totalMiB / 1024 : null, digits: 1, color: '--ice', total: (s) => s.ram ? `/ ${(s.ram.totalMiB / 1024).toFixed(1)} GiB` : '' },
];

export default {
  id: 'monitor', title: '資源', icon: 'gauge',
  async render(ctx) {
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['monitor_sample', 'event: monitor://sample']))); return; }
    ctx.toolbar(t('資源監控'), t('最近 5 分鐘・每 2 秒'), [btn('', { icon: 'refresh', aria: t('立即取樣'), onClick: () => sample() })]);
    const head = h('div');
    const grid = h('div.grid4');
    const ext = h('div');
    const page = h('div.page', head, grid, ext);
    mount(ctx.content, page);
    const cards = METRICS.map((m) => {
      const v = h('span.v', '—'); const sub = h('span.caption.muted.num'); const cv = h('canvas', { role: 'img', 'aria-label': `${t(m.label)} ${t('趨勢')}` });
      const minmax = h('span'); const card = h('div.panel.chart-card', h('div.top', h('span.k', t(m.label)), v), cv, h('div.foot', h('span', '−5:00'), minmax, sub));
      return { m, v, sub, cv, minmax, card };
    });
    mount(grid, cards.map((c) => c.card));

    const sample = async () => { try { pushSample(await call('monitor_sample')); } catch (e) { if (!monitorHistory.length) mount(head, errorBox(e, sample)); } };
    if (!monitorHistory.length) await sample();
    if (!ctx.alive()) return;

    const paint = () => {
      const last = monitorHistory[monitorHistory.length - 1];
      if (!last) { mount(head, empty(t('等待第一筆取樣…'), t('後端每 2 秒送出一次 monitor://sample。'), 'gauge')); return; }
      paintHead(head, last);
      for (const c of cards) {
        const val = c.m.get(last);
        const noGpu = c.m.gpu && !last.gpu;
        c.card.style.opacity = noGpu || val == null ? '0.55' : '1';
        mount(c.v, noGpu ? h('span.caption.muted', t('無 GPU')) : val == null ? '—' : [fmt(val, c.m.digits), h('small', c.m.unit)]);
        c.sub.textContent = c.m.total ? c.m.total(last) : '';
        const vals = monitorHistory.map((s) => c.m.get(s)).filter((x) => x != null);
        c.minmax.textContent = vals.length ? `${t('最低')} ${fmt(Math.min(...vals), c.m.digits)} · ${t('最高')} ${fmt(Math.max(...vals), c.m.digits)}` : '';
        drawSpark(c.cv, c.m, last);
      }
      paintExternal(ext, last);
    };
    paint();
    ctx.cleanup(on('monitor', paint));
    const ro = new ResizeObserver(() => paint()); ro.observe(grid); ctx.cleanup(() => ro.disconnect());
  },
};

function fmt(v, d = 0) { return Number(v).toFixed(d); }

function paintHead(box, s) {
  const g = s.gpu;
  mount(box, h('div.panel', h('div.row.wrap', { style: { padding: '12px 16px', gap: '24px' } },
    icon('cpu'),
    g ? h('span.headline', g.name) : h('span.headline.muted', t('未偵測到 NVIDIA GPU')),
    g && g.driver ? h('span.callout.muted', t('驅動 {v}', { v: g.driver })) : null,
    g ? h('span.row.gap2', dot(g.thermalHw || g.thermalSw ? 'warn' : 'ok'), h('span.callout', g.thermalHw || g.thermalSw ? t('熱降頻中（{x}）', { x: [g.thermalHw ? 'HW' : '', g.thermalSw ? 'SW' : ''].filter(Boolean).join('+') }) : t('熱降頻：否'))) : null,
    h('div.grow'),
    h('span.caption.muted.num', t('取樣 {n} 筆・最後 {x}', { n: monitorHistory.length, x: fmtTime(s.ts) + ':' + String(new Date(s.ts).getSeconds()).padStart(2, '0') })))));
}

function paintExternal(box, s) {
  const e = s.external;
  if (!e) { mount(box); return; }
  mount(box, h('section.section', h('div.section-head', h('h2.title2', t('GPU 程序')), e.busy ? tag(t('外部使用中'), 'warn') : tag(t('沒有外部佔用'), 'ok'),
    e.vramUsedMiB != null ? h('span.caption.muted.num', t('外部 VRAM {n} MiB', { n: e.vramUsedMiB })) : null),
    (e.reasons || []).length ? h('div.banner.warn', icon('alert'), h('div.grow', e.reasons.map((r) => h('div', r)))) : null,
    (e.processes || []).length
      ? h('div.panel.table-wrap', h('table.table', h('thead', h('tr', h('th.num', 'PID'), h('th', t('名稱')), h('th', t('指令')))),
        h('tbody', e.processes.map((p) => h('tr', h('td.num.mono', p.pid), h('td', p.name), h('td.mono.caption', { style: { overflowWrap: 'anywhere' } }, p.cmd || ''))))))
      : h('div.caption.muted', t('沒有偵測到其他 GPU 程序。'))));
}

function drawSpark(cv, m, last) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, hgt = cv.clientHeight;
  if (!w || !hgt) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  const now = last.ts, t0 = now - WINDOW_MS;
  const pts = monitorHistory.map((s) => [s.ts, m.get(s)]).filter(([, v]) => v != null);
  // grid
  g.strokeStyle = 'rgba(42,54,84,0.9)'; g.lineWidth = 1;
  for (const f of [0.5]) { g.beginPath(); g.moveTo(0, Math.round(hgt * f) + 0.5); g.lineTo(w, Math.round(hgt * f) + 0.5); g.stroke(); }
  if (!pts.length) return;
  const lo = m.min ?? 0;
  let hi = m.max ? m.max(last) : null;
  if (hi == null) hi = Math.max(...pts.map((p) => p[1])) * 1.15 || 1;
  const X = (ts) => ((ts - t0) / WINDOW_MS) * w;
  const Y = (v) => hgt - 2 - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo || 1)) * (hgt - 4);
  const color = css(m.color) || '#5CC8FF';
  g.beginPath();
  pts.forEach(([ts, v], i) => { const x = X(ts), y = Y(v); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  g.strokeStyle = color; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
  // area
  g.lineTo(X(pts[pts.length - 1][0]), hgt); g.lineTo(X(pts[0][0]), hgt); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, hgt);
  grad.addColorStop(0, hexA(color, 0.22)); grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad; g.fill();
  // last point
  const [lx, lv] = pts[pts.length - 1];
  g.beginPath(); g.arc(X(lx), Y(lv), 2.5, 0, Math.PI * 2); g.fillStyle = color; g.fill();
}
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return `rgba(92,200,255,${a})`;
  const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
