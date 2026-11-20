// 9. Rollback — recent commits / checkpoints; revert (keeps history), branch, hard reset (typed confirmation).
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, empty, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, sheet, tag, fmtTime, fmtAgo, copyText, field } from '../ui.js';
import { icon } from '../icons.js';
import { currentProject } from '../store.js';

export default {
  id: 'rollback', title: '回滾', icon: 'history',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['git_log', 'git_revert', 'git_status']))); return; }
    if (!p) { mount(ctx.content, h('div.page', needProject())); return; }
    ctx.toolbar(t('回滾'), p.name, [btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => ctx.rerender() })]);
    const statusBox = h('div'); const listBox = h('div.panel');
    mount(ctx.content, h('div.page',
      h('div.banner.info', icon('info'), h('div.grow', t('「還原」會用 git revert 新增一個反向 commit，保留完整歷史，是預設也最安全的方式。「重設」會改寫目前分支，執行前會自動建立備份分支。'))),
      statusBox,
      h('section.section', h('div.section-head', h('h2.title2', t('最近的 commit 與檢查點'))), listBox)));
    mount(listBox, loading(6));

    let log, status;
    try { [log, status] = await Promise.all([call('git_log', { projectId: p.id, limit: 60 }), call('git_status', { projectId: p.id })]); }
    catch (e) { if (ctx.alive()) mount(listBox, errorBox(e, () => ctx.rerender())); return; }
    if (!ctx.alive()) return;

    if (!status.isRepo) { mount(listBox, empty(t('不是 git repo'), t('這個專案資料夾沒有 git，無法回滾。'), 'history')); return; }
    const dirty = status.dirty || [];
    mount(statusBox, h('div.panel', h('div.row.wrap', { style: { padding: '12px 16px', gap: '24px' } },
      h('span.callout', t('分支 {b}', { b: '' }), h('span.mono', status.branch || '—')),
      h('span.callout', 'HEAD ', h('span.mono', (status.head || '').slice(0, 7)), ' ', status.headSubject || ''),
      dirty.length ? h('span.callout.warn-text', t('工作目錄有 {n} 個未提交的修改', { n: dirty.length })) : h('span.callout.ok-text', t('工作目錄乾淨')))));

    if (!log.length) { mount(listBox, empty(t('沒有 commit'), '', 'history')); return; }
    mount(listBox, h('div.list', log.map((c, i) => {
      const cp = /^(studio:|checkpoint)/i.test(c.subject || '');
      return h('div.list-row',
        h('span.mono.caption', { style: { width: '64px', color: i === 0 ? 'var(--accent)' : 'var(--text-secondary)' } }, c.short || c.hash.slice(0, 7)),
        h('div.main-text', h('div.t', { title: c.subject }, c.subject), h('div.d', `${c.author} · ${fmtTime(c.date)} · ${fmtAgo(c.date)}`)),
        i === 0 ? tag('HEAD', 'info') : null, cp ? tag(t('檢查點'), 'ok') : null,
        btn('', { small: true, icon: 'copy', aria: t('複製 hash'), onClick: () => copyText(c.hash, c.short) }),
        btn(t('從這裡建分支'), { small: true, onClick: () => branchFrom(p, c) }),
        btn(t('還原'), { small: true, icon: 'revert', onClick: () => revert(ctx, p, c, dirty) }),
        i > 0 ? btn(t('重設到這裡'), { small: true, kind: 'destructive', onClick: () => resetHard(ctx, p, c, log.slice(0, i), dirty) }) : null);
    })));
  },
};

async function revert(ctx, p, c, dirty) {
  const ok = await confirmSheet({
    title: t('還原這個 commit？'),
    text: t('會執行 git revert --no-edit {h}，新增一個撤銷「{s}」的 commit。歷史會完整保留，之後也可以再還原回來。', { h: c.short, s: c.subject }),
    detail: dirty.length ? `${t('注意：工作目錄有未提交的修改，git 可能拒絕還原：')}\n${dirty.slice(0, 20).map((d) => `${d.code} ${d.path}`).join('\n')}` : null,
    confirmLabel: t('還原'),
  });
  if (!ok) return;
  try {
    const r = await call('git_revert', { projectId: p.id, commit: c.hash });
    if (r.ok) toast(t('已還原 {h}', { h: c.short }), 'ok'); else showOutput(t('還原失敗'), r.output);
    ctx.rerender();
  } catch (e) { toastError(e, t('還原')); }
}

async function branchFrom(p, c) {
  const input = h('input.input.mono', { value: `studio/from-${c.short}`, 'aria-label': t('分支名稱'), spellcheck: 'false' });
  sheet({ title: t('從 {h} 建立分支', { h: c.short }), body: [h('div.muted', t('只建立分支，不會切換（不 checkout），目前的工作不受影響。')), field(t('分支名稱'), input)],
    actions: [{ label: t('取消') }, { label: t('建立'), kind: 'primary', onClick: async () => {
      const name = input.value.trim(); if (!name) return false;
      try { const r = await call('git_branch_from', { projectId: p.id, commit: c.hash, branch: name }); if (r.ok) toast(t('已建立分支 {b}', { b: name }), 'ok'); else showOutput(t('建立分支失敗'), r.output); }
      catch (e) { toastError(e, t('建立分支')); return false; }
    } }] });
}

async function resetHard(ctx, p, c, lost, dirty) {
  const phrase = `RESET ${c.hash.slice(0, 7)}`;
  const input = h('input.input.mono', { placeholder: phrase, 'aria-label': t('確認文字'), spellcheck: 'false', autocomplete: 'off' });
  const s = sheet({
    title: t('重設到 {h}？', { h: c.short }),
    body: [
      h('div.banner.fail', icon('alert'), h('div.grow', t('git reset --hard 會丟棄之後的 {n} 個 commit 與所有未提交的修改。Studio 會先建立 studio/backup-<時間> 備份分支。', { n: lost.length }))),
      h('pre.code', { style: { maxHeight: '160px' } }, lost.map((x) => `${x.short}  ${x.subject}`).join('\n') + (dirty.length ? `\n\n${t('未提交的修改（會遺失）：')}\n${dirty.slice(0, 30).map((d) => `${d.code} ${d.path}`).join('\n')}` : '')),
      field(t('輸入 {p} 以確認', { p: phrase }), input),
    ],
    actions: [{ label: t('取消') }, { label: t('重設'), kind: 'destructive solid', onClick: async () => {
      if (input.value.trim() !== phrase) { input.classList.add('invalid'); input.focus(); return false; }
      try {
        const r = await call('git_reset_hard', { projectId: p.id, commit: c.hash, confirm: input.value.trim() });
        if (r.ok) toast(t('已重設到 {h}', { h: c.short }), 'ok'); else showOutput(t('重設失敗'), r.output);
        ctx.rerender();
      } catch (e) { toastError(e, t('重設')); return false; }
    } }],
  });
  setTimeout(() => input.focus(), 30);
}

function showOutput(title, out) {
  sheet({ title, wide: true, body: h('pre.code', { style: { maxHeight: '50vh' } }, out || ''), actions: [{ label: t('關閉'), kind: 'primary' }] });
}
