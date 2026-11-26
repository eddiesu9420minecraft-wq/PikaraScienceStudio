// Voice Studio — every narration line with its kept versions and review candidates: listen, A/B compare,
// switch back to an older version, accept or reject a candidate, re-voice one / several / all lines.
import { t } from '../i18n.js';
import { h, mount, btn, toast, toastError, loading, errorBox, fmtTime, confirmSheet, notReady, needProject } from '../ui.js';
import { icon } from '../icons.js';
import { call, hasTauri } from '../api.js';
import { on } from '../store.js';
import { epPicker, episodes, resolveSel, select, needEpisode, statusPill, card, audioFor, pathLine, pageHead } from '../v03/common.js';
import { revoiceSheet } from './editor.js';

export default {
  id: 'voice', title: '語音工作室', icon: 'mic',
  async render(ctx) {
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['workspace_get', 'voice_versions'])));
    if (!ctx.projectId) return mount(ctx.content, h('div.page', needProject()));
    mount(ctx.content, h('div.page', loading(6)));
    let list;
    try { list = await episodes(true); } catch (e) { return mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); }
    const cur = resolveSel(list);
    if (!cur) return mount(ctx.content, needEpisode(ctx));
    select(cur.episode, cur.locale);
    const state = { ws: null, versions: [], sel: sessionStorage.getItem('voice.line'), picked: new Set() };
    const left = h('div.col');
    const right = h('div.col');
    ctx.toolbar(t('語音工作室'), `${cur.episode.toUpperCase()} · ${cur.locale}`, [
      btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => load() }),
      btn(t('整個語言版本重新配音'), { icon: 'mic', onClick: () => revoiceSheet(ctx, cur, state, []) }),
    ]);
    mount(ctx.content, h('div.page',
      pageHead(t('語音工作室'), t('試聽每一句的目前版本與保留的舊版本，A/B 比較後再決定；切換版本不會刪除任何音檔。'),
        epPicker(list, cur, (e, l) => { select(e, l); ctx.rerender(); })),
      h('div.dash-two', left, right)));

    async function load() {
      try {
        const [ws, versions] = await Promise.all([
          call('workspace_get', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale }),
          call('voice_versions', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale }),
        ]);
        state.ws = ws; state.versions = versions || [];
      } catch (e) { return mount(left, errorBox(e, load)); }
      if (!ctx.alive()) return;
      paintList();
      paintDetail();
    }
    function lines() { return (state.ws.stages.find((s) => s.id === 'voice') || {}).lines || []; }
    function paintList() {
      const ls = lines();
      if (!state.sel || !ls.find((l) => l.id === state.sel)) state.sel = ls[0] && ls[0].id;
      const batchBtn = btn(t('重新配音所選'), { small: true, icon: 'mic', disabled: !state.picked.size, onClick: () => revoiceSheet(ctx, cur, state, [...state.picked]) });
      const cand = state.versions.filter((v) => v.status === 'candidate');
      mount(left,
        cand.length ? h('div.banner.warn', icon('speaker'), h('div.grow', t('{n} 個候選版本沒有通過自動驗證，等待你試聽決定。', { n: cand.length }))) : null,
        card(t('句子'), h('div.lines', ls.map((l) => {
          const nv = state.versions.filter((v) => v.item === l.id).length;
          const cb = h('input', { type: 'checkbox', checked: state.picked.has(l.id), 'aria-label': t('選取 {x}', { x: l.id }) });
          cb.addEventListener('click', (e) => e.stopPropagation());
          cb.addEventListener('change', () => { if (cb.checked) state.picked.add(l.id); else state.picked.delete(l.id); paintList(); });
          return h('div.line', { 'aria-selected': String(l.id === state.sel), onclick: () => { state.sel = l.id; sessionStorage.setItem('voice.line', l.id); paintList(); paintDetail(); } },
            cb, h('div.lid', l.id), h('div.txt', l.subtitle), h('div.acts', l.state !== 'ok' ? statusPill(l.state === 'missing' ? 'missing' : 'stale') : null,
              state.versions.some((v) => v.item === l.id && v.status === 'candidate') ? h('span.tag.warn', t('候選')) : null, nv ? h('span.tag', `${nv} ${t('版')}`) : null));
        })), { flush: true, actions: [batchBtn] }));
    }
    async function paintDetail() {
      const l = lines().find((x) => x.id === state.sel);
      if (!l) return mount(right, h('div.caption.muted', t('選擇左側的句子')));
      const vs = state.versions.filter((v) => v.item === l.id);
      const a = await audioFor(l.path);
      const bSel = h('select.select', { 'aria-label': t('比較的版本') }, vs.length ? vs.map((v) => h('option', { value: String(v.version) }, `v${String(v.version).padStart(3, '0')} · ${t(v.status === 'candidate' ? '候選' : '保留')} · ${fmtTime(v.createdAt)}`)) : h('option', { value: '' }, t('沒有其他版本')));
      const bBox = h('div.col', { style: { gap: '6px' } });
      const paintB = async () => {
        const v = vs.find((x) => String(x.version) === bSel.value);
        if (!v) return mount(bBox, h('div.caption.muted', t('重新配音後，舊版本會出現在這裡。')));
        mount(bBox, await audioFor(v.path), h('div.caption', v.meta && v.meta.speak ? t('文字：{x}', { x: v.meta.speak }) : ''),
          v.meta && v.meta.error ? h('div.caption.warn-text', v.meta.error) : null,
          h('div.row.gap2', btn(v.status === 'candidate' ? t('採用這個候選版本') : t('切換為這個版本'), { small: true, kind: 'primary', onClick: () => restore(v) }),
            v.status === 'candidate' ? btn(t('不採用'), { small: true, onClick: () => reject(v) }) : null));
      };
      bSel.addEventListener('change', paintB);
      mount(right, card(`${l.id}`, h('div.col',
        h('div', l.subtitle), l.speak !== l.subtitle ? h('div.caption.muted', t('朗讀：{x}', { x: l.speak })) : null,
        h('div.ab',
          h('div.side', h('div.lbl', t('A · 目前版本')), l.state === 'missing' ? h('div.caption.muted', t('沒有音檔')) : a,
            h('div.caption.muted', [l.duration ? t('{n} 秒', { n: l.duration.toFixed(2) }) : null, l.cer != null ? t('辨識錯誤率 {x}', { x: l.cer.toFixed(2) }) : null].filter(Boolean).join('・'))),
          h('div.side', h('div.lbl', t('B · 其他版本')), bSel, bBox)),
        h('div.row.gap2', btn(t('重新配音這一句'), { icon: 'mic', onClick: () => revoiceSheet(ctx, cur, state, [l.id]) })),
        h('div.caption.muted', t('檔案位置')), pathLine(l.path))));
      paintB();
    }
    async function restore(v) {
      const ok = await confirmSheet({ title: t('切換版本'), text: t('把 {x} 的目前音訊換成 v{n}？目前的音訊會先保留成新的版本，可以再切回來。', { x: v.item, n: v.version }), confirmLabel: t('切換') });
      if (!ok) return;
      try { await call('voice_restore', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale, line: v.item, version: v.version }); toast(t('已切換。影片需要重新渲染才會用到新的聲音。'), 'ok'); load(); }
      catch (e) { toastError(e, t('切換版本')); }
    }
    async function reject(v) {
      try { await call('voice_reject', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale, line: v.item, version: v.version }); toast(t('已標記為不採用（檔案保留）'), 'ok'); load(); }
      catch (e) { toastError(e, t('不採用')); }
    }
    ctx.cleanup(on('job', (j) => { if (j && j.kind === 'revoice' && ['succeeded', 'failed'].includes(j.status)) load(); }));
    await load();
  },
};
