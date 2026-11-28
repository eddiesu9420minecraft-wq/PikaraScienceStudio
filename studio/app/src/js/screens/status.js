// 製作狀態（v0.3.2）：所有影片的製作控制中心。
// 每部影片：封面、名稱、狀態、整體進度、目前步驟、11 個步驟各自的狀態與進度、已執行時間、預估剩餘時間
// （只有可靠數據時）、最新日誌、錯誤與失敗原因，以及依狀態提供的操作。
// 全部資料來自後端 auto_board（productions 表＋jobs 表＋工作樹的實際檔案），畫面只在後端事件或定時重新讀取時更新，
// 不用計時器模擬進度。
import { t } from '../i18n.js';
import { call, fileSrc, hasTauri } from '../api.js';
import { h, mount, btn, seg, progress, loading, errorBox, notReady, needProject, empty, toast, toastError, confirmSheet, sheet, fmtDur, fmtTime, field } from '../ui.js';
import { icon } from '../icons.js';
import { on, ensureAssets } from '../store.js';
import { pageHead, card, select, popupMenu } from '../v03/common.js';
import { LiveMonitor, activityView } from './automon.js';

const STATUS = {
  draft: ['尚未開始', 'idle'], queued: ['排隊中', 'waiting'], running: ['製作中', 'running'], waiting_agent: ['等待 Agent', 'waiting'],
  paused: ['已暫停', 'paused'], paused_limit: ['額度暫停', 'paused'], needs_merge: ['需要手動合併', 'paused'],
  succeeded: ['完成', 'done'], failed: ['失敗', 'failed'], canceled: ['已取消', 'failed'],
};
const STEP_STATE = { pending: '等待中', running: '執行中', done: '已完成', warned: '完成（有警告）', paused: '已暫停', failed: '失敗', canceled: '已取消', skipped: '略過' };
const STEP_NAMES = { research: '資料研究', script: '腳本生成', validate: '內容驗證', animate: '動畫生成', voice: '語音生成', subtitle: '字幕對齊', storyboard: '分鏡設計', mix: '音訊混合', render: '影片渲染', qa: '品質檢查', output: '成品輸出' };
const stepName = (s) => t(STEP_NAMES[s.id] || s.label);
const ACTIVE = ['queued', 'running', 'waiting_agent', 'paused', 'paused_limit'];
const FILTERS = [{ value: 'all', label: '全部' }, { value: 'active', label: '進行中' }, { value: 'done', label: '已完成' }, { value: 'problem', label: '失敗／取消' }];

export default {
  id: 'status', title: '製作狀態', icon: 'track',
  async render(ctx) {
    if (!hasTauri) return mount(ctx.content, h('div.page', notReady(['auto_board'])));
    if (!ctx.projectId) return mount(ctx.content, h('div.page', needProject()));
    mount(ctx.content, h('div.page', loading(6)));
    let list;
    try { list = await call('auto_board', { projectId: ctx.projectId }); } catch (e) { if (ctx.alive()) mount(ctx.content, h('div.page', errorBox(e, () => ctx.rerender()))); return; }
    if (!ctx.alive()) return;
    ensureAssets(ctx.projectId).catch(() => {});
    new StatusPage(ctx, list).mount();
  },
};

function pill(status) {
  const [label, kind] = STATUS[status] || [status, 'idle'];
  return h('span', { class: `st-pill ${kind}` }, t(label));
}

function cover(x, lg) {
  return h(`div.cover${lg ? '.lg' : ''}`, x.cover ? h('img', { src: `${fileSrc(x.cover)}`, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null,
    x.cover ? null : h('span.ep', x.episode.toUpperCase()));
}

class StatusPage {
  constructor(ctx, list) {
    this.ctx = ctx;
    this.list = list;
    this.filter = sessionStorage.getItem('status.filter') || 'all';
    this.sel = ctx.query.get('id') || sessionStorage.getItem('status.sel') || null;
    if (!this.list.some((x) => x.id === this.sel)) this.sel = (this.list.find((x) => ACTIVE.includes(x.status)) || this.list[0] || {}).id || null;
    this.pending = new Set(); // 正在呼叫後端的影片（防止重複點擊）
    this.monitor = null;
    this.refreshing = new Set();
  }

  mount() {
    this.ctx.toolbar(t('製作狀態'), '', [btn(t('新影片'), { kind: 'primary', icon: 'plus', onClick: () => this.ctx.go('create') })]);
    this.listEl = h('div.prod-list', { role: 'list', 'aria-label': t('影片') });
    this.detailEl = h('div.detail');
    this.filterEl = h('div.filter-row');
    this.layout = h('div.status-layout', h('div.col', { style: { gap: '12px' } }, this.filterEl, this.listEl), this.detailEl);
    mount(this.ctx.content, h('div.page.flow', pageHead(t('製作狀態'), t('所有影片的製作進度與控制。進度來自實際執行中的工作，不是估算的動畫。')), this.layout));
    this.paintAll();
    // 後端事件：製作狀態改變、工作進度、製作日誌
    this.ctx.cleanup(on('production', (p) => p && this.reload(p.id)));
    this.ctx.cleanup(on('pevent', (e) => e && e.id === this.sel && this.reload(e.id)));
    this.ctx.cleanup(on('job', (j) => { const x = j && this.list.find((y) => y.job && y.job.id === j.id); if (x) this.reload(x.id); }));
    // 定時重新讀取（後端狀態），涵蓋沒有事件的變化：檔案寫出、已執行時間
    const timer = setInterval(() => { if (!this.ctx.alive()) return clearInterval(timer); this.list.filter((x) => ACTIVE.includes(x.status)).forEach((x) => this.reload(x.id)); }, 4000);
    this.ctx.cleanup(() => clearInterval(timer));
    this.ctx.cleanup(() => { if (this.monitor) this.monitor.stop(); });
  }

  visible() {
    const f = this.filter;
    return this.list.filter((x) => f === 'all' || (f === 'active' && (ACTIVE.includes(x.status) || x.status === 'draft')) || (f === 'done' && x.status === 'succeeded') || (f === 'problem' && ['failed', 'canceled', 'needs_merge'].includes(x.status)));
  }

  paintAll() {
    const counts = { active: this.list.filter((x) => ACTIVE.includes(x.status)).length };
    mount(this.filterEl, seg(FILTERS.map((f) => ({ value: f.value, label: f.value === 'active' && counts.active ? `${t(f.label)} ${counts.active}` : t(f.label) })), this.filter,
      (v) => { this.filter = v; sessionStorage.setItem('status.filter', v); this.paintList(); }, { aria: t('篩選') }));
    this.paintList();
    this.paintDetail();
  }

  paintList() {
    const items = this.visible();
    if (!this.list.length) {
      mount(this.layout, h('div', { style: { gridColumn: '1 / -1' } }, card(null, empty(t('還沒有影片'), t('到「新影片」設定主題並開始製作，進度會顯示在這裡。'), 'film',
        btn(t('新影片'), { kind: 'primary', icon: 'plus', onClick: () => this.ctx.go('create') })))));
      return;
    }
    mount(this.listEl, items.length ? items.map((x) => this.item(x)) : h('div.caption.muted', { style: { padding: '12px' } }, t('沒有符合篩選條件的影片')));
  }

  item(x) {
    const cur = x.steps.find((s) => s.id === x.currentStep);
    const state = x.status === 'succeeded' ? t('已完成') : x.status === 'draft' ? t('尚未開始') : cur ? `${stepName(cur)}・${t(STEP_STATE[cur.status] || cur.status)}` : t((STATUS[x.status] || [x.status])[0]);
    return h('button.prod-item', { type: 'button', role: 'listitem', 'aria-current': String(x.id === this.sel), dataset: { id: x.id },
      onclick: () => { this.sel = x.id; sessionStorage.setItem('status.sel', x.id); history.replaceState(null, '', `#/status?id=${x.id}`); this.listEl.querySelectorAll('.prod-item').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === x.id))); this.paintDetail(); } },
    cover(x),
    h('div.info', h('div.tt', { title: x.title }, x.title),
      h('div.meta', pill(x.status), h('span', x.episode.toUpperCase()), x.sandbox ? h('span', 'Sandbox') : null),
      progress(x.progress, x.status === 'succeeded' ? 'ok' : ['failed', 'canceled'].includes(x.status) ? 'fail' : ''),
      h('div.meta', h('span.cur', state), h('span', { style: { marginLeft: 'auto' } }, `${Math.round(x.progress * 100)}%`))));
  }

  async reload(id) {
    if (this.refreshing.has(id)) return;
    this.refreshing.add(id);
    try {
      const [x] = await call('auto_board', { id });
      if (!this.ctx.alive()) return;
      const i = this.list.findIndex((y) => y.id === id);
      if (i >= 0) this.list[i] = x; else this.list.unshift(x);
      const old = this.listEl.querySelector(`.prod-item[data-id="${id}"]`);
      if (old) old.replaceWith(this.item(x)); else this.paintList();
      if (id === this.sel) this.paintDetail(true);
    } catch (e) {
      // 已刪除的影片
      if (String(e).includes('找不到') || String(e).includes('not found') || String(e).includes('QueryReturnedNoRows')) { this.list = this.list.filter((y) => y.id !== id); this.paintAll(); }
    } finally { this.refreshing.delete(id); }
  }

  // ---------------------------------------------------------------- detail
  paintDetail(soft) {
    const x = this.list.find((y) => y.id === this.sel);
    if (!x) { mount(this.detailEl, this.list.length ? card(null, empty(t('選擇一部影片'), t('左側清單選擇影片後，這裡會顯示製作進度與操作。'), 'track')) : null); return; }
    const keepLog = this.detailEl.querySelector('.logbox');
    const logAtBottom = keepLog ? keepLog.scrollTop + keepLog.clientHeight >= keepLog.scrollHeight - 20 : true;
    const monSlot = soft && this.monitor && this.monitor.prod.id === x.id ? this.detailEl.querySelector('[data-monitor]') : null;
    const elapsed = fmtDur((x.activeMs || 0) / 1000);
    const head = card(null, h('div.detail-head', { style: { padding: '0' } },
      cover(x, true),
      h('div.h',
        h('div.sub', pill(x.status), h('span', x.episode.toUpperCase()), x.sandbox ? h('span.tag', 'Sandbox') : null, h('span', t({ auto: '敘事：自動判斷', personified: '擬人化科普', plain: '一般旁白' }[x.narrative] || ''))),
        h('div.title', x.title),
        x.title !== x.topic ? h('div.caption.muted', x.topic) : null,
        h('div.big-progress', progress(x.progress, x.status === 'succeeded' ? 'ok' : ['failed', 'canceled'].includes(x.status) ? 'fail' : ''), h('span.pct', `${Math.round(x.progress * 100)}%`)),
        h('div.facts',
          h('div', h('b', x.currentStep ? stepName(x.steps.find((s) => s.id === x.currentStep) || {}) : x.status === 'succeeded' ? t('全部完成') : '—'), t('目前步驟')),
          h('div', h('b', elapsed), t('已執行')),
          x.etaSecs != null ? h('div', h('b', t('約 {d}', { d: fmtDur(x.etaSecs) })), t('目前工作剩餘')) : null,
          h('div', h('b', fmtTime(x.createdAt)), t('建立時間'))),
        this.actions(x))), { flush: false });
    const tracker = card(t('製作流程'), h('div.tracker', { role: 'list' }, x.steps.map((s, i) => this.stepEl(s, i))), { flush: true });
    const now = this.nowCard(x);
    const errs = x.errors && x.errors.length ? h('div.banner.fail', icon('alert'), h('div.grow.err-list', h('div', { style: { fontWeight: 600 } }, t('錯誤與失敗原因')), x.errors.map((e) => h('div.selectable', { style: { whiteSpace: 'pre-wrap' } }, e)))) : null;
    const warns = x.warnings && x.warnings.length ? h('div.banner.warn', icon('alert'), h('div.grow', h('div', { style: { fontWeight: 600 } }, t('{n} 項警告', { n: x.warnings.length })), x.warnings.map((w) => h('div.caption', w)))) : null;
    const pausing = x.pausing ? h('div.banner.warn', icon('pause'), h('div.grow', t('暫停中：目前的步驟（{s}）會先做完並保存，之後不會開始新的步驟。', { s: x.job ? x.job.label : '' }))) : null;
    const logs = card(t('最新日誌'), h('div.col', { style: { gap: '10px' } },
      h('div.logbox', x.events.length ? x.events.map((e) => h('div', { class: `l ${e.level}` }, h('span.ts', fmtClock(e.ts)), e.line)) : h('div.l', t('（尚無紀錄）'))),
      x.job && x.job.lastLine ? h('div.caption.muted.selectable', { style: { overflowWrap: 'anywhere' } }, `${t('工作輸出')}：${x.job.lastLine}`) : null),
    { actions: [btn(t('查看完整日誌'), { small: true, icon: 'terminal', onClick: () => this.fullLog(x) })] });
    const outs = x.outputs && x.outputs.length ? card(t('成品'), h('div.col', { style: { gap: '8px' } },
      h('div.outputs', x.outputs.map((f) => btn(f.split('/').pop(), { small: true, icon: /\.mp4$/.test(f) ? 'play' : 'external', title: f, onClick: () => call('open_path', { projectId: x.projectId, path: f, reveal: false }).catch((e) => toastError(e, t('開啟'))) }))),
      h('div.caption.muted', t('發布請自行到各平台手動上傳；Studio 不會自動上傳或發布。')))) : null;
    const monWrap = monSlot || h('div', { dataset: { monitor: '1' } });
    const startMon = () => {
      if (this.monitor && this.monitor.prod.id === x.id && document.body.contains(this.monitor.el)) return;
      if (this.monitor) this.monitor.stop();
      this.monitor = new LiveMonitor({ id: x.id, status: x.status }, x.projectId);
      this.monitor.mountInto(monWrap);
    };
    const mon = h('details.card.adv', { open: sessionStorage.getItem('status.mon') === '1' || null, ontoggle: (e) => { sessionStorage.setItem('status.mon', e.target.open ? '1' : '0'); if (e.target.open) startMon(); else if (this.monitor) { this.monitor.stop(); this.monitor = null; mount(monWrap); } } },
      h('summary', h('div.sec-head', h('div.grow', h('div.t', t('詳細監控')), h('div.d', t('AI 即時輸出與工具呼叫、研究來源、檔案變更、腳本、分鏡、配音試聽與動畫預覽'))), h('div.right', icon('chevron')))),
      h('div.sec-body', monWrap));
    mount(this.detailEl, head, pausing, errs, tracker, now, warns, logs, outs, mon);
    const lb = this.detailEl.querySelector('.logbox'); if (lb && logAtBottom) lb.scrollTop = lb.scrollHeight;
    // 詳細監控只在展開時讀取（它每 2 秒向後端讀取一次）
    if (monSlot) this.monitor.update({ id: x.id, status: x.status });
    else { if (this.monitor) { this.monitor.stop(); this.monitor = null; } if (mon.open) startMon(); }
  }

  stepEl(s, i) {
    const ic = s.status === 'done' ? icon('check') : s.status === 'warned' ? icon('alert') : s.status === 'failed' || s.status === 'canceled' ? icon('x') : s.status === 'paused' ? icon('pause') : String(i + 1);
    return h('div', { class: `tstep ${s.status}`, role: 'listitem', title: [stepName(s), t(STEP_STATE[s.status] || s.status), s.detail].filter(Boolean).join('\n'), dataset: { step: s.id } },
      h('span.ic', ic), h('span.nm', stepName(s)), h('span.ss', t(STEP_STATE[s.status] || s.status)),
      s.status === 'running' && s.progress != null ? progress(s.progress, 'mini') : null);
  }

  nowCard(x) {
    const cur = x.steps.find((s) => s.id === x.currentStep);
    if (!cur || !['running', 'paused'].includes(cur.status)) return null;
    const j = x.job;
    const live = j && ['queued', 'waiting_resource', 'running'].includes(j.status);
    return card(t('目前步驟'), h('div.col', { style: { gap: '10px' } },
      h('div.now',
        h('div', h('div.k', `${stepName(cur)}${x.attempt > 1 ? `・${t('第 {n} 次', { n: x.attempt })}` : ''}`), h('div.d', cur.detail || (j ? j.label : t(x.stageLabel)))),
        h('div.caption.muted', j ? (j.status === 'waiting_resource' ? t('等待 GPU／資源：{r}', { r: j.waitReason || '' }) : j.stepLabel ? t('工作步驟 {a}/{b}：{c}', { a: j.step + 1, b: j.steps, c: j.stepLabel }) : '') : ''),
        live && cur.progress != null ? progress(cur.progress) : live ? progress(null) : null),
      x.status === 'waiting_agent' ? h('div.caption.muted', t('外部 Agent 完成後按「Agent 已完成」，Studio 會接著檢查並繼續。')) : null,
      this.activity(x)));
  }

  activity(x) {
    // 同一個後端檢查（watchdog::activity）：最後輸出、檔案變動、是否可能卡住
    const slot = h('div');
    const a = this.act;
    if (a && a.id === x.id && Date.now() - a.ts < 10000) { mount(slot, activityView(a.data)); return slot; }
    call('auto_monitor', { id: x.id }).then((d) => { this.act = { id: x.id, ts: Date.now(), data: d && d.activity }; if (document.body.contains(slot)) mount(slot, activityView(d && d.activity)); }).catch(() => {});
    return slot;
  }

  // ---------------------------------------------------------------- actions
  actions(x) {
    const c = x.can || {};
    const busy = this.pending.has(x.id);
    const a = (label, iconName, fn, opts = {}) => btn(t(label), { small: true, icon: iconName, kind: opts.kind, disabled: busy || opts.disabled, why: opts.why, onClick: fn });
    const main = [];
    if (c.start) main.push(a('開始製作', 'play', () => this.control(x, 'start'), { kind: 'primary' }));
    if (c.resume) main.push(a(x.status === 'canceled' ? '從中斷處繼續' : '繼續製作', 'play', () => this.control(x, 'resume'), { kind: 'primary' }));
    if (c.retry) main.push(a(x.status === 'needs_merge' ? '重試合併' : '重試失敗階段', 'refresh', () => this.control(x, 'resume'), { kind: 'primary' }));
    if (c.agentDone) main.push(a('Agent 已完成', 'check', () => this.agentDone(x), { kind: 'primary' }));
    if (c.pause) main.push(a('暫停製作', 'pause', () => this.control(x, 'pause')));
    if (c.recover) main.push(a('恢復目前步驟', 'refresh', () => this.control(x, 'recover')));
    if (c.cancel) main.push(a('取消製作', 'stop', () => this.control(x, 'stop'), { kind: 'destructive' }));
    // 完成的影片：重新配音／重新渲染（在單集編輯進行）
    if (c.revoice) main.push(a('重新配音', 'mic', () => this.openEditor(x, 'voice')));
    if (c.rerender) main.push(a('重新渲染', 'rerender', () => this.openEditor(x, 'render')));
    const openDir = a('開啟輸出資料夾', 'folder', () => call('open_path', { projectId: x.projectId, path: x.videoDir, reveal: false }).catch((e) => toastError(e, t('開啟資料夾'))),
      { disabled: !x.videoDirExists, why: x.filesDeleted ? t('影片檔案已刪除') : t('影片資料夾還沒有建立') });
    // 其他操作（含刪除）收在「更多」選單；刪除任務與刪除影片檔案是兩個不同的操作，各自有確認對話框
    const moreBtn = btn(t('更多'), { small: true, icon: 'more', disabled: busy, onClick: (e) => popupMenu(e.currentTarget, [
      c.edit ? { icon: 'pen', label: t('編輯影片設定'), onClick: () => this.edit(x) } : null,
      { icon: 'terminal', label: t('查看完整日誌'), onClick: () => this.fullLog(x) },
      { icon: 'trash', label: t('刪除影片任務…'), onClick: () => this.deleteTask(x) },
      c.deleteFiles ? { icon: 'trash', label: t('刪除影片檔案…'), disabled: !x.videoDirExists, onClick: () => this.deleteFiles(x) } : null,
    ]) });
    return h('div.actions-bar', main, openDir, moreBtn);
  }

  async run(x, fn) {
    if (this.pending.has(x.id)) return null;
    this.pending.add(x.id);
    this.paintDetail(true);
    try { return await fn(); } catch (e) { toastError(e, t('操作失敗')); return null; } finally { this.pending.delete(x.id); if (this.list.some((y) => y.id === x.id)) await this.reload(x.id); }
  }

  async control(x, action) {
    const ask = {
      stop: { title: t('取消製作'), text: t('正在執行的工作會立即停止（結束相關程序，不會殘留占用 CPU／GPU 的背景程序）。已完成的步驟與中間產物保留在隔離工作樹，可以「從中斷處繼續」或刪除任務；專案本身不會有任何改變。'), confirmLabel: t('取消製作'), destructive: true },
      recover: { title: t('恢復目前步驟'), text: t('停止目前的工作（如果還在執行），從這個步驟重新開始。已完成的步驟、研究與劇本都會保留，AI 會先檢查已完成的檔案，只補完未完成的部分。'), confirmLabel: t('恢復') },
      pause: { title: t('暫停製作'), text: t('目前的步驟會先做完並保存（配音、渲染等工作不能在中途安全暫停），之後不會開始新的步驟。按「繼續製作」從下一步接續，已完成的步驟不會重做。'), confirmLabel: t('暫停') },
    }[action];
    if (ask && !(await confirmSheet(ask))) return;
    const r = await this.run(x, () => call('auto_control', { id: x.id, action }));
    if (r) toast(t({ start: '已開始製作', pause: '已暫停（目前步驟完成後停止）', resume: '已繼續製作', recover: '已從目前步驟恢復', stop: '已取消製作' }[action] || '完成'), 'ok');
  }

  async agentDone(x) {
    if (!(await confirmSheet({ title: t('Agent 已完成這一步？'), text: t('Studio 會接著檢查 Agent 的成果，沒通過時會產生修正任務。'), confirmLabel: t('繼續製作') }))) return;
    await this.run(x, () => call('agent_done', { id: x.id }));
  }

  openEditor(x, what) {
    const loc = x.language === 'zh-CN' ? 'zh-CN' : 'zh-TW';
    select(x.episode, loc);
    toast(what === 'voice' ? t('在「單集編輯」選擇要重新配音的句子') : t('在「單集編輯」選擇重新渲染的範圍'), 'info');
    this.ctx.go('editor/workspace');
  }

  edit(x) {
    if (x.can.editAll) { this.ctx.go(`create?edit=${x.id}`); return; }
    const c = x.config;
    const val = { maxAttempts: c.maxAttempts, maxMinutes: c.maxMinutes, maxTurns: c.maxTurns, thumbnail: c.thumbnail, publishInfo: c.publishInfo, visualReview: c.visualReview, pronunciationCheck: c.pronunciationCheck, youtube: c.youtube };
    const done = (sid) => x.steps.some((s) => s.id === sid && ['done', 'warned', 'running', 'failed'].includes(s.status));
    const num = (k, min, max) => { const el = h('input.input.num', { type: 'number', min, max, value: val[k], 'aria-label': k }); el.addEventListener('change', () => { val[k] = Math.max(min, Math.min(max, Number(el.value) || min)); el.value = val[k]; }); return el; };
    const sw = (k, label, locked) => h('label.toggle', { title: locked ? t('這一步已經執行過') : null }, h('input', { type: 'checkbox', role: 'switch', checked: val[k], disabled: locked || null, onchange: (e) => { val[k] = e.target.checked; } }), h('span.callout', label));
    sheet({
      title: t('編輯影片設定'),
      body: [h('div.caption.muted', t('製作已經開始：主題、內容與腳本不能再修改（會讓已完成的步驟失效）。可以調整重試、時間上限與尚未執行的輸出項目。')),
        h('div.fld-grid.three', field(t('每個階段最多嘗試'), num('maxAttempts', 1, 10)), field(t('總時間上限（分鐘）'), num('maxMinutes', 10, 1440)), field(t('AI 每次最多回合'), num('maxTurns', 10, 400))),
        h('div.col', { style: { gap: '10px' } }, sw('thumbnail', t('封面'), done('output') && c.thumbnail), sw('publishInfo', t('上架資訊'), done('output') && c.publishInfo), sw('visualReview', t('畫面 AI 審查'), done('storyboard')), sw('pronunciationCheck', t('發音檢查'), done('voice')))],
      actions: [{ label: t('取消') }, { label: t('儲存'), kind: 'primary', onClick: async () => { const r = await this.run(x, () => call('auto_update_config', { id: x.id, patch: val })); if (r) toast(t('已更新影片設定'), 'ok'); return !!r; } }],
    });
  }

  async fullLog(x) {
    let ev = [];
    try { ev = await call('auto_events', { id: x.id, afterId: 0, limit: 5000 }); } catch (e) { toastError(e, t('讀取日誌')); return; }
    const box = h('div.logbox.full', ev.map((e) => h('div', { class: `l ${e.level}` }, h('span.ts', `${fmtTime(new Date(e.ts).toISOString())}`), `[${e.stage}] ${e.line}`)));
    sheet({ title: t('完整日誌：{ep}', { ep: x.episode.toUpperCase() }), wide: true,
      body: [h('div.caption.muted', t('{n} 筆製作紀錄。每個工作的完整輸出在「任務佇列」。', { n: ev.length })), box],
      actions: [{ label: t('前往任務佇列'), onClick: () => { if (x.job) sessionStorage.setItem('queue.select', x.job.id); this.ctx.go('queue/jobs'); } }, { label: t('關閉'), kind: 'primary' }] });
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 0);
  }

  async deleteTask(x) {
    const active = ACTIVE.includes(x.status);
    const ok = await confirmSheet({
      title: t('刪除影片任務'),
      text: t('只刪除這部影片的製作紀錄。') + (active ? t('製作會先停止（結束相關程序）。') : '') + (x.worktree ? t('隔離工作樹與分支也會刪除，其中尚未合併的中間檔（旁白、程式、配音、渲染片段）會消失。') : '') + t('專案中已交付的影片、配音、字幕與素材不受影響。'),
      detail: [`${x.episode.toUpperCase()}　${x.title}`, `${t('狀態')}：${t((STATUS[x.status] || [x.status])[0])}`, x.worktree ? `${t('工作樹')}：.studio/worktrees/${x.worktree}` : null].filter(Boolean).join('\n'),
      confirmLabel: t('刪除任務'), destructive: true,
    });
    if (!ok) return;
    this.pending.add(x.id);
    try {
      await call('auto_control', { id: x.id, action: 'delete_task' });
      toast(t('已刪除任務 {ep}', { ep: x.episode.toUpperCase() }), 'ok');
      this.list = this.list.filter((y) => y.id !== x.id);
      if (this.sel === x.id) this.sel = (this.list[0] || {}).id || null;
      this.paintAll();
    } catch (e) { toastError(e, t('刪除任務')); } finally { this.pending.delete(x.id); }
  }

  async deleteFiles(x) {
    const ok = await confirmSheet({
      title: t('刪除影片檔案'),
      text: t('把這部影片的資料夾（成品影片、配音、字幕、封面、素材）移到專案的 .studio/trash 資料夾，可以再手動搬回。製作紀錄保留；已合併到專案的旁白與動畫程式不會刪除。'),
      detail: `${x.videoDir}`,
      confirmLabel: t('刪除影片檔案'), destructive: true,
    });
    if (!ok) return;
    const r = await this.run(x, () => call('auto_control', { id: x.id, action: 'delete_files' }));
    if (r) toast(t('已移到 {p}', { p: r.moved }), 'ok');
  }
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
