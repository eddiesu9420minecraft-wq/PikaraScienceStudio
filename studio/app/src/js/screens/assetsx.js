// Assets — every file that belongs to one episode, grouped by stage, as reported by the backend workspace
// (storyboard stills, research documents, narration audio folder, animation sources, mixes, outputs and kept versions).
import { t } from '../i18n.js';
import { h, mount, btn, loading, errorBox, fmtBytes, fmtTime, openPath, notReady, needProject } from '../ui.js';
import { call, hasTauri, fileSrc } from '../api.js';
import { store, ensureAssets } from '../store.js';
import { pageHead, card, epPicker, episodes, resolveSel, select, needEpisode, pathLine, statusPill } from '../v03/common.js';

export default {
  id: 'assets', title: '素材庫', icon: 'image',
  async render(ctx) {
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['workspace_get'])));
    if (!ctx.projectId) return mount(ctx.content, h('div.page', needProject()));
    mount(ctx.content, h('div.page', loading(5)));
    let list;
    try { list = await episodes(true); } catch (e) { return mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); }
    const cur = resolveSel(list);
    if (!cur) return mount(ctx.content, needEpisode(ctx));
    let ws;
    try { ws = await call('workspace_get', { projectId: ctx.projectId, episode: cur.episode, locale: cur.locale }); } catch (e) { return mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); }
    try { await ensureAssets(store.projectId); } catch {}
    ctx.toolbar(t('素材庫'), `${cur.episode.toUpperCase()} · ${cur.locale}`, [btn(t('開啟影片資料夾'), { icon: 'folder', onClick: () => openPath(ws.videoDir) })]);
    const groups = ws.stages.filter((s) => (s.files || []).length || s.id === 'voice');
    mount(ctx.content, h('div.page',
      pageHead(t('素材庫'), t('這一集用到的所有檔案（由 Studio 後端讀取，不是猜測的路徑）。'), epPicker(list, cur, (e, l) => { select(e, l); ctx.rerender(); })),
      groups.map((s) => card(t(s.title), s.id === 'storyboard' ? stills(s.files) : s.id === 'voice' ? voiceInfo(s) : fileList(s.files),
        { actions: [statusPill(s.status), btn('', { small: true, icon: 'folder', aria: t('開啟資料夾'), onClick: () => openPath(s.location) })] }))));
  },
};

function fileList(files) {
  return h('div.col', { style: { gap: '8px' } }, files.map((f) => h('div.row', { style: { alignItems: 'flex-start' } },
    h('div.grow', h('div.ellipsis', { title: f.name }, f.name), pathLine(f.path)),
    h('span.caption.muted.nowrap', f.exists ? `${fmtBytes(f.bytes)} · ${fmtTime(f.modifiedAt)}` : t('不存在')))));
}

function stills(files) {
  return h('div.automon-grid', files.map((f) => h('figure', h('img', { src: fileSrc(f.path), alt: f.name, loading: 'lazy' }), h('figcaption.caption.muted.ellipsis', f.name))));
}

function voiceInfo(s) {
  const n = (s.lines || []).length;
  return h('div.col', h('div', t('{n} 句旁白音檔', { n })), pathLine(s.location), h('div.caption.muted', t('逐句試聽與版本比較在「語音工作室」。')));
}
