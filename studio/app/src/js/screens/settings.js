// Settings — general settings for everyone; developer settings (paths, limits, AI budget) only after an explicit switch.
import { t, getLang, setLang } from '../i18n.js';
import { h, mount, btn, toast, toastError, loading, errorBox, seg, toggle, notReady } from '../ui.js';
import { icon } from '../icons.js';
import { call, hasTauri } from '../api.js';
import { store } from '../store.js';
import { pageHead, card } from '../v03/common.js';
import { getThemePref, setTheme } from '../v03/theme.js';

export default {
  id: 'settings', title: '設定', icon: 'gear',
  async render(ctx) {
    ctx.toolbar(t('設定'), '', []);
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['settings_get', 'settings_set'])));
    mount(ctx.content, h('div.page', loading(6)));
    let s;
    try { s = await call('settings_get'); } catch (e) { return mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); }
    const save = async (patch) => {
      try { s = await call('settings_set', { settings: patch }); toast(t('已儲存設定'), 'ok'); try { store.queue = await call('queue_status'); } catch {} }
      catch (e) { toastError(e, t('設定')); }
    };
    const row = (k, d, control) => h('div.setting', h('div', h('div.k', k), d ? h('div.d', d) : null), h('div.control', control));
    const input = (val, type, onSave, attrs = {}) => {
      const i = h('input.input', { type, value: val == null ? '' : String(val), ...attrs });
      i.addEventListener('change', () => onSave(type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value));
      return i;
    };
    const tempo = [0.9, 1.0, 1.1, 1.2].reduce((a, b) => (Math.abs(b - (s.voiceTempo || 1)) < Math.abs(a - (s.voiceTempo || 1)) ? b : a), 1.0);
    const winOn = { v: !!(s.windowStart && s.windowEnd) };
    const ws = input(s.windowStart, 'time', () => applyWin(), { 'aria-label': t('時段開始'), style: { width: '110px' } });
    const we = input(s.windowEnd, 'time', () => applyWin(), { 'aria-label': t('時段結束'), style: { width: '110px' } });
    ws.disabled = we.disabled = !winOn.v;
    const applyWin = () => save(winOn.v ? { windowStart: ws.value || null, windowEnd: we.value || null } : { windowStart: null, windowEnd: null });
    const general = card(t('一般'), h('div',
      row(t('外觀'), t('淺色、深色或跟隨 Windows'), seg([{ value: 'light', label: t('淺色') }, { value: 'dark', label: t('深色') }, { value: 'system', label: t('自動') }], getThemePref(), (v) => setTheme(v))),
      row(t('介面語言'), t('只影響 Studio 介面，與影片語言無關'), seg([{ value: 'zh-TW', label: '繁體中文' }, { value: 'zh-CN', label: '简体中文' }], getLang(), (v) => setLang(v))),
      row(t('旁白語速'), t('相對於該語言的正常語速；保留音高，不修改原始配音檔。下次建立時間軸時生效'),
        seg([0.9, 1.0, 1.1, 1.2].map((v) => ({ value: v, label: { 0.9: t('慢速 0.90×'), 1: t('正常 1.00×'), 1.1: t('稍快 1.10×'), 1.2: t('快速 1.20×') }[v] })), tempo, (v) => save({ voiceTempo: v }))),
      row(t('渲染效能'), t('起始值與上限；實際並行數依每段實測自動調整'),
        seg([{ value: 'eco', label: t('省電') }, { value: 'balanced', label: t('平衡') }, { value: 'performance', label: t('效能') }], s.perfMode || 'balanced',
          (v) => save({ perfMode: v, renderStartConcurrency: { eco: 1, balanced: 2, performance: 3 }[v] }))),
      row(t('自動執行佇列'), t('關閉後工作會留在佇列，不會開始'), toggle('', s.queueEnabled, (v) => save({ queueEnabled: v }))),
      row(t('執行時防止睡眠'), null, toggle('', s.keepAwake, (v) => save({ keepAwake: v }))),
      row(t('GPU 工作只在時段內執行'), t('例如夜間 01:00–07:00'), h('div.row.gap2', toggle('', winOn.v, (v) => { winOn.v = v; ws.disabled = we.disabled = !v; if (v && (!ws.value || !we.value)) return; applyWin(); }), ws, h('span.muted', '–'), we)),
    ));
    const advBox = h('div');
    const paintAdv = (on) => mount(advBox, on ? card(t('開發者設定'), h('div',
      h('div.adv-banner', icon('alert'), h('div.grow', t('這些設定影響資源上限與外部程式路徑。一般製作不需要修改；改錯可能讓工作無法開始。'))),
      row(t('GPU 判定為忙碌的 VRAM 用量'), t('其他程式使用超過此值時，GPU 工作先等待（MiB）'), input(s.gpuVramBusyMib, 'number', (v) => save({ gpuVramBusyMib: v }), { min: '500', step: '100' })),
      row(t('同時執行的 CPU 工作'), null, input(s.maxCpuJobs, 'number', (v) => save({ maxCpuJobs: v }), { min: '1', max: '8' })),
      row(t('渲染起始並行數'), t('0＝依效能模式'), input(s.renderStartConcurrency, 'number', (v) => save({ renderStartConcurrency: v }), { min: '0', max: '8' })),
      row(t('Node.js 資料夾'), null, input(s.nodeDir, 'text', (v) => save({ nodeDir: v }))),
      row(t('CosyVoice Python'), t('空白＝專案內 tools\\CosyVoice\\.venv'), input(s.cosyPython, 'text', (v) => save({ cosyPython: v || null }))),
      row(t('AI 工作最多回合數'), null, input(s.claudeMaxTurns, 'number', (v) => save({ claudeMaxTurns: v }), { min: '1', max: '200' })),
      row(t('AI 工作預算上限（美元）'), t('空白＝不設上限（訂閱模式不計費）'), input(s.claudeMaxBudgetUsd, 'number', (v) => save({ claudeMaxBudgetUsd: v }), { min: '0', step: '0.5' })),
    )) : null);
    const advOn = localStorage.getItem('ui.devSettings') === '1';
    mount(ctx.content, h('div.page.narrow',
      pageHead(t('設定'), t('一般設定會立即生效；開發者設定預設隱藏。')),
      general,
      card(t('進階'), toggle(t('顯示開發者設定'), advOn, (v) => { localStorage.setItem('ui.devSettings', v ? '1' : '0'); paintAdv(v); })),
      advBox));
    paintAdv(advOn);
  },
};
