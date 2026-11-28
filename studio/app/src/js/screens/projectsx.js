// Projects — the project's videos (open one in the Editor), publishing,
// project folders and the getting-started guide.
import { t } from '../i18n.js';
import { h, mount, btn, loading, errorBox, empty, notReady, needProject } from '../ui.js';
import { hasTauri } from '../api.js';
import { tabbed, episodes, select, card } from '../v03/common.js';
import publish from './publish.js';
import projects from './projects.js';
import guide from './guide.js';

export default {
  id: 'projects', title: '專案', icon: 'folder',
  async render(ctx) {
    await tabbed(ctx, t('專案'), [
      { id: 'videos', title: '影片', render: (el) => videosTab(el, ctx) },
      { id: 'publish', title: '預覽與發佈', screen: publish },
      { id: 'folders', title: '專案資料夾', screen: projects },
      { id: 'guide', title: '入門', screen: guide },
    ]);
  },
};

async function videosTab(el, ctx) {
  if (!hasTauri) return mount(el, h('div.page', notReady(['episode_list'])));
  if (!ctx.projectId) return mount(el, h('div.page', needProject()));
  mount(el, h('div.page', loading(5)));
  let list;
  try { list = await episodes(true); } catch (e) { return mount(el, h('div.page', errorBox(e, () => ctx.rerender()))); }
  ctx.toolbar(t('專案'), t('影片'), [btn(t('新影片'), { kind: 'primary', icon: 'plus', onClick: () => ctx.go('create') })]);
  if (!list.length) return mount(el, h('div.page', empty(t('這個專案還沒有影片'), t('用「新影片」從主題開始自動製作，或在「完整腳本」新增一集。'), 'film', btn(t('新影片'), { kind: 'primary', onClick: () => ctx.go('create') }))));
  const open = (id, loc) => { select(id, loc); ctx.go('editor/workspace'); };
  mount(el, h('div.page', { style: { paddingTop: '20px' } }, card(null, h('div', list.map((e) => {
    const locs = Object.entries(e.locales || {});
    const outs = Object.values(e.present || {}).filter(Boolean).length;
    return h('div.ep-row', { dataset: { episode: e.id } },
      h('span.num', e.id.toUpperCase()),
      h('div', { style: { minWidth: 0 } }, h('div.t', e.title || e.id), h('div.d', locs.map(([l, v]) => `${l} ${v.voiced}/${v.lines} ${t('句配音')}`).join('・'))),
      h('span', { class: `tag ${outs ? 'ok' : ''}` }, outs ? t('{n} 個成品', { n: outs }) : t('尚無成品')),
      h('div.row.gap2', locs.map(([l]) => btn(l === 'zh-TW' ? t('開啟 繁中') : t('開啟 简中'), { small: true, onClick: () => open(e.id, l) }))));
  })), { flush: true })));
}
