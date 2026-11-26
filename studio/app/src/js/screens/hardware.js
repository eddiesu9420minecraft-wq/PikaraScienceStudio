// 設定 › 硬體與效能 — GPUs detected with native APIs (DXGI / D3D12 / CUDA), the current device assignment per role
// with reasons, and manual overrides. Every option is generated from the detected hardware (no non-existent devices).
import { t } from '../i18n.js';
import { h, mount, btn, toast, toastError, loading, errorBox, notReady, tag, busy } from '../ui.js';
import { icon } from '../icons.js';
import { call, hasTauri } from '../api.js';
import { store } from '../store.js';
import { pageHead, card } from '../v03/common.js';

const KIND = { integrated: '內顯', discrete: '獨顯', external: '外接', software: '軟體' };
const ROLE = { ui: '介面（WebView2）', render: '影片渲染（Remotion / Three.js）', ai: 'AI 推理（CosyVoice / Whisper）' };

export default {
  id: 'hardware', title: '硬體與效能', icon: 'cpu',
  async render(ctx) {
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['hw_info'])));
    mount(ctx.content, h('div.page.narrow', loading(6)));
    const load = async (redetect = false) => {
      let info, s;
      try {
        [info, s] = await Promise.all([call('hw_info', { projectId: store.projectId, redetect }), call('settings_get')]);
      } catch (e) { return mount(ctx.content, h('div.page', errorBox(e, () => load()))); }
      if (ctx.alive()) paint(info, s);
    };
    const save = async (hw, note) => {
      try { await call('settings_set', { settings: { hw } }); toast(note || t('已儲存。新的工作會使用這個設定。'), 'ok'); load(); }
      catch (e) { toastError(e, t('硬體設定')); }
    };
    function paint(info, s) {
      const snap = info.snapshot;
      const a = info.assignment;
      const prefs = { ...info.prefs };
      const sel = (key, opts, note) => {
        const el = h('select.select', { 'aria-label': key }, opts.map((o) => h('option', { value: o.value, selected: o.value === prefs[key] ? true : null }, t(o.label))));
        el.addEventListener('change', () => { prefs[key] = el.value; save(prefs, note); });
        return el;
      };
      const pct = h('input', { type: 'range', min: '30', max: '100', step: '5', value: String(prefs.gpuMemLimitPct || 85), 'aria-label': t('GPU 記憶體使用上限') });
      const pctVal = h('span.val', `${prefs.gpuMemLimitPct || 85}%`);
      pct.addEventListener('input', () => { pctVal.textContent = `${pct.value}%`; });
      pct.addEventListener('change', () => { prefs.gpuMemLimitPct = Number(pct.value); save(prefs); });
      const row = (k, d, control) => h('div.setting', h('div', h('div.k', k), d ? h('div.d', d) : null), h('div.control', control));
      const choice = (c) => h('div', h('b', c.gpuName || (c.target === 'cpu' ? t('CPU') : t('軟體繪製'))),
        h('div.caption.muted', t(c.reason)), c.fallback ? h('div.caption.warn-text', t(c.fallback)) : null);
      const redetect = btn(t('重新偵測硬體'), { icon: 'refresh', onClick: (e) => busy(e.currentTarget, () => load(true)) });
      const reset = btn(t('恢復預設設定'), { onClick: () => save({ uiGpu: 'auto', renderGpu: 'auto', aiDevice: 'auto', encoder: 'auto', gpuMemLimitPct: 85 }, t('已恢復自動偵測的預設分配')) });
      ctx.toolbar(t('設定'), t('硬體與效能'), [redetect, reset]);
      mount(ctx.content, h('div.page.narrow',
        pageHead(t('硬體與效能'), t('以 Windows 原生 API（DXGI／Direct3D 12／CUDA 驅動）偵測；不讀取 GPU 名稱猜測類型，也不修改任何系統設定。')),
        snap.error ? h('div.banner.warn', icon('alert'), h('div.grow', t('硬體偵測失敗，已改用安全模式：{x}', { x: snap.error }))) : null,
        card(t('目前分配'), h('div',
          ['ui', 'render', 'ai'].map((r) => row(t(ROLE[r]), null, choice(a[r]))),
          row(t('硬體編碼器'), null, h('div', h('b', a.encoder.encoder === 'auto' ? t('自動') + (a.encoder.preferred ? `（${a.encoder.preferred}）` : '') : a.encoder.encoder),
            h('div.caption.muted', t(a.encoder.reason || '')), a.encoder.fallback ? h('div.caption.warn-text', t(a.encoder.fallback)) : null)),
          row(t('渲染 GPU 記憶體上限'), null, h('b', a.renderVramCapMib ? `${a.renderVramCapMib} MiB（${a.memLimitPct}%）` : t('不限制')))),
        { actions: [btn(t('查看實際使用的 GPU'), { small: true, kind: 'plain', onClick: () => ctx.go('diagnostics/gpu') })] }),
        card(t('手動選擇'), h('div',
          row(t('介面 GPU'), t('改變後需重新啟動 Studio 才會生效（WebView2 在啟動時選定 GPU）'), sel('uiGpu', info.options.ui, t('已儲存。重新啟動 Studio 後介面會改用這張 GPU。'))),
          row(t('影片渲染 GPU'), null, sel('renderGpu', info.options.render)),
          row(t('AI 推理裝置'), t('只列出偵測到 CUDA 的 GPU'), sel('aiDevice', info.options.ai)),
          row(t('硬體編碼器'), t('實測失敗的編碼器不會出現'), sel('encoder', info.options.encoder)),
          row(t('GPU 資源使用上限'), t('渲染時最多使用渲染 GPU 專用記憶體的百分比'), h('div.slider', pct, pctVal)))),
        card(t('偵測到的 GPU'), h('div.col', { style: { gap: '14px' } },
          snap.gpus.map((g) => h('div.col', { style: { gap: '4px' } },
            h('div.row.wrap', h('b', g.name), tag(t(KIND[g.kind] || g.kind), g.kind === 'discrete' || g.kind === 'external' ? 'info' : ''), g.available ? null : tag(t('不可用'), 'fail'),
              g.cudaIndex != null ? tag(`CUDA ${g.cudaIndex} · ${g.cudaCompute}`, 'ok') : null, g.encoderFamily ? tag(g.encoderFamily.toUpperCase()) : null),
            h('div.caption.muted', [`${g.vendor} ${g.vendorId}:${g.deviceId}`, t('專用 {n} MiB', { n: g.dedicatedVramMib }), t('共享 {n} MiB', { n: g.sharedSystemMib }),
              g.driverVersion ? t('驅動 {v}', { v: g.driverVersion }) : null, g.d3d12 ? `Direct3D 12 (${g.d3d12})` : t('Direct3D 12 不可用'), `LUID ${g.luid}`].filter(Boolean).join(' · ')),
            h('div.caption.muted', t('類型判斷：{x}', { x: t(g.kindSource) })))),
          snap.disabled.map((d) => h('div.banner.warn', icon('alert'), h('div.grow', `${d.name}：${t(d.status)}`))),
          h('div.caption.muted', `${t('CUDA')}：${snap.cuda.available ? t('驅動 {v}，{n} 個裝置', { v: snap.cuda.driverVersion, n: snap.cuda.devices.length }) : t(snap.cuda.error || '不可用')}`),
          h('div.caption.muted', t('偵測時間 {x}（{s}）', { x: snap.detectedAt, s: snap.source })))),
      ));
    }
    await load();
  },
};
