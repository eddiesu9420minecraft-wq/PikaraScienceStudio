// 3. Prompt studio — build prompts from real project data; optional Claude Code run in a worktree.
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, empty, loading, errorBox, notReady, needProject, toast, toastError, confirmSheet, field, tag, copyText, toggle, dot, fmtTime, progress } from '../ui.js';
import { icon } from '../icons.js';
import { currentProject, on } from '../store.js';

const memo = { task: null, options: {}, text: '', runJobId: null };

export default {
  id: 'prompt', title: '提示詞', icon: 'sparkle',
  async render(ctx) {
    const p = currentProject();
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['prompt_tasks', 'prompt_build', 'claude_detect']))); return; }
    if (!p) { mount(ctx.content, h('div.page', needProject())); return; }
    ctx.toolbar(t('提示詞工作室'), p.name, []);
    mount(ctx.content, h('div.page', loading(5)));

    let tasks, info, claude, failedJobs = [];
    try {
      [tasks, info] = await Promise.all([call('prompt_tasks'), call('project_info', { projectId: p.id })]);
    } catch (e) { if (ctx.alive()) mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); return; }
    try { claude = await call('claude_detect'); } catch (e) { claude = { error: e }; }
    try { failedJobs = (await call('job_list', { projectId: p.id, limit: 100 })).filter((j) => ['failed', 'interrupted', 'canceled'].includes(j.status)); } catch {}
    if (!ctx.alive()) return;
    new PromptStudio(ctx, p, tasks, info, claude, failedJobs).mount();
  },
};

class PromptStudio {
  constructor(ctx, p, tasks, info, claude, failedJobs) { Object.assign(this, { ctx, p, tasks, info, claude, failedJobs }); this.scenesCache = {}; }

  mount() {
    const { ctx } = this;
    if (!memo.task || !this.tasks.find((x) => x.id === memo.task)) memo.task = this.tasks[0] && this.tasks[0].id;
    this.taskSel = h('select.select', { 'aria-label': t('任務類型') }, this.tasks.map((x) => h('option', { value: x.id, selected: x.id === memo.task ? true : null }, x.label)));
    this.taskSel.addEventListener('change', () => { memo.task = this.taskSel.value; this.renderOptions(); });
    this.taskDesc = h('div.caption.muted');
    this.optsBox = h('div.col');
    this.out = h('textarea.textarea.mono', { rows: '18', 'aria-label': t('產生的提示詞'), spellcheck: 'false', style: { minHeight: '320px', fontSize: '12.5px' } });
    this.out.value = memo.text;
    this.out.addEventListener('input', () => { memo.text = this.out.value; this.chars.textContent = t('{n} 字', { n: this.out.value.length }); });
    this.chars = h('span.caption.muted.num', memo.text ? t('{n} 字', { n: memo.text.length }) : '');
    this.genBtn = btn(t('產生提示詞'), { kind: 'primary', icon: 'sparkle', onClick: () => this.generate() });
    this.claudeBox = h('div.col');
    this.runBox = h('div.col');
    this.wtBox = h('div.col');

    mount(ctx.content, h('div.page',
      h('div.grid2', { style: { gridTemplateColumns: 'minmax(300px, 380px) minmax(0, 1fr)', alignItems: 'start' } },
        h('section.panel.panel-body.col', h('div.headline', t('任務')), field(t('任務類型'), this.taskSel), this.taskDesc, this.optsBox, h('div.row', this.genBtn)),
        h('section.col',
          h('div.row', h('h2.title2.grow', t('提示詞')), this.chars, btn(t('複製'), { icon: 'copy', onClick: () => this.out.value ? copyText(this.out.value, t('提示詞')) : toast(t('請先產生提示詞'), 'warn') })),
          this.out,
          this.claudeBox)),
      this.runBox,
      h('section.section', h('div.section-head', h('h2.title2', t('Claude 工作樹（待審核的修改）')), btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => this.renderWorktrees() })), this.wtBox)));
    this.renderOptions();
    this.renderClaude();
    this.renderWorktrees();
    if (memo.runJobId) this.attachRun(memo.runJobId);
    ctx.cleanup(on('job', (j) => { if (j && j.id === memo.runJobId) this.updateRun(j); }));
    ctx.cleanup(on('joblog', (ev) => { if (ev && ev.jobId === memo.runJobId) this.appendLog(ev); }));
  }

  get task() { return this.tasks.find((x) => x.id === memo.task); }

  async scenesFor(locale, seqKey) {
    const k = `${locale}|${seqKey}`;
    if (this.scenesCache[k]) return this.scenesCache[k];
    const f = await call('narration_read', { projectId: this.p.id, locale });
    const seq = (f.sequences || []).find((s) => s.key === seqKey);
    return (this.scenesCache[k] = seq ? seq.scenes.map((s) => ({ id: s.id, title: s.title, n: s.lines.length })) : []);
  }

  renderOptions() {
    const task = this.task; const o = memo.options;
    this.taskDesc.textContent = task ? task.description || '' : '';
    const kids = [];
    const needs = new Set(task ? task.needs : []);
    const eps = this.info.episodes || [];
    const locSel = h('select.select', { 'aria-label': t('語系') }, ['zh-TW', 'zh-CN'].map((l) => h('option', { value: l, selected: (o.locale || 'zh-TW') === l ? true : null }, l)));
    locSel.addEventListener('change', () => { o.locale = locSel.value; this.renderOptions(); });
    kids.push(field(t('語系'), locSel));
    if (needs.has('seqKey') || needs.has('sceneId')) {
      const loc = o.locale || 'zh-TW';
      const seqs = eps.filter((e) => e.locale === loc);
      if (!o.seqKey || !seqs.find((e) => e.seqKey === o.seqKey)) o.seqKey = (seqs.find((e) => e.seqKey === 'ep01') || seqs[0] || {}).seqKey;
      const seqSel = h('select.select', { 'aria-label': t('序列') }, seqs.map((e) => h('option', { value: e.seqKey, selected: e.seqKey === o.seqKey ? true : null }, `${e.seqKey} — ${e.title}`)));
      seqSel.addEventListener('change', () => { o.seqKey = seqSel.value; o.sceneId = null; this.renderOptions(); });
      kids.push(field(t('序列'), seqs.length ? seqSel : h('div.caption.fail-text', t('此語系沒有序列'))));
    }
    if (needs.has('sceneId')) {
      const sceneSel = h('select.select', { 'aria-label': t('幕'), disabled: true }, h('option', t('載入中…')));
      kids.push(field(t('幕'), sceneSel));
      this.scenesFor(o.locale || 'zh-TW', o.seqKey).then((scenes) => {
        if (!o.sceneId || !scenes.find((s) => s.id === o.sceneId)) o.sceneId = scenes[0] && scenes[0].id;
        mount(sceneSel, scenes.map((s) => h('option', { value: s.id, selected: s.id === o.sceneId ? true : null }, `${s.id} ${s.title || ''}（${s.n}）`)));
        sceneSel.disabled = false;
      }).catch((e) => { mount(sceneSel, h('option', t('無法載入'))); toastError(e); });
      sceneSel.addEventListener('change', () => { o.sceneId = sceneSel.value; });
    }
    if (needs.has('jobId')) {
      const js = this.failedJobs;
      if (!o.jobId || !js.find((j) => j.id === o.jobId)) o.jobId = js[0] && js[0].id;
      const jobSel = h('select.select', { 'aria-label': t('工作') }, js.map((j) => h('option', { value: j.id, selected: j.id === o.jobId ? true : null }, `${j.label || j.kind} · ${j.status} · ${fmtTime(j.finishedAt || j.createdAt)}`)));
      jobSel.addEventListener('change', () => { o.jobId = jobSel.value; });
      kids.push(field(t('失敗的工作'), js.length ? jobSel : h('div.caption.muted', t('佇列裡沒有失敗或中斷的工作。'))));
    }
    if (needs.has('topic')) {
      const topic = h('input.input', { value: o.topic || '', placeholder: t('例如：顯示卡記憶體頻寬'), 'aria-label': t('主題') });
      topic.addEventListener('input', () => { o.topic = topic.value; });
      kids.push(field(t('主題'), topic));
    }
    const notes = h('textarea.textarea', { rows: '3', placeholder: t('補充說明（選填）'), 'aria-label': t('補充說明') }); notes.value = o.notes || '';
    notes.addEventListener('input', () => { o.notes = notes.value; });
    kids.push(field(t('補充說明'), notes));
    mount(this.optsBox, kids);
  }

  async generate() {
    const task = this.task; if (!task) return;
    const o = memo.options; const needs = task.needs || [];
    const options = { locale: o.locale || 'zh-TW' };
    for (const n of needs) if (o[n]) options[n] = o[n];
    if (o.notes) options.notes = o.notes;
    if (needs.includes('topic') && !o.topic) { toast(t('請輸入主題'), 'warn'); return; }
    if (needs.includes('jobId') && !o.jobId) { toast(t('沒有可分析的失敗工作'), 'warn'); return; }
    this.genBtn.disabled = true;
    try {
      const r = await call('prompt_build', { projectId: this.p.id, task: task.id, options });
      memo.text = r.text; this.out.value = r.text; this.chars.textContent = t('{n} 字', { n: r.chars ?? r.text.length });
      toast(t('已產生提示詞'), 'ok');
    } catch (e) { toastError(e, t('產生提示詞')); }
    finally { this.genBtn.disabled = false; }
  }

  renderClaude() {
    const c = this.claude;
    if (c && c.error) { mount(this.claudeBox, errorBox(c.error)); return; }
    if (!c.found) {
      mount(this.claudeBox, h('div.banner', icon('terminal'), h('div.grow', h('div', { style: { fontWeight: 600 } }, t('未偵測到 Claude Code CLI')),
        h('div.muted', t('安裝並登入 claude CLI 後，就能在隔離的 git 工作樹中執行提示詞。你仍可以複製提示詞貼到任何 AI 助理。'))),
        btn(t('重新偵測'), { small: true, onClick: async () => { try { this.claude = await call('claude_detect'); this.renderClaude(); } catch (e) { toastError(e); } } })));
      return;
    }
    const allow = { v: true };
    mount(this.claudeBox, h('div.panel.panel-body.col',
      h('div.row', icon('terminal'), h('div.grow', h('div.headline', 'Claude Code'), h('div.caption.muted.mono.ellipsis', `${c.version || ''} · ${c.path || ''}`))),
      h('div.caption.muted', t('會在 .studio\\worktrees 建立新的 git 工作樹與分支執行；完成後在下方檢視 diff，按「合併」才會進入主分支。')),
      h('div.row.wrap',
        toggle(t('允許修改檔案（Edit／Write）'), true, (v) => { allow.v = v; }),
        h('div.grow'),
        btn(t('安裝 Pikara Skill'), { small: true, onClick: () => this.installSkill() }),
        btn(t('以 Claude Code 執行'), { kind: 'primary', icon: 'play', onClick: () => this.run(allow.v) }))));
  }

  async installSkill(overwrite = false) {
    try {
      const r = await call('claude_install_skill', { projectId: this.p.id, overwrite });
      if (r.existed && !r.written) {
        const ok = await confirmSheet({ title: t('Skill 已存在'), text: t('要覆寫現有的 Skill 檔案嗎？'), detail: r.path, confirmLabel: t('覆寫') });
        if (ok) return this.installSkill(true);
        return;
      }
      toast(t('已寫入 Skill：{x}', { x: r.path }), 'ok');
    } catch (e) { toastError(e, 'Skill'); }
  }

  async run(allowEdits) {
    const prompt = this.out.value.trim();
    if (!prompt) { toast(t('請先產生或輸入提示詞'), 'warn'); return; }
    const ok = await confirmSheet({ title: t('以 Claude Code 執行？'), text: t('Claude 會在獨立的工作樹分支中讀取{e}專案檔案。可能產生 API 費用；不會自動合併。', { e: allowEdits ? t('與修改') : '' }), detail: prompt.slice(0, 600) + (prompt.length > 600 ? '…' : ''), confirmLabel: t('執行') });
    if (!ok) return;
    try {
      const job = await call('claude_run', { projectId: this.p.id, prompt, allowEdits });
      memo.runJobId = job.id; this.attachRun(job.id, job);
      toast(t('已加入佇列：{x}', { x: job.label || job.kind }), 'ok');
    } catch (e) { toastError(e, 'Claude'); }
  }

  async attachRun(jobId, job) {
    this.logEl = h('pre.log', { style: { maxHeight: '360px', minHeight: '160px' }, 'aria-live': 'off' });
    this.runHead = h('div.row');
    this.runDiff = h('div.col');
    this.lastEvId = 0;
    mount(this.runBox, h('section.section', h('div.section-head', h('h2.title2', t('Claude 執行輸出'))), h('div.panel.panel-body.col', this.runHead, this.logEl), this.runDiff));
    try {
      job = job || await call('job_get', { jobId });
      this.updateRun(job);
      const evs = await call('job_events', { jobId, limit: 2000 });
      evs.forEach((e) => this.appendLog(e));
    } catch (e) { mount(this.runHead, errorBox(e)); }
  }

  appendLog(ev) {
    if (!this.logEl || ev.id <= this.lastEvId) return;
    this.lastEvId = ev.id;
    const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 8;
    this.logEl.appendChild(h('div', { class: ev.level === 'error' ? 'l-error' : ev.level === 'warn' ? 'l-warn' : ev.stream === 'system' ? 'l-debug' : '' }, ev.line));
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  updateRun(j) {
    if (!this.runHead) return;
    const done = ['succeeded', 'failed', 'canceled', 'interrupted'].includes(j.status);
    mount(this.runHead, dot(j.status), h('span.headline', j.label || j.kind), tag(j.status, j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'fail' : 'info'),
      h('div.grow', done ? null : progress(j.progress > 0 ? j.progress : null)), j.progressText ? h('span.caption.muted', j.progressText) : null,
      done ? null : btn(t('取消'), { small: true, kind: 'destructive', onClick: () => call('job_cancel', { jobId: j.id }).then((x) => this.updateRun(x)).catch(toastError) }));
    if (done && this.finishedFor !== j.id) { this.finishedFor = j.id; this.renderWorktrees(j.id); }
  }

  async renderWorktrees(focusJobId) {
    mount(this.wtBox, loading(2));
    let wts;
    try { wts = await call('claude_worktrees', { projectId: this.p.id }); }
    catch (e) { mount(this.wtBox, errorBox(e, () => this.renderWorktrees())); return; }
    if (!wts.length) { mount(this.wtBox, h('div.panel', empty(t('沒有待審核的工作樹'), t('以 Claude Code 執行提示詞後，修改會出現在這裡。'), 'merge'))); return; }
    mount(this.wtBox, h('div.panel', h('div.list', wts.map((w) => {
      const diffBox = h('div.col', { hidden: true, style: { padding: '0 16px 16px' } });
      const row = h('div', h('div.list-row',
        dot(w.exists ? (w.commitsAhead ? 'ok' : 'idle') : 'fail'),
        h('div.main-text', h('div.t.mono', w.branch), h('div.d.mono', w.path)),
        h('span.caption.muted.nowrap', t('{c} 個 commit・{f} 個檔案', { c: w.commitsAhead, f: w.changedFiles })),
        btn(t('檢視 diff'), { small: true, onClick: () => this.showDiff(w, diffBox) }),
        btn(t('合併'), { small: true, kind: 'primary', icon: 'merge', disabled: !w.exists || !w.commitsAhead, onClick: () => this.merge(w) }),
        btn(t('捨棄'), { small: true, kind: 'destructive', onClick: () => this.discard(w) })), diffBox);
      if (focusJobId && w.jobId === focusJobId) setTimeout(() => this.showDiff(w, diffBox), 0);
      return row;
    }))));
  }

  async showDiff(w, box) {
    if (!box.hidden && box.dataset.loaded) { box.hidden = true; return; }
    box.hidden = false; mount(box, loading(3));
    try {
      const d = await call('claude_worktree_diff', { projectId: this.p.id, worktreeId: w.id });
      box.dataset.loaded = '1';
      mount(box,
        d.commits && d.commits.length ? h('div.caption.mono.muted', d.commits.map((c) => h('div', c))) : null,
        d.stat ? h('pre.code', { style: { maxHeight: '160px' } }, d.stat) : null,
        d.diff ? renderDiff(d.diff) : h('div.muted', t('沒有修改')),
        h('div.row', h('div.grow'), btn(t('捨棄'), { kind: 'destructive', onClick: () => this.discard(w) }), btn(t('合併到目前分支'), { kind: 'primary', icon: 'merge', disabled: !w.commitsAhead, onClick: () => this.merge(w) })));
    } catch (e) { mount(box, errorBox(e)); }
  }

  async merge(w) {
    const ok = await confirmSheet({ title: t('合併 Claude 的修改？'), text: t('會把分支 {b} 合併到專案目前的分支。合併前會檢查工作目錄。', { b: w.branch }), confirmLabel: t('合併') });
    if (!ok) return;
    try { const r = await call('claude_worktree_merge', { projectId: this.p.id, worktreeId: w.id }); toast(r.merged ? t('已合併') : t('未合併：{x}', { x: r.output }), r.merged ? 'ok' : 'warn'); this.renderWorktrees(); }
    catch (e) { toastError(e, t('合併')); }
  }

  async discard(w) {
    const ok = await confirmSheet({ title: t('捨棄這個工作樹？'), text: t('會刪除工作樹資料夾與分支 {b}，裡面的修改無法復原。', { b: w.branch }), detail: w.path, confirmLabel: t('捨棄'), destructive: true });
    if (!ok) return;
    try { const r = await call('claude_worktree_discard', { projectId: this.p.id, worktreeId: w.id }); toast(r.removed ? t('已捨棄') : r.output, r.removed ? 'ok' : 'warn'); this.renderWorktrees(); }
    catch (e) { toastError(e, t('捨棄')); }
  }
}

export function renderDiff(text) {
  const pre = h('pre.code.diff', { style: { maxHeight: '480px' } });
  const lines = String(text).split('\n');
  const max = 4000;
  for (const l of lines.slice(0, max)) {
    const cls = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
    pre.appendChild(cls ? h('span', { class: cls }, l) : document.createTextNode(l + '\n'));
  }
  if (lines.length > max) pre.appendChild(document.createTextNode(`\n… (${lines.length - max} more lines)`));
  return pre;
}
