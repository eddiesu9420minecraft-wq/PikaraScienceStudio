// 5. Queue — live jobs, progress, heartbeat, logs, cancel/retry, unattended mode, recovery indicator.
import { t } from '../i18n.js';
import { call, hasTauri } from '../api.js';
import { h, mount, btn, seg, empty, loading, errorBox, notReady, toast, toastError, confirmSheet, tag, toggle, dot, progress, fmtAgo, fmtTime, toMs, copyText, field } from '../ui.js';
import { icon } from '../icons.js';
import { store, on, currentProject } from '../store.js';

const ui = { filter: 'all', scope: 'project', selected: null, level: 'all' };
const ACTIVE = ['queued', 'waiting_resource', 'running'];
const FAILED = ['failed', 'canceled', 'interrupted'];

export default {
  id: 'queue', title: '佇列', icon: 'queue',
  async render(ctx) {
    if (!hasTauri) { mount(ctx.content, h('div.page', notReady(['job_list', 'queue_status', 'job_events']))); return; }
    const pre = sessionStorage.getItem('queue.select'); if (pre) { ui.selected = pre; sessionStorage.removeItem('queue.select'); }
    new QueueView(ctx).mount();
  },
};

class QueueView {
  constructor(ctx) { this.ctx = ctx; this.jobs = new Map(); this.rowEls = new Map(); this.lastEvId = 0; }

  mount() {
    const { ctx } = this;
    const p = currentProject();
    const filters = seg([
      { value: 'all', label: t('全部') }, { value: 'active', label: t('執行中／等待') }, { value: 'failed', label: t('失敗') }, { value: 'done', label: t('完成') },
    ], ui.filter, (v) => { ui.filter = v; this.paintList(); }, { aria: t('篩選') });
    const scope = seg([{ value: 'project', label: t('目前專案'), disabled: !p }, { value: 'all', label: t('全部專案') }], p ? ui.scope : 'all', (v) => { ui.scope = v; this.load(); }, { aria: t('範圍') });
    ctx.toolbar(t('佇列'), '', [scope, filters, btn('', { icon: 'refresh', aria: t('重新整理'), onClick: () => this.load() })]);

    this.statusBox = h('div');
    this.listBox = h('div.panel', { style: { overflow: 'auto', minHeight: '0' } });
    this.logPanel = h('div.panel', { style: { display: 'flex', flexDirection: 'column', minHeight: '0' } });
    this.unattended = h('div');
    mount(ctx.content, h('div.page.fill', { style: { gap: '16px' } },
      this.statusBox,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 6fr)', gap: '16px', flex: '1', minHeight: '0' } },
        this.listBox, this.logPanel),
      this.unattended));
    this.paintStatus(store.queue);
    this.renderUnattended();
    this.load();
    this.renderLog();

    ctx.cleanup(on('job', (j) => this.onJob(j)));
    ctx.cleanup(on('queue', (q) => this.paintStatus(q)));
    ctx.cleanup(on('joblog', (ev) => { if (ev && ev.jobId === ui.selected) this.appendLog(ev); }));
    const tick = setInterval(() => this.tickAges(), 1000);
    const poll = setInterval(() => this.load(true), 15000);
    ctx.cleanup(() => { clearInterval(tick); clearInterval(poll); });
  }

  async load(quiet) {
    if (!quiet) mount(this.listBox, loading(4));
    const p = currentProject();
    const args = { limit: 200 };
    if (ui.scope === 'project' && p) args.projectId = p.id;
    try {
      const list = await call('job_list', args);
      this.jobs = new Map(list.map((j) => [j.id, j]));
      this.paintList();
      if (!quiet) { try { this.paintStatus(store.queue = await call('queue_status')); } catch {} }
    } catch (e) { if (!quiet) mount(this.listBox, errorBox(e, () => this.load())); }
  }

  visible(j) {
    if (ui.filter === 'active') return ACTIVE.includes(j.status);
    if (ui.filter === 'failed') return FAILED.includes(j.status);
    if (ui.filter === 'done') return j.status === 'succeeded';
    return true;
  }

  paintList() {
    this.rowEls.clear();
    const jobs = [...this.jobs.values()].filter((j) => this.visible(j)).sort((a, b) => (rank(a) - rank(b)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!jobs.length) { mount(this.listBox, empty(t('沒有工作'), ui.filter === 'all' ? t('在「單集編輯」重新配音、重新渲染，或在「專案」開始新影片後，工作會出現在這裡。') : t('這個篩選條件下沒有工作。'), 'queue')); return; }
    const list = h('div.list', { role: 'listbox', 'aria-label': t('工作') });
    for (const j of jobs) { const el = this.jobRow(j); this.rowEls.set(j.id, el); list.appendChild(el); }
    mount(this.listBox, list);
  }

  jobRow(j) {
    const running = j.status === 'running';
    const el = h('div.job', { role: 'option', tabindex: '0', 'aria-selected': String(ui.selected === j.id), dataset: { id: j.id } });
    const steps = j.steps && j.steps.length > 1 ? t('步驟 {i}/{n}：{s}', { i: Math.min(j.step + 1, j.steps.length), n: j.steps.length, s: j.steps[Math.min(j.step, j.steps.length - 1)] || '' }) : null;
    const recovered = j.status === 'interrupted' || (j.attempt > 0 && ACTIVE.includes(j.status));
    const actions = h('div.row.gap2',
      j.status === 'running' && !j.paused ? btn(t('暫停'), { small: true, onClick: (e) => { e.stopPropagation(); this.pause(j); } }) : null,
      j.status === 'running' && j.paused ? btn(t('繼續'), { small: true, kind: 'primary', onClick: (e) => { e.stopPropagation(); this.resume(j); } }) : null,
      ACTIVE.includes(j.status) ? btn(t('取消'), { small: true, kind: 'destructive', onClick: (e) => { e.stopPropagation(); this.cancel(j); } }) : null,
      FAILED.includes(j.status) ? btn(t('重試'), { small: true, icon: 'refresh', onClick: (e) => { e.stopPropagation(); this.retry(j); } }) : null,
      j.status === 'failed' ? btn(t('交給 Claude 分析'), { small: true, onClick: (e) => { e.stopPropagation(); this.analyse(j); } }) : null,
      !running ? btn('', { small: true, icon: 'trash', aria: t('移除'), onClick: (e) => { e.stopPropagation(); this.remove(j); } }) : null);
    mount(el,
      h('div.head', dot(j.status), h('span.kind.ellipsis', j.label || j.kind), statusTag(j.status),
        recovered ? h('span.tag.warn', { title: t('Studio 重新啟動時發現這個工作中斷，已自動重新排隊；已完成的部分會跳過。') }, t('已從中斷恢復')) : null,
        h('div.grow'), h('span.caption.muted.num.nowrap', fmtTime(j.createdAt))),
      running || j.status === 'queued' || j.status === 'waiting_resource'
        ? h('div.row', h('div.grow', progress(running ? (j.progress > 0 ? j.progress : null) : 0)), h('span.caption.num.nowrap', running && j.progress > 0 ? `${Math.round(j.progress * 100)}%` : ''))
        : null,
      h('div.meta',
        h('span.mono', j.kind), steps ? h('span', steps) : null, j.progressText ? h('span.ellipsis', j.progressText) : null,
        running ? h('span', { class: 'hb', dataset: { hb: j.heartbeatAt || '' } }, heartbeat(j)) : null,
        j.attempt > 0 ? h('span', t('第 {n} 次嘗試', { n: j.attempt + 1 })) : null,
        j.pid ? h('span.mono', `PID ${j.pid}`) : null,
        j.exitCode != null ? h('span.mono', `exit ${j.exitCode}`) : null),
      j.waitReason ? h('div.caption.warn-text', t('等待：{x}', { x: j.waitReason })) : null,
      j.error ? h('div.caption.fail-text.selectable', { style: { overflowWrap: 'anywhere' } }, j.error) : null,
      actions);
    const select = () => { if (ui.selected === j.id) return; ui.selected = j.id; this.rowEls.forEach((r, id) => r.setAttribute('aria-selected', String(id === j.id))); this.renderLog(); };
    el.addEventListener('click', select);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const sib = e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling; if (sib) sib.focus(); }
    });
    return el;
  }

  onJob(j) {
    if (!j) return;
    const p = currentProject();
    if (ui.scope === 'project' && p && j.projectId !== p.id) return;
    const isNew = !this.jobs.has(j.id);
    this.jobs.set(j.id, j);
    const old = this.rowEls.get(j.id);
    if (isNew || !old || old.isConnected === false) { this.paintList(); }
    else if (!this.visible(j)) { old.remove(); this.rowEls.delete(j.id); }
    else { const nu = this.jobRow(j); const focused = old.contains(document.activeElement); old.replaceWith(nu); this.rowEls.set(j.id, nu); if (focused) nu.focus(); }
    if (j.id === ui.selected) this.paintLogHead(j);
  }

  tickAges() {
    this.listBox.querySelectorAll('.hb').forEach((el) => { const j = this.jobs.get(el.closest('.job').dataset.id); if (j) el.textContent = heartbeat(j); });
  }

  paintStatus(q) {
    if (!this.statusBox) return;
    if (!q) { mount(this.statusBox); return; }
    const ext = q.external || {};
    mount(this.statusBox, h('div.panel', h('div.row.wrap', { style: { padding: '12px 16px', gap: '24px' } },
      h('div.row.gap2', dot(q.enabled ? 'ok' : 'warn'), h('span', q.enabled ? t('佇列運作中') : t('佇列已暫停'))),
      h('span.callout', t('執行中 {r}・等待 {q}', { r: (q.running || []).length, q: q.queued || 0 })),
      h('span.callout', { title: t('GPU 工作只在時段內開始') }, q.inWindow ? t('在排程時段內') : h('span.warn-text', t('不在 GPU 時段內'))),
      h('span.callout', t('GPU 租約：{x}', { x: q.gpuHolder ? (this.jobs.get(q.gpuHolder)?.label || String(q.gpuHolder).slice(0, 8)) : t('空閒') })),
      h('span.callout', { class: ext.busy ? 'warn-text' : '' , title: (ext.reasons || []).join('\n') || null }, ext.busy ? t('外部 GPU 使用中{v}', { v: ext.vramUsedMiB != null ? `（${ext.vramUsedMiB} MiB）` : '' }) : t('外部 GPU：無')),
      q.keepAwake ? h('span.callout.muted', t('防止睡眠：開')) : null)));
  }

  async renderUnattended() {
    let s;
    try { s = await call('settings_get'); } catch (e) { mount(this.unattended, errorBox(e)); return; }
    const save = async (patch) => {
      try { await call('settings_set', { settings: patch }); toast(t('已儲存設定'), 'ok'); try { this.paintStatus(store.queue = await call('queue_status')); } catch {} }
      catch (e) { toastError(e, t('設定')); }
    };
    const ws = h('input.input', { type: 'time', value: s.windowStart || '', 'aria-label': t('時段開始'), style: { width: '120px' } });
    const we = h('input.input', { type: 'time', value: s.windowEnd || '', 'aria-label': t('時段結束'), style: { width: '120px' } });
    const winOn = { v: !!(s.windowStart && s.windowEnd) };
    const applyWin = () => save(winOn.v ? { windowStart: ws.value || null, windowEnd: we.value || null } : { windowStart: null, windowEnd: null });
    ws.disabled = we.disabled = !winOn.v;
    ws.addEventListener('change', applyWin); we.addEventListener('change', applyWin);
    // 渲染效能模式：只是起點，render.mjs 每段依實測 VRAM／GPU／CPU／RAM／fps 調整並行數
    const perf = h('select.input', { 'aria-label': t('渲染效能模式'), style: { width: '170px' } },
      ...[['eco', t('省電（起始並行 1）')], ['balanced', t('平衡（起始並行 2，預設）')], ['performance', t('效能（起始並行 3）')]]
        .map(([v, l]) => h('option', { value: v, selected: (s.perfMode || 'balanced') === v ? true : null }, l)));
    perf.addEventListener('change', () => save({ perfMode: perf.value, renderStartConcurrency: { eco: 1, balanced: 2, performance: 3 }[perf.value] }));
    const perfSelect = h('div.row.gap2', { title: t('起始值與上限；實際並行數依每段實測自動調整，調整原因記錄在渲染報告') }, h('span', t('渲染效能')), perf);
    // 旁白語速：時間軸階段對配音「複本」做保留音高的伸縮；原始配音檔不變。改了之後需重建時間軸／混音／渲染才生效
    const curTempo = [0.9, 1.0, 1.1, 1.2].reduce((a, b) => (Math.abs(b - (s.voiceTempo || 1)) < Math.abs(a - (s.voiceTempo || 1)) ? b : a), 1.0);
    const tempo = h('select.input', { 'aria-label': t('旁白語速'), style: { width: '150px' } },
      ...[[0.9, t('慢速 0.90×')], [1.0, t('正常 1.00×（預設）')], [1.1, t('稍快 1.10×')], [1.2, t('快速 1.20×')]]
        .map(([v, l]) => h('option', { value: String(v), selected: curTempo === v ? true : null }, l)));
    tempo.addEventListener('change', () => save({ voiceTempo: Number(tempo.value) }));
    const tempoSelect = h('div.row.gap2', { title: t('相對於該語言的正常語速；保留音高，不修改原始配音檔。下次建立時間軸時生效') }, h('span', t('旁白語速')), tempo);
    mount(this.unattended, h('div.panel', h('div.row.wrap', { style: { padding: '12px 16px', gap: '24px' } },
      h('span.headline', t('無人值守')),
      toggle(t('自動執行佇列'), s.queueEnabled, (v) => save({ queueEnabled: v })),
      toggle(t('執行時防止睡眠'), s.keepAwake, (v) => save({ keepAwake: v })),
      h('div.row.gap2', toggle(t('GPU 只在時段內'), winOn.v, (v) => { winOn.v = v; ws.disabled = we.disabled = !v; if (v && (!ws.value || !we.value)) return; applyWin(); }), ws, h('span.muted', '–'), we),
      h('span.caption.muted', t('同時 CPU 工作數：{n}', { n: s.maxCpuJobs })),
      btn(t('渲染效能與旁白語速…'), { small: true, kind: 'plain', onClick: () => { location.hash = '#/settings'; } }))));
  }

  // ---------- log viewer ----------
  async renderLog() {
    const j = ui.selected && this.jobs.get(ui.selected);
    this.lastEvId = 0;
    if (!ui.selected) { mount(this.logPanel, empty(t('選取工作以查看 log'), t('log 會即時更新。'), 'terminal')); return; }
    this.logHead = h('div.panel-head');
    this.logEl = h('pre.log', { style: { flex: '1', margin: '0', border: '0', borderRadius: '0 0 10px 10px', minHeight: '200px' }, tabindex: '0', 'aria-label': t('工作 log') });
    mount(this.logPanel, this.logHead, this.logEl);
    let job = j;
    try { if (!job) job = await call('job_get', { jobId: ui.selected }); } catch (e) { mount(this.logPanel, errorBox(e)); return; }
    this.paintLogHead(job);
    try {
      let after = 0; let total = 0;
      for (let i = 0; i < 20; i++) { // page through (≤ 20k lines)
        const evs = await call('job_events', { jobId: job.id, afterId: after || undefined, limit: 1000 });
        evs.forEach((e) => this.appendLog(e, true));
        total += evs.length;
        if (evs.length < 1000) break;
        after = evs[evs.length - 1].id;
      }
      if (!total) this.logEl.appendChild(h('div.l-debug', t('（還沒有輸出）')));
      this.logEl.scrollTop = this.logEl.scrollHeight;
    } catch (e) { this.logEl.appendChild(h('div.l-error', String(e.message || e))); }
  }

  paintLogHead(j) {
    if (!this.logHead) return;
    const levels = seg([{ value: 'all', label: t('全部') }, { value: 'warn', label: t('警告以上') }, { value: 'error', label: t('錯誤') }], ui.level, (v) => { ui.level = v; this.applyLevel(); }, { aria: t('log 等級') });
    mount(this.logHead, dot(j.status), h('div.grow', h('div.headline.ellipsis', j.label || j.kind), h('div.caption.muted.mono.ellipsis', j.logPath || j.id)),
      levels, btn('', { small: true, icon: 'copy', aria: t('複製 log'), onClick: () => copyText(this.logEl.innerText, 'log') }));
  }

  appendLog(ev, bulk) {
    if (!this.logEl || ev.id <= this.lastEvId) return;
    this.lastEvId = ev.id;
    const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 12;
    const d = new Date(ev.ts);
    const line = h('div', { class: `l-${ev.level === 'info' && ev.stream === 'system' ? 'debug' : ev.level}`, dataset: { level: ev.level } },
      h('span.ts', `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} `), ev.line);
    if (!levelOk(ev.level)) line.hidden = true;
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 20000) this.logEl.firstElementChild.remove();
    if (!bulk && atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }
  applyLevel() { if (this.logEl) this.logEl.querySelectorAll('div[data-level]').forEach((d) => { d.hidden = !levelOk(d.dataset.level); }); }

  // ---------- actions ----------
  async cancel(j) {
    const ok = await confirmSheet({ title: t('取消工作？'), text: t('會結束「{x}」的整個程序樹。已完成並驗證的檔案會保留。', { x: j.label || j.kind }), confirmLabel: t('取消工作'), destructive: true });
    if (!ok) return;
    try { this.onJob(await call('job_cancel', { jobId: j.id })); toast(t('已取消'), 'ok'); } catch (e) { toastError(e, t('取消')); }
  }
  async pause(j) {
    try { await call('job_pause', { jobId: j.id }); this.onJob(await call('job_get', { jobId: j.id })); toast(t('已暫停：程序保留在記憶體中，按「繼續」從暫停處接著做'), 'ok'); } catch (e) { toastError(e, t('暫停')); }
  }
  async resume(j) {
    try { await call('job_resume', { jobId: j.id }); this.onJob(await call('job_get', { jobId: j.id })); toast(t('已繼續'), 'ok'); } catch (e) { toastError(e, t('繼續')); }
  }
  async retry(j) { try { this.onJob(await call('job_retry', { jobId: j.id })); toast(t('已重新排隊'), 'ok'); } catch (e) { toastError(e, t('重試')); } }
  async remove(j) {
    const ok = await confirmSheet({ title: t('移除工作紀錄？'), text: t('只會從佇列刪除這筆紀錄與 log，不會刪除任何輸出檔案。'), confirmLabel: t('移除'), destructive: true });
    if (!ok) return;
    try { await call('job_remove', { jobId: j.id }); this.jobs.delete(j.id); if (ui.selected === j.id) { ui.selected = null; this.renderLog(); } this.paintList(); } catch (e) { toastError(e, t('移除')); }
  }
  async analyse(j) {
    const ok = await confirmSheet({ title: t('交給 Claude 分析？'), text: t('會把失敗摘要、log 結尾與最新 QA 報告交給 Claude Code，在獨立工作樹中執行；不會自動合併。可能產生 API 費用。'), confirmLabel: t('開始分析') });
    if (!ok) return;
    try { const nj = await call('job_analyse_with_claude', { jobId: j.id }); this.onJob(nj); toast(t('已加入佇列：{x}', { x: nj.label || nj.kind }), 'ok'); } catch (e) { toastError(e, 'Claude'); }
  }
}

function levelOk(l) { return ui.level === 'all' || (ui.level === 'warn' ? l === 'warn' || l === 'error' : l === 'error'); }
function rank(j) { return j.status === 'running' ? 0 : j.status === 'waiting_resource' ? 1 : j.status === 'queued' ? 2 : 3; }
function heartbeat(j) {
  const ms = toMs(j.heartbeatAt);
  if (ms == null) return t('心跳：—');
  const s = Math.round((Date.now() - ms) / 1000);
  return s > 20 ? `⚠ ${t('心跳 {n} 秒前', { n: s })}` : t('心跳 {n} 秒前', { n: Math.max(0, s) });
}
const STATUS_LABEL = { queued: '排隊中', waiting_resource: '等待資源', running: '執行中', succeeded: '完成', failed: '失敗', canceled: '已取消', interrupted: '中斷' };
export function statusTag(s) {
  const k = { succeeded: 'ok', failed: 'fail', canceled: '', interrupted: 'warn', waiting_resource: 'warn', running: 'info', queued: '' }[s] ?? '';
  return tag(t(STATUS_LABEL[s] || s), k);
}
