// Dashboard — studio overview: current project, the episode you were working on (what needs updating), queue,
// GPU / backend health, recent jobs and quick actions. Read-only; every action goes to its section.
import { t } from '../i18n.js';
import { h, mount, btn, loading, errorBox, fmtTime, fmtAgo, dot, empty, notReady } from '../ui.js';
import { icon } from '../icons.js';
import { call, hasTauri } from '../api.js';
import { store, on, currentProject, monitorHistory } from '../store.js';
import { pageHead, card, episodes, resolveSel, statusPill } from '../v03/common.js';

export default {
  id: 'dashboard', title: '總覽', icon: 'grid',
  async render(ctx) {
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['project_list', 'queue_status'])));
    const p = currentProject();
    ctx.toolbar(t('總覽'), p ? p.name : '', [btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => ctx.rerender() })]);
    if (!p) {
      return mount(ctx.content, h('div.page', pageHead(t('歡迎使用 Pikara Studio'), t('先加入一個影片專案資料夾。')),
        empty(t('尚未選擇專案'), t('在「專案」頁加入或建立專案資料夾，Studio 會讀取裡面的每一集影片。'), 'folder', btn(t('前往專案'), { kind: 'primary', onClick: () => ctx.go('projects/folders') }))));
    }
    const metrics = h('div.dash-grid');
    const focus = h('div', loading(3));
    const jobsBox = h('div', loading(4));
    const health = h('div');
    mount(ctx.content, h('div.page',
      pageHead(p.name, t('影片專案總覽'), btn(t('新影片'), { kind: 'primary', icon: 'plus', onClick: () => ctx.go('projects/auto') })),
      metrics,
      h('div.dash-two', focus, h('div.col', jobsBox, health))));

    let eps = [];
    try { eps = await episodes(true); } catch (e) { mount(focus, errorBox(e, () => ctx.rerender())); }
    const q = store.queue || {};
    const s = monitorHistory[monitorHistory.length - 1];
    const tile = (k, v, d, unit) => h('div.card', h('div.metric', h('div.k', k), h('div.v', v, unit ? h('small', unit) : null), h('div.d', d || '')));
    mount(metrics,
      tile(t('影片'), String(eps.length), t('{n} 集已有成品', { n: eps.filter((e) => Object.values(e.present || {}).some(Boolean)).length })),
      tile(t('佇列'), String((q.running ? q.running.length : 0) + (q.queued || 0)), q.running && q.running.length ? t('執行中 {n}', { n: q.running.length }) : t('閒置')),
      tile(t('GPU 記憶體'), s && s.gpu && s.gpu.vramUsedMiB != null ? String(s.gpu.vramUsedMiB) : '—', s && s.gpu && s.gpu.tempC != null ? t('{n}°C', { n: s.gpu.tempC }) : t('等待取樣'), 'MiB'),
      tile(t('後端'), s ? t('正常') : t('等待'), s ? t('{x} 更新', { x: fmtAgo(s.ts) }) : ''));

    // the episode you were working on
    const cur = resolveSel(eps);
    if (!cur) mount(focus, card(t('繼續工作'), empty(t('這個專案還沒有影片'), t('用「新影片」從主題開始。'), 'film')));
    else {
      try {
        const ws = await call('workspace_get', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale });
        if (!ctx.alive()) return;
        const dirty = ws.stages.filter((x) => ['stale', 'missing'].includes(x.status) && ['voice', 'timeline', 'mix', 'video'].includes(x.id));
        mount(focus, card(t('繼續工作：{e} {t}', { e: cur.episode.toUpperCase(), t: ws.title || '' }), h('div.col',
          h('div.chip-row', ws.stages.map((x) => h('span.row.gap2', { style: { gap: '6px' } }, h('span.caption', t(x.title)), statusPill(x.status)))),
          dirty.length ? h('div.banner.warn', icon('alert'), h('div.grow', t('需要更新：{x}', { x: dirty.map((d) => t(d.title)).join('、') }))) : h('div.banner.info', icon('check'), h('div.grow', t('這一集的成品與腳本、配音一致。'))),
          h('div.row.gap2', btn(t('開啟編輯器'), { kind: 'primary', icon: 'pen', onClick: () => ctx.go('editor/workspace') }), btn(t('語音工作室'), { icon: 'mic', onClick: () => ctx.go('voice') }))),
          { actions: [h('span.caption.muted', cur.locale)] }));
      } catch (e) { mount(focus, errorBox(e, () => ctx.rerender())); }
    }

    // recent jobs
    try {
      const jobs = await call('job_list', { projectId: ctx.projectId, limit: 8 });
      mount(jobsBox, card(t('最近的工作'), jobs.length ? h('div.col', { style: { gap: '8px' } }, jobs.map((j) => h('div.row', dot(j.status), h('div.grow.ellipsis', { title: j.label }, j.label), h('span.caption.muted.nowrap', fmtTime(j.finishedAt || j.createdAt))))) : h('div.caption.muted', t('還沒有工作')),
        { actions: [btn(t('佇列'), { small: true, onClick: () => ctx.go('queue') })] }));
    } catch (e) { mount(jobsBox, errorBox(e)); }

    const paintHealth = () => {
      const last = monitorHistory[monitorHistory.length - 1];
      const th = (last && last.threads) || {};
      const names = Object.keys(th);
      mount(health, card(t('背景程序'), names.length ? h('div.col', { style: { gap: '6px' } }, names.map((n) => h('div.row', dot(th[n].stalled ? 'fail' : 'ok'), h('span.grow', n), h('span.caption.muted', th[n].stalled ? t('停滯 {n} 秒', { n: th[n].ageSec }) : t('正常'))))) : h('div.caption.muted', t('等待第一次取樣…')),
        { actions: [btn(t('診斷'), { small: true, onClick: () => ctx.go('diagnostics') })] }));
    };
    paintHealth();
    ctx.cleanup(on('monitor', () => paintHealth()));
  },
};
