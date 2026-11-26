// 7. Environment doctor — checks with status, Fix for auto items, copyable instructions for the rest.
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, empty, loading, errorBox, notReady, toast, toastError, confirmSheet, tag, dot, fmtTime, copyText, toggle, sheet } from '../ui.js';
import { icon } from '../icons.js';
import { currentProject } from '../store.js';

let lastReport = null;
const opts = { gpuTests: false };

export default {
  id: 'doctor', title: '環境', icon: 'doctor',
  async render(ctx) {
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['doctor_run', 'doctor_fix']))); return; }
    const p = currentProject();
    const body = h('div.col');
    const runBtn = btn(t('重新檢查'), { kind: 'primary', icon: 'refresh', onClick: () => run() });
    const gpuToggle = toggle(t('包含 GPU 測試（硬體編碼器試編碼）'), opts.gpuTests, (v) => { opts.gpuTests = v; }, { title: t('只有 GPU 空閒時才會執行，否則標示為略過') });
    ctx.toolbar(t('環境檢查'), p ? p.name : t('未選擇專案（只檢查系統項目）'), [gpuToggle, runBtn]);
    mount(ctx.content, h('div.page', body));

    const run = async () => {
      runBtn.disabled = true; mount(body, loading(8));
      try { lastReport = await call('doctor_run', { projectId: p ? p.id : undefined, gpuTests: opts.gpuTests }); if (ctx.alive()) paint(); }
      catch (e) { if (ctx.alive()) mount(body, errorBox(e, run)); }
      finally { runBtn.disabled = false; }
    };

    const paint = () => {
      const r = lastReport;
      const checks = r.checks || [];
      const count = (s) => checks.filter((c) => c.status === s).length;
      const autos = checks.filter((c) => c.fix && c.fix.kind === 'auto' && c.status !== 'ok');
      ctx.subtitle(t('上次檢查 {x}', { x: fmtTime(r.ts) }));
      mount(body,
        h('div.grid4',
          sum(t('正常'), count('ok'), 'ok'), sum(t('警告'), count('warn'), 'warn'), sum(t('錯誤'), count('error'), 'fail'), sum(t('略過'), count('skipped'), 'idle')),
        autos.length ? h('div.banner.info', icon('wrench'), h('div.grow', t('{n} 個項目可以自動修復。', { n: autos.length })),
          btn(t('修復全部可修項目'), { small: true, kind: 'primary', onClick: () => fixAll(autos) })) : null,
        h('div.panel', h('div.list', checks.slice().sort((a, b) => order(a.status) - order(b.status)).map((c) => checkRow(c)))));
    };

    const checkRow = (c) => {
      const f = c.fix;
      const actions = h('div.row.gap2');
      if (f && f.kind === 'auto' && c.status !== 'ok') actions.appendChild(btn(f.label || t('修復'), { small: true, kind: 'primary', icon: 'wrench', disabled: !p, why: t('需要先選擇專案'), onClick: (e) => fix(c, e.currentTarget) }));
      if (f && f.kind === 'instructions' && (c.status === 'ok' || !f.instructions)) actions.appendChild(btn(f.label || t('說明'), { small: true, icon: 'info', onClick: async () => {
        if (f.instructions) return showInstructions(c, f.instructions);
        try { handleFix(c, await call('doctor_fix', { projectId: p ? p.id : '', fixId: f.id })); } catch (e) { toastError(e, c.label); }
      } }));
      return h('div.check-row',
        h('span', { class: `dot ${c.status === 'error' ? 'fail' : c.status === 'skipped' ? 'idle' : c.status}` }),
        h('div', { style: { minWidth: 0 } },
          h('div.row.gap2', h('span.name', c.label || c.id), c.value ? h('span.mono.caption.muted.ellipsis', c.value) : null, statusTag(c.status)),
          c.detail ? h('div.detail.selectable', c.detail) : null,
          f && f.kind === 'instructions' && f.instructions && c.status !== 'ok'
            ? h('div.fixhint', h('pre.code', { style: { maxHeight: '140px', margin: '0' } }, f.instructions), h('div.row', { style: { marginTop: '4px' } }, btn(t('複製說明'), { small: true, kind: 'plain', icon: 'copy', onClick: () => copyText(f.instructions, c.label) })))
            : null,
          h('div.caption.mono.muted', { style: { marginTop: '2px' } }, c.id)),
        actions);
    };

    const fix = async (c, b) => {
      const ok = await confirmSheet({ title: t('修復：{x}', { x: c.label }), text: t('Studio 會執行「{f}」。需要下載或安裝的項目會以佇列工作執行，可在「佇列」頁查看 log。', { f: c.fix.label || c.fix.id }), detail: c.detail || null, confirmLabel: t('執行修復') });
      if (!ok) return;
      if (b) b.disabled = true;
      try { handleFix(c, await call('doctor_fix', { projectId: p.id, fixId: c.fix.id })); }
      catch (e) { toastError(e, t('修復')); }
      finally { if (b) b.disabled = false; }
    };
    const handleFix = (c, r) => {
      if (!r) return;
      if (r.kind === 'job') toast(t('已加入佇列：{x}', { x: r.job.label || r.job.kind }), 'ok', [{ label: t('查看'), onClick: () => { sessionStorage.setItem('queue.select', r.job.id); ctx.go('queue'); } }]);
      else if (r.kind === 'done') { toast(r.message || t('完成'), 'ok'); run(); }
      else if (r.kind === 'instructions') showInstructions(c, r.text);
    };
    const fixAll = async (autos) => {
      const ok = await confirmSheet({ title: t('修復全部可修項目？'), text: t('會依序執行以下修復：'), detail: autos.map((c) => `• ${c.label} → ${c.fix.label || c.fix.id}`).join('\n'), confirmLabel: t('全部修復') });
      if (!ok || !p) return;
      for (const c of autos) { try { handleFix(c, await call('doctor_fix', { projectId: p.id, fixId: c.fix.id })); } catch (e) { toastError(e, c.label); } }
    };

    if (lastReport) paint(); else run();
  },
};

function showInstructions(c, text) {
  sheet({ title: c.label || c.id, wide: true,
    body: [c.detail ? h('div.muted', c.detail) : null, h('pre.code', { style: { maxHeight: '50vh' } }, text || t('（沒有說明）'))],
    actions: [{ label: t('關閉') }, { label: t('複製'), kind: 'primary', onClick: () => { copyText(text || '', c.label); return false; } }] });
}
function sum(k, n, s) { return h('div.panel.stat', h('div.row.gap2', h('span', { class: `dot ${s}` }), h('span.k', k)), h('div.v', String(n))); }
function order(s) { return { error: 0, warn: 1, skipped: 2, ok: 3 }[s] ?? 4; }
function statusTag(s) { return tag({ ok: t('正常'), warn: t('警告'), error: t('錯誤'), skipped: t('略過') }[s] || s, { ok: 'ok', warn: 'warn', error: 'fail' }[s] || ''); }
