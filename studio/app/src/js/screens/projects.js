// 1. Projects — register project folder, summary, outputs list.
import { t } from '../i18n.js';
import { call, hasTauri, NotReady } from '../api.js';
import { h, mount, btn, empty, loading, errorBox, notReady, sheet, field, toast, toastError, confirmSheet, fmtBytes, fmtTime, fmtAgo, tag, openPath } from '../ui.js';
import { store, refreshProjects, setProject, currentProject } from '../store.js';

export default {
  id: 'projects', title: '專案', icon: 'folder',
  async render(ctx) {
    const root = h('div.page');
    mount(ctx.content, root);
    const addBtn = btn(t('註冊專案資料夾'), { kind: 'primary', icon: 'plus', onClick: () => registerSheet(ctx) });
    const refresh = btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => ctx.rerender() });
    ctx.toolbar(t('專案'), '', [refresh, addBtn]);

    if (!hasTauri) { mount(root, notReady('project_list', t('目前不是在 Studio 應用程式內執行。'))); return; }

    const listBox = h('div.panel');
    const detail = h('div.col', { style: { gap: '24px' } });
    mount(root, h('section.section', h('div.section-head', h('h2.title2', t('已註冊的專案'))), listBox), detail);
    mount(listBox, loading(2));
    try {
      await refreshProjects();
    } catch (e) { mount(listBox, errorBox(e, () => ctx.rerender())); return; }
    if (!ctx.alive()) return;
    const list = store.projects;
    if (!list.length) {
      mount(listBox, empty(t('還沒有專案'), t('註冊一個含有 narration.json 的 Pikara 專案資料夾（git repo）。'), 'folder', btn(t('註冊專案資料夾'), { kind: 'primary', onClick: () => registerSheet(ctx) })));
      return;
    }
    const rows = h('div.list', { role: 'listbox', 'aria-label': t('專案') });
    for (const p of list) {
      const sel = p.id === store.projectId;
      const row = h('div.list-row.clickable', { role: 'option', tabindex: '0', 'aria-selected': String(sel) },
        h('span', { class: `dot ${sel ? 'ok' : 'idle'}` }),
        h('div.main-text', h('div.t', p.name), h('div.d.mono', { title: p.rootPath }, p.rootPath)),
        h('div.caption.muted.nowrap', p.openedAt ? t('開啟於 {x}', { x: fmtAgo(p.openedAt) }) : ''),
        sel ? tag(t('目前專案'), 'ok') : btn(t('選擇'), { small: true, onClick: (e) => { e.stopPropagation(); choose(p); } }),
        btn('', { small: true, icon: 'trash', aria: t('從清單移除'), onClick: (e) => { e.stopPropagation(); removeProject(ctx, p); } }));
      const choose = async (pp) => {
        try { await call('project_register', { path: pp.rootPath }); } catch (e) { /* still allow local select */ }
        setProject(pp.id); ctx.rerender();
      };
      row.addEventListener('click', () => { if (!sel) choose(p); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!sel) choose(p); } });
      rows.appendChild(row);
    }
    mount(listBox, rows);

    const p = currentProject();
    if (p) renderDetail(ctx, detail, p);
  },
};

async function renderDetail(ctx, box, p) {
  mount(box, loading(4));
  let info;
  try { info = await call('project_info', { projectId: p.id }); }
  catch (e) { mount(box, errorBox(e, () => renderDetail(ctx, box, p))); return; }
  if (!ctx.alive()) return;
  ctx.subtitle(p.rootPath);

  const g = info.git || {};
  const totalLines = (info.episodes || []).reduce((a, e) => a + (e.lines || 0), 0);
  const stats = h('div.grid4',
    stat(t('集數／版本'), (info.episodes || []).length),
    stat(t('句數（全部）'), totalLines),
    stat(t('輸出檔案'), (info.outputs || []).length),
    stat(t('未提交的修改'), g.isRepo ? (g.dirty || []).length : '—'));

  const epTable = (info.episodes || []).length
    ? h('div.panel.table-wrap', h('table.table',
      h('thead', h('tr', h('th', t('語系')), h('th', t('序列')), h('th', t('標題')), h('th', t('配音引擎')), h('th.num', t('幕')), h('th.num', t('句')))),
      h('tbody', info.episodes.map((e) => h('tr',
        h('td', tag(e.locale, e.locale === 'zh-TW' ? 'info' : 'warn')),
        h('td.mono', e.seqKey), h('td', e.title || '—'),
        h('td', e.voiceEngine || h('span.muted', t('未指定（edge）'))),
        h('td.num', e.scenes), h('td.num', e.lines))))))
    : h('div.panel', empty(t('找不到 narration.json'), t('這個資料夾裡沒有 src/data/narration.json 或 src_cn/data/narration.json。'), 'script'));

  const gitBox = h('div.panel.panel-body', g.isRepo
    ? h('dl.kv',
      h('dt', t('分支')), h('dd.mono', g.branch || '—'),
      h('dt', 'HEAD'), h('dd', h('span.mono', g.head ? g.head.slice(0, 7) : '—'), ' ', g.headSubject || ''),
      h('dt', t('工作目錄')), h('dd', (g.dirty || []).length
        ? h('div.col', { style: { gap: '2px' } }, h('span.warn-text', t('{n} 個檔案有修改', { n: g.dirty.length })),
          h('div.mono.muted', { style: { maxHeight: '120px', overflow: 'auto', fontSize: '12px' } }, g.dirty.slice(0, 40).map((d) => h('div.ellipsis', `${d.code} ${d.path}`))))
        : h('span.ok-text', t('乾淨（沒有未提交的修改）'))))
    : h('div.muted', t('這個資料夾不是 git repo；儲存與回滾功能需要 git。')));

  const outs = (info.outputs || []).slice().sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  const outBox = h('div.panel', outs.length ? h('div.list', outs.map((o) => h('div.list-row',
    tag(o.ext.toUpperCase(), o.ext === 'mp4' ? 'info' : o.ext === 'srt' ? '' : 'warn'),
    h('div.main-text', h('div.t', o.name), h('div.d.mono', { title: o.path }, o.path)),
    h('div.caption.muted.num.nowrap', fmtBytes(o.size)),
    h('div.caption.muted.num.nowrap', { style: { width: '120px', textAlign: 'right' } }, fmtTime(o.mtime)),
    o.ext === 'mp4' ? btn(t('預覽'), { small: true, icon: 'play', onClick: () => { sessionStorage.setItem('publish.select', o.path); ctx.go('publish'); } }) : null,
    btn(t('在資料夾中顯示'), { small: true, icon: 'folder', onClick: () => call('open_path', { projectId: p.id, path: o.path, reveal: true }).catch((e) => toastError(e, t('開啟資料夾'))) }))))
    : empty(t('還沒有輸出'), t('專案根目錄與 out/ 裡沒有 mp4／srt／png。'), 'film'));

  mount(box,
    h('section.section', h('div.section-head', h('h2.title2', p.name), h('span.mono.muted.caption.ellipsis', p.rootPath),
      btn(t('開啟資料夾'), { small: true, icon: 'folder', onClick: () => call('open_path', { projectId: p.id, path: p.rootPath }).catch((e) => toastError(e, t('開啟資料夾'))) })), stats),
    h('section.section', h('div.section-head', h('h2.title2', t('腳本版本'))), epTable),
    h('div.grid2', { style: { alignItems: 'start' } },
      h('section.section', h('div.section-head', h('h2.title2', 'Git')), gitBox),
      h('section.section', h('div.section-head', h('h2.title2', t('快速動作'))), h('div.panel.panel-body.col',
        h('div.row.wrap', btn(t('編輯腳本'), { icon: 'script', onClick: () => ctx.go('script') }), btn(t('一鍵製作'), { icon: 'film', onClick: () => ctx.go('production') }),
          btn(t('環境檢查'), { icon: 'doctor', onClick: () => ctx.go('doctor') }), btn(t('預覽與發佈'), { icon: 'publish', onClick: () => ctx.go('publish') }))))),
    h('section.section', h('div.section-head', h('h2.title2', t('輸出檔案')), h('span.caption.muted', t('依修改時間排序'))), outBox));
}

function stat(k, v) { return h('div.panel.stat', h('div.k', k), h('div.v', String(v))); }

function registerSheet(ctx) {
  const input = h('input.input.mono', { type: 'text', placeholder: 'D:\\MyVideoProject', 'aria-label': t('專案資料夾路徑'), spellcheck: 'false' });
  const err = h('div.fail-text.caption', { hidden: true, role: 'alert' });
  const s = sheet({
    title: t('註冊專案資料夾'),
    body: [h('div.muted', t('輸入專案根目錄的完整路徑（含 package.json 與 src/data/narration.json 的 git repo）。Studio 只會記錄路徑，不會移動或修改檔案。')),
      field(t('資料夾路徑'), input), err],
    actions: [{ label: t('取消') }, {
      label: t('註冊'), kind: 'primary', onClick: async () => {
        const path = input.value.trim();
        if (!path) { err.hidden = false; err.textContent = t('請輸入路徑'); input.focus(); return false; }
        try {
          const p = await call('project_register', { path });
          await refreshProjects(); setProject(p.id);
          toast(t('已註冊：{x}', { x: p.name }), 'ok');
          ctx.rerender();
        } catch (e) {
          if (e instanceof NotReady) { toastError(e); return true; }
          err.hidden = false; err.textContent = e.message; return false;
        }
      },
    }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') s.el.querySelector('.btn.primary').click(); });
}

async function removeProject(ctx, p) {
  const ok = await confirmSheet({ title: t('從清單移除專案？'), text: t('只會讓 Studio 忘記這個專案；資料夾與檔案都不會被刪除。'), detail: p.rootPath, confirmLabel: t('移除'), destructive: true });
  if (!ok) return;
  try { await call('project_remove', { projectId: p.id }); if (store.projectId === p.id) setProject(null); toast(t('已移除'), 'ok'); ctx.rerender(); }
  catch (e) { toastError(e); }
}
